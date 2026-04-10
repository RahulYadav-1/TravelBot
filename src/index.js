/**
 * WhatsApp Travel Assistant Bot - TravelBuddy
 * Using Baileys for reliable WhatsApp connection
 * Enhanced with smart greetings, location awareness, weather, conversation memory,
 * quick actions, save/bookmark, emergency detection, and intelligent responses
 */

import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeInMemoryStore,
  fetchLatestBaileysVersion,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import express from 'express';
import pino from 'pino';
import {
  getTravelReply,
  handleLocationReceived,
  getWelcomeMessage,
  getWelcomeBackMessage,
  getHelpMenu,
  getEmergencyResponse,
  getSavedPlacesResponse,
  getFallbackMessage,
  getQueueStats,
} from './ai/gemini.js';
import { TTLMap } from './util/ttlMap.js';
import { deduplicator } from './util/dedupe.js';
import { reverseGeocode, getLocationDisplay } from './util/geocoding.js';
import { getWeather } from './util/weather.js';
import logger from './util/logger.js';

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_PATH = process.env.DATA_PATH || '/app/data';
const USER_COOLDOWN_MS = parseInt(process.env.USER_COOLDOWN_MS, 10) || 2000;
const USER_MEMORY_TTL = 30 * 60 * 1000; // 30 minutes session
const MAX_CONVERSATION_HISTORY = 10; // Store last 10 messages

// Baileys logger (silent to reduce noise)
const baileysLogger = pino({ level: 'silent' });

// =============================================================================
// State
// =============================================================================

let isReady = false;
let sock = null;
const startTime = Date.now();

// User memory: stores session data including conversation history
const userMemory = new TTLMap(USER_MEMORY_TTL);

// Permanent user registry (to detect returning users) - longer TTL
const userRegistry = new TTLMap(7 * 24 * 60 * 60 * 1000); // 7 days

// User cooldowns: stores lastReplyAt timestamp
const userCooldowns = new TTLMap(USER_COOLDOWN_MS * 2);

// Inflight requests: prevents multiple parallel replies to same user
const inflightRequests = new Map();

// Store for message history (optional, helps with some features)
const store = makeInMemoryStore({ logger: baileysLogger });

// =============================================================================
// Intent & Pattern Detection
// =============================================================================

const INTENTS = {
  greeting: /^(hi|hello|hey|hola|start|begin|namaste|hii+|yo|sup)$/i,
  help: /^(help|menu|options|commands|\?|what can you do)$/i,
  food: /\b(food|eat|restaurant|dining|cuisine|hungry|breakfast|lunch|dinner|cafe|coffee|snack|dessert|drink|bar|pub)\b/i,
  attractions: /\b(visit|see|attraction|sightseeing|temple|museum|park|monument|landmark|tourist|explore|things to do|places)\b/i,
  transport: /\b(transport|taxi|uber|ola|metro|bus|train|airport|auto|rickshaw|how to get|getting around|directions|reach)\b/i,
  shopping: /\b(shop|shopping|mall|market|buy|souvenir|store)\b/i,
  safety: /\b(safe|safety|dangerous|scam|avoid|warning|crime|precaution)\b/i,
  budget: /\b(cheap|budget|free|affordable|expensive|cost|price)\b/i,
  thanks: /^(thanks|thank you|thx|ty|appreciated|cool|nice|awesome|great)$/i,
  emergency: /\b(emergency|help me|police|ambulance|hospital|stolen|lost passport|robbery|attack|accident|fire|danger)\b/i,
  save: /^(save|save this|bookmark|remember this|note this)$/i,
  mySaves: /^(my saves|saved|bookmarks|my bookmarks|my places|saved places)$/i,
};

// Quick action patterns for conversation continuity
const QUICK_ACTIONS = {
  more: /^(more|show more|any more|another|else|other|other options|and|what else)$/i,
  cheaper: /^(cheaper|budget|less expensive|affordable|low cost|inexpensive)$/i,
  closer: /^(closer|nearer|nearby|near me|walking distance)$/i,
  different: /^(different|something else|change|other type|try something else)$/i,
  again: /^(again|repeat|say again|what|huh|sorry|pardon|\?)$/i,
  yes: /^(yes|yeah|yep|sure|ok|okay|go ahead|do it|yup)$/i,
  no: /^(no|nope|nah|not now|later|cancel|stop)$/i,
};

const PREFERENCES = {
  vegetarian: /\b(veg|vegetarian|veggie|no meat|plant based)\b/i,
  vegan: /\b(vegan)\b/i,
  nonVeg: /\b(non-?veg|meat|chicken|fish|seafood|mutton|lamb)\b/i,
  budgetFriendly: /\b(cheap|budget|affordable|low cost|backpacker)\b/i,
  premium: /\b(premium|luxury|expensive|high end|fine dining|upscale)\b/i,
  family: /\b(family|kids|children|child friendly)\b/i,
  solo: /\b(solo|alone|by myself|single)\b/i,
  couple: /\b(couple|romantic|date|anniversary|honeymoon)\b/i,
  group: /\b(friends|group|gang|party|bunch)\b/i,
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
 * Detect quick action from message
 */
function detectQuickAction(text) {
  for (const [action, pattern] of Object.entries(QUICK_ACTIONS)) {
    if (pattern.test(text)) {
      return action;
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
 * Detect travel style from message
 */
function detectTravelStyle(text) {
  if (PREFERENCES.family.test(text)) return 'family';
  if (PREFERENCES.solo.test(text)) return 'solo';
  if (PREFERENCES.couple.test(text)) return 'couple';
  if (PREFERENCES.group.test(text)) return 'group';
  return null;
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
  /\b(goa|jaipur|agra|varanasi|kolkata|chennai|bangalore|hyderabad|pune|ahmedabad|lucknow|chandigarh|shimla|manali|rishikesh|udaipur|jodhpur)\b/i,
];

function detectCity(text) {
  for (const pattern of CITY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// =============================================================================
// Conversation History Management
// =============================================================================

/**
 * Add message to conversation history
 */
function addToHistory(userContext, role, text) {
  if (!userContext.conversationHistory) {
    userContext.conversationHistory = [];
  }

  userContext.conversationHistory.push({
    role,
    text,
    timestamp: Date.now(),
  });

  // Keep only last N messages
  if (userContext.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
    userContext.conversationHistory = userContext.conversationHistory.slice(-MAX_CONVERSATION_HISTORY);
  }
}

/**
 * Get last bot response for "again" action
 */
function getLastBotResponse(userContext) {
  if (!userContext.conversationHistory) return null;

  for (let i = userContext.conversationHistory.length - 1; i >= 0; i--) {
    if (userContext.conversationHistory[i].role === 'assistant') {
      return userContext.conversationHistory[i].text;
    }
  }
  return null;
}

/**
 * Get last topic discussed
 */
function getLastTopic(userContext) {
  if (!userContext.conversationHistory) return null;

  // Look for last user message that had a clear topic
  for (let i = userContext.conversationHistory.length - 1; i >= 0; i--) {
    const msg = userContext.conversationHistory[i];
    if (msg.role === 'user') {
      const intent = detectIntent(msg.text);
      if (intent && !['greeting', 'help', 'thanks'].includes(intent)) {
        return intent;
      }
    }
  }
  return null;
}

// =============================================================================
// Save/Bookmark Feature
// =============================================================================

/**
 * Save last suggestion to user's bookmarks
 */
function saveLastSuggestion(userContext) {
  if (!userContext.conversationHistory || userContext.conversationHistory.length === 0) {
    return null;
  }

  // Find last bot response
  const lastBot = getLastBotResponse(userContext);
  if (!lastBot) return null;

  // Extract a meaningful summary (first 100 chars or first sentence)
  let summary = lastBot;
  const firstSentenceEnd = lastBot.search(/[.!?]\s/);
  if (firstSentenceEnd > 20 && firstSentenceEnd < 150) {
    summary = lastBot.substring(0, firstSentenceEnd + 1);
  } else if (lastBot.length > 100) {
    summary = lastBot.substring(0, 100) + '...';
  }

  if (!userContext.savedPlaces) {
    userContext.savedPlaces = [];
  }

  // Don't save duplicates
  if (!userContext.savedPlaces.includes(summary)) {
    userContext.savedPlaces.push(summary);
    return summary;
  }

  return null;
}

// =============================================================================
// Baileys WhatsApp Connection
// =============================================================================

async function connectToWhatsApp() {
  const authPath = `${DATA_PATH}/baileys_auth`;
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  logger.info('Connecting to WhatsApp', { version, authPath });

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    auth: state,
    printQRInTerminal: false, // We'll handle QR ourselves
    browser: ['TravelBuddy', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: true,
    syncFullHistory: false,
  });

  // Bind store to socket events
  store.bind(sock.ev);

  // Handle connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code received
    if (qr) {
      logger.info('QR Code received - scan with WhatsApp');
      console.log('\n========== SCAN THIS QR CODE ==========\n');
      qrcode.generate(qr, { small: true });
      console.log('\n========================================\n');
    }

    // Connection opened
    if (connection === 'open') {
      isReady = true;
      logger.info('WhatsApp connected successfully!');
    }

    // Connection closed
    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn('WhatsApp connection closed', {
        statusCode,
        shouldReconnect,
        error: lastDisconnect?.error?.message,
      });

      if (shouldReconnect) {
        logger.info('Reconnecting in 5 seconds...');
        setTimeout(connectToWhatsApp, 5000);
      } else {
        logger.error('Logged out from WhatsApp. Please delete auth folder and restart to re-scan QR.');
      }
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      await handleMessage(msg);
    }
  });

  return sock;
}

// =============================================================================
// Message Handling
// =============================================================================

async function handleMessage(msg) {
  try {
    // Ignore if no message content
    if (!msg.message) return;

    // Get sender JID
    const jid = msg.key.remoteJid;

    // Ignore group messages
    if (jid.includes('@g.us')) {
      logger.debug('Ignoring group message', { from: jid });
      return;
    }

    // Ignore status updates
    if (jid === 'status@broadcast') return;

    // Ignore messages from self
    if (msg.key.fromMe) return;

    const messageId = msg.key.id;
    const userId = jid;

    logger.info('Received message', {
      from: userId,
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
        currentPromise.then(() => processMessage(msg, userId))
      );
      return;
    }

    // Process message with inflight tracking
    const promise = processMessage(msg, userId);
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

async function processMessage(msg, userId) {
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
  const registryData = userRegistry.get(userId) || {};

  // Initialize new session if needed
  if (!userContext.sessionStartedAt) {
    userContext = {
      ...userContext,
      sessionStartedAt: Date.now(),
      isNewUser: isFirstEverMessage,
      messageCount: 0,
      hasGreeted: false,
      conversationHistory: [],
      savedPlaces: registryData.savedPlaces || [],
    };

    // Register user
    if (isFirstEverMessage) {
      userRegistry.set(userId, { firstSeenAt: Date.now(), savedPlaces: [] });
      logger.info('New user registered', { userId });
    }
  }

  // Increment message count
  userContext.messageCount = (userContext.messageCount || 0) + 1;

  let reply;

  // Extract message content
  const messageContent = msg.message;

  // Handle different message types
  if (messageContent.conversation || messageContent.extendedTextMessage) {
    // Text message
    const text = messageContent.conversation || messageContent.extendedTextMessage?.text;
    reply = await handleTextMessage(text, userContext, isFirstEverMessage);
  } else if (messageContent.locationMessage) {
    // Location message
    reply = await handleLocationMessage(messageContent.locationMessage, userContext);
  } else {
    // Unsupported message type
    reply = handleUnsupportedMessage(messageContent);
  }

  // Send reply
  if (reply) {
    // Add bot response to history
    addToHistory(userContext, 'assistant', reply);

    await sock.sendMessage(userId, { text: reply });
    userCooldowns.set(userId, Date.now());
    userMemory.set(userId, userContext);

    // Update registry with saved places
    const currentRegistry = userRegistry.get(userId) || {};
    userRegistry.set(userId, {
      ...currentRegistry,
      savedPlaces: userContext.savedPlaces,
      lastSeenAt: Date.now(),
    });

    logger.info('Sent reply', {
      to: userId,
      replyLength: reply.length,
      messageCount: userContext.messageCount,
    });
  }
}

async function handleTextMessage(text, userContext, isFirstEverMessage) {
  text = text?.trim();

  if (!text) {
    return getFallbackMessage(!!userContext.locationData);
  }

  // Add user message to history
  addToHistory(userContext, 'user', text);

  // Detect patterns
  const intent = detectIntent(text);
  const quickAction = detectQuickAction(text);
  const detectedCity = detectCity(text);
  const detectedPrefs = detectPreferences(text);
  const travelStyle = detectTravelStyle(text);

  // Update context with detected info
  if (intent && !['greeting', 'help', 'thanks'].includes(intent)) {
    userContext.lastIntent = intent;
    userContext.lastTopic = intent;
  }
  if (detectedCity) {
    userContext.lastCity = detectedCity;
  }
  if (detectedPrefs) {
    userContext.preferences = { ...userContext.preferences, ...detectedPrefs };
  }
  if (travelStyle) {
    userContext.travelStyle = travelStyle;
  }

  logger.debug('Message analysis', {
    intent,
    quickAction,
    detectedCity,
    detectedPrefs,
    travelStyle,
    messageCount: userContext.messageCount,
  });

  // ==========================================================================
  // Handle Emergency - highest priority
  // ==========================================================================
  if (intent === 'emergency') {
    const country = userContext.locationData?.country || 'India';
    return getEmergencyResponse(country);
  }

  // ==========================================================================
  // Handle Save/Bookmark
  // ==========================================================================
  if (intent === 'save') {
    const saved = saveLastSuggestion(userContext);
    if (saved) {
      return `Saved! 📌\n\nI've bookmarked: "${saved.substring(0, 50)}..."\n\nType "my saves" to see all your bookmarks.`;
    }
    return "Nothing to save yet! Ask me for a recommendation first, then say 'save this' to bookmark it.";
  }

  if (intent === 'mySaves') {
    return getSavedPlacesResponse(userContext.savedPlaces);
  }

  // ==========================================================================
  // Handle Quick Actions (more, cheaper, closer, again, different)
  // ==========================================================================
  if (quickAction) {
    const lastTopic = getLastTopic(userContext);

    if (quickAction === 'again') {
      const lastResponse = getLastBotResponse(userContext);
      if (lastResponse) {
        return lastResponse;
      }
      return "I haven't suggested anything yet. What are you looking for?";
    }

    if (quickAction === 'yes' || quickAction === 'no') {
      // Pass through to Gemini for context-aware handling
      return getTravelReply({ text, userContext });
    }

    // For more/cheaper/closer/different, modify the request
    if (lastTopic) {
      const modifiedText = `[USER WANTS ${quickAction.toUpperCase()} OPTIONS] - Previous topic was ${lastTopic}. User said: "${text}"`;
      return getTravelReply({ text: modifiedText, userContext });
    }

    return "What would you like more/different options for? Tell me what you're looking for!";
  }

  // ==========================================================================
  // Handle Greetings - with anti-repeat logic
  // ==========================================================================
  if (intent === 'greeting') {
    // Only do full greeting on first message of session
    if (userContext.messageCount === 1 && !userContext.hasGreeted) {
      userContext.hasGreeted = true;

      if (isFirstEverMessage) {
        return getWelcomeMessage({
          hasLocation: !!userContext.locationData,
          locationData: userContext.locationData,
        });
      } else {
        return getWelcomeBackMessage({
          hasLocation: !!userContext.locationData,
          locationData: userContext.locationData,
        });
      }
    }

    // For subsequent greetings, just be casual
    userContext.hasGreeted = true;
    return getTravelReply({
      text: '[User said hello again - respond casually without formal greeting, just ask how you can help]',
      userContext,
    });
  }

  // Mark as greeted if any message is processed
  if (!userContext.hasGreeted && userContext.messageCount > 0) {
    userContext.hasGreeted = true;
  }

  // ==========================================================================
  // Handle Help
  // ==========================================================================
  if (intent === 'help') {
    const locationDisplay = getLocationDisplay(userContext.locationData);
    return getHelpMenu(locationDisplay);
  }

  // ==========================================================================
  // Handle Thanks - short response
  // ==========================================================================
  if (intent === 'thanks') {
    const responses = [
      "Anytime! 🙌",
      "Happy to help! Enjoy! 😊",
      "You got it! Let me know if you need more!",
      "No problem! Have fun exploring!",
      "Cheers! Hit me up if you need anything else!",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }

  // ==========================================================================
  // Regular Query - send to Gemini with full context
  // ==========================================================================
  return getTravelReply({ text, userContext });
}

async function handleLocationMessage(location, userContext) {
  if (!location || typeof location.degreesLatitude !== 'number') {
    return "I received a location but couldn't read the coordinates. Could you try sharing again?";
  }

  const latitude = location.degreesLatitude;
  const longitude = location.degreesLongitude;
  const isUpdate = !!userContext.locationData;

  logger.info('Processing location', {
    lat: latitude.toFixed(4),
    lng: longitude.toFixed(4),
    isUpdate,
  });

  // Reverse geocode the location
  const locationData = await reverseGeocode(latitude, longitude);

  // Fetch weather for the location
  const weather = await getWeather(latitude, longitude);

  // Update user context
  userContext.locationData = locationData;
  userContext.weather = weather;

  // Log weather if available
  if (weather) {
    logger.info('Weather fetched', {
      temp: weather.temperature,
      condition: weather.condition,
    });
  }

  // Generate response
  return handleLocationReceived({
    locationData,
    userContext,
    isUpdate,
  });
}

function handleUnsupportedMessage(messageContent) {
  const types = Object.keys(messageContent);
  let typeName = 'that type of message';

  if (types.includes('imageMessage')) typeName = 'image';
  else if (types.includes('videoMessage')) typeName = 'video';
  else if (types.includes('audioMessage')) typeName = 'voice message';
  else if (types.includes('documentMessage')) typeName = 'document';
  else if (types.includes('stickerMessage')) typeName = 'sticker';
  else if (types.includes('contactMessage')) typeName = 'contact';

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

  if (sock) {
    try {
      await sock.logout();
      logger.info('WhatsApp socket closed');
    } catch (error) {
      logger.error('Error closing socket', { error: error.message });
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
  logger.info('Starting TravelBuddy WhatsApp Bot (Baileys)', {
    nodeVersion: process.version,
    port: PORT,
    dataPath: DATA_PATH,
    cooldownMs: USER_COOLDOWN_MS,
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info('Health server listening', { port: PORT });
  });

  try {
    await connectToWhatsApp();
    logger.info('WhatsApp connection initiated');
  } catch (error) {
    logger.error('Failed to connect to WhatsApp', {
      error: error.message,
    });
    // Retry connection
    setTimeout(connectToWhatsApp, 5000);
  }
}

main().catch((error) => {
  logger.error('Fatal error in main', { error: error.message });
  process.exit(1);
});
