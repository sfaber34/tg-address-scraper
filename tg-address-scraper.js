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
let getAddress = null; // For checksumming addresses

// Try to import viem for address checksumming and optional ENS
try {
  const viem = await import('viem');
  getAddress = viem.getAddress; // Get the checksum function (works without RPC)
  
  // Optional ENS resolution requires RPC provider
  if (process.env.WEB3_PROVIDER_URL) {
    const { mainnet } = await import('viem/chains');
    publicClient = viem.createPublicClient({
      chain: mainnet,
      transport: viem.http(process.env.WEB3_PROVIDER_URL)
    });
    useEns = true;
    console.log('✓ ENS resolution enabled');
  } else {
    console.log('✓ Address checksumming enabled (ENS disabled - no WEB3_PROVIDER_URL)');
  }
} catch (e) {
  console.warn('viem not available. Addresses will not be checksummed. Install with: npm install viem');
}

// --- Config / regex ---
const ethRegex = /\b0x[a-fA-F0-9]{40}\b/g;
// Updated to support subdomains like sign.spencerfaber.eth
const ensRegex = /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth\b/gi;

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
  // For channel posts, ctx.from is undefined. 
  // Since only channel admins can post, we'll allow channel posts.
  // You could also check specific channel IDs here if you want more control.
  if (ctx.channelPost) {
    return true; // Allow all channel posts (only admins can post anyway)
  }
  // For regular messages, check if it's the owner
  return ctx.from && ctx.from.id === ownerTelegramId;
}

// Helper to check if text is a command
function isCmd(text, cmdName) {
  return text.trim().startsWith(`/${cmdName}`);
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

// --- Command Handlers (plain functions) ---
async function handleHelp(ctx) {
  const source = ctx.channelPost ? 'channel' : `user ${ctx.from?.id}`;
  console.log(`[CMD] /help from ${source} in chat ${ctx.chat.id}`);
  
  const helpMessage = `📝 Available Commands:

/help - Show this help message
/whoami - Show your Telegram ID
/status - Show collection statistics
/makelist - Send collected addresses to DM

🤖 This bot automatically collects ETH addresses and ENS names from all posts.`;
  
  await ctx.reply(helpMessage);
}

async function handleWhoami(ctx) {
  const source = ctx.channelPost ? 'channel' : `user ${ctx.from?.id}`;
  console.log(`[CMD] /whoami from ${source} in chat ${ctx.chat.id}`);
  await ctx.reply(`Your Telegram ID: ${ctx.from?.id ?? 'Channel Post (no user ID)'}`);
}

async function handleStatus(ctx) {
  const source = ctx.channelPost ? 'channel' : `user ${ctx.from?.id}`;
  console.log(`[CMD] /status from ${source} in chat ${ctx.chat.id}`);
  if (!ownerOnly(ctx)) {
    console.log(`[CMD] /status rejected - not owner`);
    return;
  }
  const chatId = ctx.chat.id;
  const chatState = ensureChat(chatId);
  const ethCount = chatState.ethSet.size;
  const ensCount = chatState.ensMap.size;
  console.log(`[CMD] Status - watching: ${chatState.watching}, ETH: ${ethCount}, ENS: ${ensCount}`);
  await ctx.reply(
    `Watched: ${chatState.watching}\nCollected: ${ethCount + ensCount} (ETH: ${ethCount}, ENS: ${ensCount})`
  );
}

async function handleMakeList(ctx) {
  const source = ctx.channelPost ? 'channel' : `user ${ctx.from?.id}`;
  console.log(`[CMD] /makelist from ${source} in chat ${ctx.chat.id}`);
  if (!ownerOnly(ctx)) {
    console.log(`[CMD] /makelist rejected - not owner`);
    return;
  }
  const chatId = ctx.chat.id;
  const chatState = ensureChat(chatId);

  // Collect all unique addresses (lowercase for deduplication)
  const addressSet = new Set();

  // Add ETH addresses
  for (const addr of chatState.ethSet) {
    addressSet.add(addr.toLowerCase());
  }
  
  // Add resolved ENS addresses (skip unresolved ENS names)
  for (const [name, maybeResolved] of chatState.ensMap.entries()) {
    if (maybeResolved) {
      addressSet.add(maybeResolved.toLowerCase());
    }
  }

  // Convert to checksummed format and sort
  let addresses = Array.from(addressSet);
  
  // Apply EIP-55 checksum if viem is available
  if (getAddress) {
    addresses = addresses.map(addr => {
      try {
        return getAddress(addr); // Converts to checksummed format
      } catch (e) {
        return addr; // Fallback to original if invalid
      }
    });
  }
  
  addresses.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  
  const ethCount = chatState.ethSet.size;
  const ensResolvedCount = Array.from(chatState.ensMap.values()).filter(v => v !== null).length;
  
  console.log(`[CMD] Generating list with ${addresses.length} unique addresses for chat ${chatId}`);
  
  if (addresses.length === 0) {
    await ctx.reply('No addresses collected yet.');
    return;
  }

  // Format message with header and addresses
  const chatName = ctx.chat.title || `Chat ${chatId}`;
  const header = `📋 Collected Addresses from ${chatName}\n(${ethCount} ETH + ${ensResolvedCount} resolved ENS = ${addresses.length} unique)\n\n`;
  const content = header + addresses.join('\n');

  try {
    // Send as regular message (split if too long)
    if (content.length <= 4096) {
      await ctx.telegram.sendMessage(ownerTelegramId, content);
      console.log(`[CMD] List sent to owner ${ownerTelegramId}`);
    } else {
      // If message is too long, split it into chunks
      const chunks = [];
      const maxLength = 4096;
      let currentChunk = header;
      
      for (const addr of addresses) {
        if ((currentChunk + addr + '\n').length > maxLength) {
          chunks.push(currentChunk);
          currentChunk = addr + '\n';
        } else {
          currentChunk += addr + '\n';
        }
      }
      if (currentChunk) chunks.push(currentChunk);
      
      for (let i = 0; i < chunks.length; i++) {
        await ctx.telegram.sendMessage(ownerTelegramId, `Part ${i + 1}/${chunks.length}:\n\n${chunks[i]}`);
      }
      console.log(`[CMD] List sent to owner ${ownerTelegramId} in ${chunks.length} parts`);
    }
    await ctx.reply('Sent you a DM with the results.');
  } catch (err) {
    console.error(`[CMD] Failed to send list: ${err.message}`);
    await ctx.reply('Failed to DM results. (Is the bot allowed to message you? Send /start to the bot in DM once.)');
  }
}

// --- Bot setup ---
const bot = new Telegraf(botToken);

// Auto-watch when bot is added to a channel or group
bot.on('my_chat_member', async (ctx) => {
  const { old_chat_member, new_chat_member } = ctx.myChatMember;
  const wasNotMember = ['left', 'kicked'].includes(old_chat_member?.status);
  const isNowMember = ['member', 'administrator', 'creator'].includes(new_chat_member?.status);
  
  // Check if bot was just added to a channel or group
  if (wasNotMember && isNowMember && ['channel', 'group', 'supergroup'].includes(ctx.chat.type)) {
    const chatId = ctx.chat.id;
    const chatState = ensureChat(chatId);
    chatState.watching = true;
    console.log(`[AUTO] Bot added to ${ctx.chat.type} ${chatId} (${ctx.chat.title}). Auto-started watching.`);
  }
});

// Register commands for regular messages (DMs, groups, supergroups)
bot.command('help', handleHelp);
bot.command('whoami', handleWhoami);
bot.command('status', handleStatus);
bot.command('makelist', handleMakeList);

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
  
  if (ethMatches.length > 0 || ensMatches.length > 0) {
    console.log(`[COLLECT] Chat ${chatId}: found ${ethMatches.length} ETH, ${ensMatches.length} ENS`);
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
  const text = ctx.channelPost.text;
  console.log(`[CHANNEL] Received post in chat ${ctx.chat.id}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
  
  // Check if this is a command
  if (isCmd(text, 'help')) return handleHelp(ctx);
  if (isCmd(text, 'whoami')) return handleWhoami(ctx);
  if (isCmd(text, 'status')) return handleStatus(ctx);
  if (isCmd(text, 'makelist')) return handleMakeList(ctx);
  
  // Otherwise, process as regular text for address collection
  await handleText(ctx, text);
});

bot.launch()
  .then(() => {
    console.log('Bot is up. Remember: for groups disable privacy mode; for channels make the bot an admin.');
  })
  .catch((err) => {
    console.error('Failed to launch bot:', err);
    process.exit(1);
  });

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Handle unhandled errors to prevent PM2 crash loops
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit - let bot continue running unless it's critical
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // For uncaught exceptions, we should exit and let PM2 restart
  process.exit(1);
});
