/**
 * WhatsApp Travel Assistant Bot
 * Main entry point
 */

import 'dotenv/config';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import express from 'express';
import { getTravelReply, handleLocation, getQueueStats } from './ai/gemini.js';
import { TTLMap } from './util/ttlMap.js';
import { deduplicator } from './util/dedupe.js';
import logger from './util/logger.js';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_PATH = process.env.DATA_PATH || '/app/data';
const USER_COOLDOWN_MS = parseInt(process.env.USER_COOLDOWN_MS, 10) || 2000;
const USER_MEMORY_TTL = 30 * 60 * 1000; // 30 minutes

// =============================================================================
// State
// =============================================================================

let isReady = false;
let client = null;
const startTime = Date.now();

// User memory: stores lastCity, lastIntent, lastLocationLatLng, lastSeenAt
const userMemory = new TTLMap(USER_MEMORY_TTL);

// User cooldowns: stores lastReplyAt timestamp
const userCooldowns = new TTLMap(USER_COOLDOWN_MS * 2);

// Inflight requests: prevents multiple parallel replies to same user
const inflightRequests = new Map();

// Common city patterns for simple detection
const CITY_PATTERNS = [
  /\b(paris|london|tokyo|new york|rome|barcelona|amsterdam|berlin|dubai|singapore)\b/i,
  /\b(bangkok|bali|sydney|melbourne|toronto|vancouver|los angeles|san francisco)\b/i,
  /\b(istanbul|cairo|mumbai|delhi|hong kong|seoul|taipei|kuala lumpur)\b/i,
  /\b(lisbon|prague|vienna|budapest|athens|stockholm|oslo|copenhagen)\b/i,
  /\b(miami|chicago|boston|seattle|denver|austin|nashville|new orleans)\b/i,
  /\b(rio|buenos aires|lima|bogota|mexico city|havana|cartagena)\b/i,
  /\b(marrakech|cape town|johannesburg|nairobi|zanzibar|mauritius)\b/i,
];

// Intent patterns for simple detection
const INTENT_PATTERNS = {
  food: /\b(food|eat|restaurant|dining|cuisine|hungry|breakfast|lunch|dinner|cafe)\b/i,
  activities: /\b(things to do|activities|attractions|sightseeing|visit|explore|tour)\b/i,
  transport: /\b(transport|taxi|uber|metro|bus|train|airport|getting around)\b/i,
  accommodation: /\b(hotel|hostel|stay|airbnb|accommodation|where to stay)\b/i,
  safety: /\b(safe|safety|dangerous|scam|avoid|warning)\b/i,
};

// =============================================================================
// WhatsApp Client Setup
// =============================================================================

function createClient() {
  logger.info('Creating WhatsApp client', { dataPath: DATA_PATH });

  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: `${DATA_PATH}/.wwebjs_auth`,
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update',
        '--disable-software-rasterizer',
        '--disable-crash-reporter',
        '--disable-breakpad',
      ],
    },
  });

  // QR Code event
  client.on('qr', (qr) => {
    logger.info('QR Code received - scan with WhatsApp');
    qrcode.generate(qr, { small: true }, (qrString) => {
      logger.qr(qrString);
    });
  });

  // Ready event
  client.on('ready', () => {
    isReady = true;
    logger.info('WhatsApp client is ready');
  });

  // Authenticated event
  client.on('authenticated', () => {
    logger.info('WhatsApp client authenticated');
  });

  // Auth failure event
  client.on('auth_failure', (msg) => {
    logger.error('WhatsApp authentication failed', { message: msg });
    isReady = false;
  });

  // Disconnected event
  client.on('disconnected', (reason) => {
    logger.warn('WhatsApp client disconnected', { reason });
    isReady = false;
    scheduleReconnect();
  });

  // Message event
  client.on('message', handleMessage);

  return client;
}

// =============================================================================
// Reconnection Logic
// =============================================================================

let reconnectAttempts = 0;
let reconnectTimeout = null;

function scheduleReconnect() {
  if (reconnectTimeout) return;

  reconnectAttempts++;
  const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts));

  logger.info('Scheduling reconnect', { attempt: reconnectAttempts, delayMs: delay });

  reconnectTimeout = setTimeout(async () => {
    reconnectTimeout = null;
    try {
      logger.info('Attempting to reconnect WhatsApp client');
      await client.initialize();
      reconnectAttempts = 0;
    } catch (error) {
      logger.error('Reconnect failed', { error: error.message });
      scheduleReconnect();
    }
  }, delay);
}

// =============================================================================
// Message Handling
// =============================================================================

async function handleMessage(msg) {
  try {
    // Ignore group messages
    if (msg.from.includes('@g.us')) {
      logger.debug('Ignoring group message', { from: msg.from });
      return;
    }

    // Ignore status updates
    if (msg.from === 'status@broadcast') {
      return;
    }

    // Ignore messages from self
    if (msg.fromMe) {
      return;
    }

    const messageId = msg.id?._serialized;
    const userId = msg.from;

    logger.info('Received message', {
      from: userId,
      type: msg.type,
      messageId,
    });

    // Deduplication check
    if (deduplicator.checkAndMark(messageId)) {
      logger.debug('Skipping duplicate message', { messageId });
      return;
    }

    // Check if there's already an inflight request for this user
    if (inflightRequests.has(userId)) {
      logger.debug('User has inflight request, queuing', { userId });
      // Queue this request to process after current one finishes
      const currentPromise = inflightRequests.get(userId);
      inflightRequests.set(
        userId,
        currentPromise.then(() => processMessage(msg))
      );
      return;
    }

    // Process message with inflight tracking
    const promise = processMessage(msg);
    inflightRequests.set(userId, promise);

    try {
      await promise;
    } finally {
      inflightRequests.delete(userId);
    }
  } catch (error) {
    logger.error('Error handling message', {
      error: error.message,
      stack: error.stack,
    });
  }
}

async function processMessage(msg) {
  const userId = msg.from;

  // Apply cooldown
  const lastReplyAt = userCooldowns.get(userId);
  if (lastReplyAt) {
    const elapsed = Date.now() - lastReplyAt;
    if (elapsed < USER_COOLDOWN_MS) {
      const waitTime = USER_COOLDOWN_MS - elapsed;
      logger.debug('Applying cooldown', { userId, waitMs: waitTime });
      await sleep(waitTime);
    }
  }

  // Get/update user context
  let userContext = userMemory.get(userId) || {};
  userContext.lastSeenAt = Date.now();

  let reply;

  // Handle different message types
  switch (msg.type) {
    case 'chat': // Text message
      reply = await handleTextMessage(msg, userContext);
      break;

    case 'location':
      reply = await handleLocationMessage(msg, userContext);
      break;

    default:
      reply = await handleUnsupportedMessage(msg);
      break;
  }

  // Send reply
  if (reply) {
    await msg.reply(reply);
    userCooldowns.set(userId, Date.now());

    // Update user memory
    userMemory.set(userId, userContext);

    logger.info('Sent reply', {
      to: userId,
      replyLength: reply.length,
    });
  }
}

async function handleTextMessage(msg, userContext) {
  const text = msg.body?.trim();

  if (!text) {
    return "I didn't catch that. Could you send me a text message about your travel question?";
  }

  // Update context with detected city
  const detectedCity = detectCity(text);
  if (detectedCity) {
    userContext.lastCity = detectedCity;
    logger.debug('Detected city', { city: detectedCity });
  }

  // Update context with detected intent
  const detectedIntent = detectIntent(text);
  if (detectedIntent) {
    userContext.lastIntent = detectedIntent;
    logger.debug('Detected intent', { intent: detectedIntent });
  }

  return getTravelReply({ text, userContext });
}

async function handleLocationMessage(msg, userContext) {
  const location = msg.location;

  if (!location || typeof location.latitude !== 'number') {
    return "I received a location but couldn't read the coordinates. Could you try sharing again?";
  }

  const { latitude, longitude } = location;

  // Store location in user context
  userContext.lastLocationLatLng = { lat: latitude, lng: longitude };

  logger.info('Received location', {
    lat: latitude.toFixed(4),
    lng: longitude.toFixed(4),
  });

  return handleLocation({ latitude, longitude, userContext });
}

async function handleUnsupportedMessage(msg) {
  const typeDescriptions = {
    image: 'image',
    video: 'video',
    audio: 'voice message',
    ptt: 'voice note',
    document: 'document',
    sticker: 'sticker',
    contact: 'contact',
  };

  const typeName = typeDescriptions[msg.type] || 'that type of message';

  return `Thanks for the ${typeName}! For now, I can only help with text messages and location shares. Feel free to describe your travel question in a text message, or share your location if you're looking for nearby recommendations!`;
}

// =============================================================================
// Helper Functions
// =============================================================================

function detectCity(text) {
  for (const pattern of CITY_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

function detectIntent(text) {
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(text)) {
      return intent;
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Express Health Server
// =============================================================================

const app = express();

app.get('/', (req, res) => {
  res.send('WhatsApp Travel Bot is running');
});

app.get('/health', (req, res) => {
  const queueStats = getQueueStats();

  res.json({
    status: 'ok',
    ready: isReady,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    stats: {
      activeUsers: userMemory.size,
      dedupeEntries: deduplicator.size,
      aiQueue: queueStats,
    },
  });
});

// =============================================================================
// Graceful Shutdown
// =============================================================================

async function shutdown(signal) {
  logger.info('Shutdown signal received', { signal });

  // Clear reconnect timeout
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  // Destroy client
  if (client) {
    try {
      await client.destroy();
      logger.info('WhatsApp client destroyed');
    } catch (error) {
      logger.error('Error destroying client', { error: error.message });
    }
  }

  // Clean up TTL maps
  userMemory.destroy();
  deduplicator.destroy();

  logger.info('Cleanup complete, exiting');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', {
    reason: reason?.message || reason,
  });
});

// =============================================================================
// Main
// =============================================================================

async function main() {
  logger.info('Starting WhatsApp Travel Bot', {
    nodeVersion: process.version,
    port: PORT,
    dataPath: DATA_PATH,
    cooldownMs: USER_COOLDOWN_MS,
  });

  // Start Express server
  app.listen(PORT, '0.0.0.0', () => {
    logger.info('Health server listening', { port: PORT });
  });

  // Create and initialize WhatsApp client
  client = createClient();

  try {
    await client.initialize();
    logger.info('WhatsApp client initialization started');
  } catch (error) {
    logger.error('Failed to initialize WhatsApp client', {
      error: error.message,
    });
    scheduleReconnect();
  }
}

main().catch((error) => {
  logger.error('Fatal error in main', { error: error.message });
  process.exit(1);
});
