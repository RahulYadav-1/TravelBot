/**
 * WhatsApp Travel Assistant Bot - TravelBuddy
 * Enhanced with smart greetings, location awareness, and intelligent responses
 */

import 'dotenv/config';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import express from 'express';
import {
  getTravelReply,
  handleLocationReceived,
  getWelcomeMessage,
  getHelpMenu,
  getFallbackMessage,
  getQueueStats,
} from './ai/gemini.js';
import { TTLMap } from './util/ttlMap.js';
import { deduplicator } from './util/dedupe.js';
import { reverseGeocode, getLocationDisplay } from './util/geocoding.js';
import logger from './util/logger.js';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_PATH = process.env.DATA_PATH || '/app/data';
const USER_COOLDOWN_MS = parseInt(process.env.USER_COOLDOWN_MS, 10) || 2000;
const USER_MEMORY_TTL = 30 * 60 * 1000; // 30 minutes session

// =============================================================================
// State
// =============================================================================

let isReady = false;
let client = null;
const startTime = Date.now();

// User memory: stores session data
// Structure: { locationData, lastIntent, preferences, isNewUser, firstSeenAt, sessionStartedAt }
const userMemory = new TTLMap(USER_MEMORY_TTL);

// Permanent user registry (to detect returning users) - longer TTL
const userRegistry = new TTLMap(7 * 24 * 60 * 60 * 1000); // 7 days

// User cooldowns: stores lastReplyAt timestamp
const userCooldowns = new TTLMap(USER_COOLDOWN_MS * 2);

// Inflight requests: prevents multiple parallel replies to same user
const inflightRequests = new Map();

// =============================================================================
// Intent Detection
// =============================================================================

const INTENTS = {
  greeting: /^(hi|hello|hey|hola|start|begin|namaste|hii+)$/i,
  help: /^(help|menu|options|commands|\?)$/i,
  food: /\b(food|eat|restaurant|dining|cuisine|hungry|breakfast|lunch|dinner|cafe|coffee|snack|dessert|drink)\b/i,
  attractions: /\b(visit|see|attraction|sightseeing|temple|museum|park|monument|landmark|tourist|explore|things to do)\b/i,
  transport: /\b(transport|taxi|uber|ola|metro|bus|train|airport|auto|rickshaw|how to get|getting around|directions)\b/i,
  shopping: /\b(shop|shopping|mall|market|buy|souvenir|store)\b/i,
  safety: /\b(safe|safety|dangerous|scam|avoid|warning|crime|precaution)\b/i,
  budget: /\b(cheap|budget|free|affordable|expensive|cost|price)\b/i,
  thanks: /^(thanks|thank you|thx|ty|appreciated)$/i,
};

const PREFERENCES = {
  vegetarian: /\b(veg|vegetarian|veggie|no meat|plant based)\b/i,
  vegan: /\b(vegan)\b/i,
  nonVeg: /\b(non-?veg|meat|chicken|fish|seafood)\b/i,
  budgetFriendly: /\b(cheap|budget|affordable|low cost)\b/i,
  premium: /\b(premium|luxury|expensive|high end|fine dining)\b/i,
};

/**
 * Detect intent from message
 */
function detectIntent(text) {
  for (const [intent, pattern] of Object.entries(INTENTS)) {
    if (pattern.test(text)) {
      return intent;
    }
  }
  return null;
}

/**
 * Detect and extract preferences
 */
function detectPreferences(text) {
  const prefs = {};

  if (PREFERENCES.vegetarian.test(text)) prefs.dietaryRestriction = 'vegetarian';
  else if (PREFERENCES.vegan.test(text)) prefs.dietaryRestriction = 'vegan';
  else if (PREFERENCES.nonVeg.test(text)) prefs.dietaryRestriction = 'non-vegetarian';

  if (PREFERENCES.budgetFriendly.test(text)) prefs.budget = 'budget-friendly';
  else if (PREFERENCES.premium.test(text)) prefs.budget = 'premium';

  return Object.keys(prefs).length > 0 ? prefs : null;
}

/**
 * Detect city names in text
 */
const CITY_PATTERNS = [
  /\b(paris|london|tokyo|new york|rome|barcelona|amsterdam|berlin|dubai|singapore)\b/i,
  /\b(bangkok|bali|sydney|melbourne|toronto|vancouver|los angeles|san francisco)\b/i,
  /\b(istanbul|cairo|mumbai|delhi|hong kong|seoul|taipei|kuala lumpur)\b/i,
  /\b(lisbon|prague|vienna|budapest|athens|stockholm|oslo|copenhagen)\b/i,
  /\b(miami|chicago|boston|seattle|denver|austin|nashville|new orleans)\b/i,
  /\b(rio|buenos aires|lima|bogota|mexico city|havana|cartagena)\b/i,
  /\b(marrakech|cape town|johannesburg|nairobi|zanzibar|mauritius)\b/i,
  /\b(goa|jaipur|agra|varanasi|kolkata|chennai|bangalore|hyderabad|pune|ahmedabad)\b/i,
];

function detectCity(text) {
  for (const pattern of CITY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

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
    logger.info('QR_DATA:' + qr);
    qrcode.generate(qr, { small: true }, (qrString) => {
      console.log('\n========== SCAN THIS QR CODE ==========\n');
      console.log(qrString);
      console.log('\n========================================\n');
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

  // Get or create user context
  let userContext = userMemory.get(userId) || {};
  const isFirstEverMessage = !userRegistry.has(userId);

  // Initialize new session if needed
  if (!userContext.sessionStartedAt) {
    userContext = {
      ...userContext,
      sessionStartedAt: Date.now(),
      isNewUser: isFirstEverMessage,
    };

    // Register user
    if (isFirstEverMessage) {
      userRegistry.set(userId, { firstSeenAt: Date.now() });
      logger.info('New user registered', { userId });
    }
  }

  let reply;

  // Handle different message types
  switch (msg.type) {
    case 'chat': // Text message
      reply = await handleTextMessage(msg, userContext, isFirstEverMessage);
      break;

    case 'location':
      reply = await handleLocationMessage(msg, userContext);
      break;

    default:
      reply = handleUnsupportedMessage(msg);
      break;
  }

  // Send reply
  if (reply) {
    await msg.reply(reply);
    userCooldowns.set(userId, Date.now());
    userMemory.set(userId, userContext);

    logger.info('Sent reply', {
      to: userId,
      replyLength: reply.length,
    });
  }
}

async function handleTextMessage(msg, userContext, isFirstEverMessage) {
  const text = msg.body?.trim();

  if (!text) {
    return getFallbackMessage(!!userContext.locationData);
  }

  // Detect intent
  const intent = detectIntent(text);
  const detectedCity = detectCity(text);
  const detectedPrefs = detectPreferences(text);

  // Update context
  if (intent && intent !== 'greeting' && intent !== 'help' && intent !== 'thanks') {
    userContext.lastIntent = intent;
  }
  if (detectedCity) {
    userContext.lastCity = detectedCity;
  }
  if (detectedPrefs) {
    userContext.preferences = { ...userContext.preferences, ...detectedPrefs };
  }

  logger.debug('Message analysis', { intent, detectedCity, detectedPrefs });

  // Handle special intents
  if (intent === 'greeting') {
    // Check if this is truly the first message ever or just a new session
    if (isFirstEverMessage && !userContext.hasReceivedWelcome) {
      userContext.hasReceivedWelcome = true;
      return getWelcomeMessage({
        isNewUser: true,
        hasLocation: !!userContext.locationData,
        locationData: userContext.locationData,
      });
    } else {
      return getWelcomeMessage({
        isNewUser: false,
        hasLocation: !!userContext.locationData,
        locationData: userContext.locationData,
      });
    }
  }

  if (intent === 'help') {
    const locationDisplay = getLocationDisplay(userContext.locationData);
    return getHelpMenu(locationDisplay);
  }

  if (intent === 'thanks') {
    return "You're welcome! 😊 Let me know if you need anything else. Happy exploring!";
  }

  // For regular queries, use Gemini
  return getTravelReply({ text, userContext });
}

async function handleLocationMessage(msg, userContext) {
  const location = msg.location;

  if (!location || typeof location.latitude !== 'number') {
    return "I received a location but couldn't read the coordinates. Could you try sharing again?";
  }

  const { latitude, longitude } = location;
  const isUpdate = !!userContext.locationData;

  logger.info('Processing location', {
    lat: latitude.toFixed(4),
    lng: longitude.toFixed(4),
    isUpdate,
  });

  // Reverse geocode the location
  const locationData = await reverseGeocode(latitude, longitude);

  // Update user context
  userContext.locationData = locationData;

  // Generate response
  return handleLocationReceived({
    locationData,
    userContext,
    isUpdate,
  });
}

function handleUnsupportedMessage(msg) {
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

  return `Thanks for the ${typeName}! 📱

For now, I work best with:
💬 Text messages - Ask me anything about travel
📍 Location - Share your location for local recommendations

How can I help with your travel plans?`;
}

// =============================================================================
// Helper Functions
// =============================================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Express Health Server
// =============================================================================

const app = express();

app.get('/', (req, res) => {
  res.send('TravelBuddy WhatsApp Bot is running! 🌍');
});

app.get('/health', (req, res) => {
  const queueStats = getQueueStats();

  res.json({
    status: 'ok',
    ready: isReady,
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    stats: {
      activeSessions: userMemory.size,
      registeredUsers: userRegistry.size,
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

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }

  if (client) {
    try {
      await client.destroy();
      logger.info('WhatsApp client destroyed');
    } catch (error) {
      logger.error('Error destroying client', { error: error.message });
    }
  }

  userMemory.destroy();
  userRegistry.destroy();
  deduplicator.destroy();

  logger.info('Cleanup complete, exiting');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    reason: reason?.message || reason,
  });
});

// =============================================================================
// Main
// =============================================================================

async function main() {
  logger.info('Starting TravelBuddy WhatsApp Bot', {
    nodeVersion: process.version,
    port: PORT,
    dataPath: DATA_PATH,
    cooldownMs: USER_COOLDOWN_MS,
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info('Health server listening', { port: PORT });
  });

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
