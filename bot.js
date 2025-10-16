import 'dotenv/config';
import { Telegraf } from 'telegraf';

const botToken = process.env.BOT_TOKEN;
const ownerTelegramId = Number(process.env.OWNER_TELEGRAM_ID);
if (!botToken || !ownerTelegramId) {
  console.error('Missing BOT_TOKEN or OWNER_TELEGRAM_ID in .env');
  process.exit(1);
}

let useEns = false;
let publicClient = null;

// Optional ENS resolution via viem
if (process.env.WEB3_PROVIDER_URL) {
  try {
    const { createPublicClient, http } = await import('viem');
    const { mainnet } = await import('viem/chains');
    publicClient = createPublicClient({
      chain: mainnet,
      transport: http(process.env.WEB3_PROVIDER_URL)
    });
    useEns = true;
  } catch (e) {
    console.warn('ENS disabled (viem not available / misconfigured). Proceeding without resolution.');
  }
}

// --- Config / regex ---
const ethRegex = /\b0x[a-fA-F0-9]{40}\b/g;
const ensRegex = /\b[a-z0-9-]{1,63}\.eth\b/gi;

// --- In-memory store ---
// chatId -> { watching: boolean, ethSet: Set<string>, ensMap: Map<ensName, resolvedAddr|null> }
const memoryStore = new Map();

function ensureChat(chatId) {
  if (!memoryStore.has(chatId)) {
    memoryStore.set(chatId, {
      watching: false,
      ethSet: new Set(),
      ensMap: new Map()
    });
  }
  return memoryStore.get(chatId);
}

function ownerOnly(ctx) {
  return ctx.from && ctx.from.id === ownerTelegramId;
}

async function resolveEnsOnceCached(chatState, ensName) {
  const key = ensName.toLowerCase();
  if (!chatState.ensMap.has(key)) {
    let resolved = null;
    if (useEns && publicClient) {
      try {
        resolved = await publicClient.getEnsAddress({ name: key });
      } catch (_) {
        resolved = null;
      }
    }
    chatState.ensMap.set(key, resolved);
  }
  return chatState.ensMap.get(key);
}

// --- Bot setup ---
const bot = new Telegraf(botToken);

// /whoami (DM or anywhere): returns the caller’s Telegram ID
bot.command('whoami', async (ctx) => {
  await ctx.reply(`Your Telegram ID: ${ctx.from?.id ?? 'unknown'}`);
});

// /watch (owner-only): start collecting in this chat
bot.command('watch', async (ctx) => {
  if (!ownerOnly(ctx)) return;
  const chatId = ctx.chat.id;
  const chatState = ensureChat(chatId);
  chatState.watching = true;
  await ctx.reply('Watching this chat. I will collect ETH addresses and ENS names from messages going forward.');
});

// /stop (owner-only): stop collecting in this chat
bot.command('stop', async (ctx) => {
  if (!ownerOnly(ctx)) return;
  const chatId = ctx.chat.id;
  const chatState = ensureChat(chatId);
  chatState.watching = false;
  await ctx.reply('Stopped watching this chat.');
});

// /status (owner-only): show counts so far
bot.command('status', async (ctx) => {
  if (!ownerOnly(ctx)) return;
  const chatId = ctx.chat.id;
  const chatState = ensureChat(chatId);
  const ethCount = chatState.ethSet.size;
  const ensCount = chatState.ensMap.size;
  await ctx.reply(
    `Watched: ${chatState.watching}\nCollected: ${ethCount + ensCount} (ETH: ${ethCount}, ENS: ${ensCount})`
  );
});

// /wrapup (owner-only): DM owner the list as a .txt
bot.command('wrapup', async (ctx) => {
  if (!ownerOnly(ctx)) return;
  const chatId = ctx.chat.id;
  const chatState = ensureChat(chatId);

  // build lines: ETH -> 0x..., ENS -> "name.eth 0x..." if resolved else "name.eth"
  const lines = [];

  // ETH
  for (const addr of Array.from(chatState.ethSet).sort((a, b) => a.localeCompare(b))) {
    lines.push(addr);
  }
  // ENS
  // ensure every ENS has been at least attempted to resolve once (in case some were seen in the last message)
  for (const [name, maybeResolved] of chatState.ensMap.entries()) {
    if (maybeResolved) lines.push(`${name} ${maybeResolved}`);
    else lines.push(name);
  }
  lines.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const content = lines.length ? lines.join('\n') : `(Chat ${chatId}) No ENS/ETH collected.`;
  const buffer = Buffer.from(content, 'utf8');
  const fileName = `addresses_${chatId}.txt`;

  try {
    await ctx.telegram.sendDocument(ownerTelegramId, { source: buffer, filename: fileName }, { caption: `Collected from chat ${chatId}.` });
    await ctx.reply('Sent you a DM with the results.');
  } catch (err) {
    await ctx.reply('Failed to DM results. (Is the bot allowed to message you? Send /start to the bot in DM once.)');
  }
});

// --- Collector (messages & channel posts) ---
async function handleText(ctx, text) {
  const chatId = ctx.chat.id;
  const chatState = ensureChat(chatId);
  if (!chatState.watching) return;

  // ETH addresses
  const ethMatches = text.match(ethRegex) || [];
  for (const m of ethMatches) chatState.ethSet.add(m.toLowerCase());

  // ENS names
  const ensMatches = text.match(ensRegex) || [];
  for (const raw of ensMatches) {
    const ensName = raw.toLowerCase();
    // cache and optionally resolve
    if (!chatState.ensMap.has(ensName)) {
      // fire-and-forget resolve (no await to keep message handler snappy)
      chatState.ensMap.set(ensName, null);
      (async () => {
        if (useEns && publicClient) {
          try {
            const resolved = await publicClient.getEnsAddress({ name: ensName });
            if (resolved) chatState.ensMap.set(ensName, resolved);
          } catch (_) { /* ignore */ }
        }
      })();
    }
  }
}

// group/supergroup/private messages
bot.on('text', async (ctx) => {
  if (!ctx.message?.text) return;
  await handleText(ctx, ctx.message.text);
});

// channel posts
bot.on('channel_post', async (ctx) => {
  if (!ctx.channelPost?.text) return;
  await handleText(ctx, ctx.channelPost.text);
});

bot.launch().then(() => {
  console.log('Bot is up. Remember: for groups disable privacy mode; for channels make the bot an admin.');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
