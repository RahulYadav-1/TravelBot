/**
 * Gemini AI Integration for Amiplore
 * Enhanced with conversation memory, weather, and intelligent responses
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import PQueue from 'p-queue';
import logger from '../util/logger.js';
import { resolveTimezone, getTimezoneForCity } from '../util/cityTimezone.js';

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY, 10) || 3;
// WhatsApp message limit is 4096 chars; leave headroom for safety + the rare unicode width quirk.
const MAX_RESPONSE_LENGTH = 3800;

if (!GEMINI_API_KEY) {
  logger.error('GEMINI_API_KEY is required');
  process.exit(1);
}

// Initialize Gemini with Google Search grounding for real-time data
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  tools: [{ googleSearch: {} }],
});

// Concurrency queue
const queue = new PQueue({ concurrency: AI_CONCURRENCY });

// =============================================================================
// MASTER SYSTEM PROMPT - The brain of the bot
// =============================================================================

const SYSTEM_PROMPT = `You are Amiplore - a professional, knowledgeable travel assistant on WhatsApp. You help travelers discover real places with verified information.

## YOUR PERSONALITY
- Professional yet approachable - like a well-informed concierge
- Confident and direct in recommendations
- Warm but not overly casual - avoid slang like "tbh", "rn", "gonna"
- Minimal emojis - use only 1 per message when truly relevant (📍 for location, ⭐ for ratings)
- Never use multiple emojis in a row

## CORE PRINCIPLES

### 1. ALWAYS PROVIDE SPECIFIC RECOMMENDATIONS
- Use Google Search to find REAL, current information
- Give actual restaurant names, attraction names, hotel names
- Include real addresses, opening hours, price ranges
- Mention current ratings (e.g., "4.5⭐ on Google")
- Never say "look for" or "search for" - GIVE the answer directly

### 2. ALWAYS INCLUDE GOOGLE MAPS LINKS
For EVERY specific place you recommend, include a Google Maps link in this format:
https://www.google.com/maps/search/?api=1&query=PLACE+NAME+CITY

Example:
"*Burma Burma* - Authentic Burmese cuisine
📍 Kala Ghoda, Mumbai
💰 ₹1500 for two
⭐ 4.5/5
https://www.google.com/maps/search/?api=1&query=Burma+Burma+Kala+Ghoda+Mumbai"

### 3. INCLUDE BOOKING/REFERENCE LINKS WHEN POSSIBLE
- Restaurants: Zomato/Swiggy/OpenTable links
- Hotels: Booking.com/MakeMyTrip links
- Attractions: Official websites or ticket booking sites
- Format: "Book: [URL]"

### 4. MINIMIZE QUESTIONS, MAXIMIZE ANSWERS
- Don't ask "what type?" - GIVE 3 best options across types
- Don't ask "what budget?" - SHOW options at different price points
- Only ask clarifying questions if absolutely necessary
- Default to giving actionable recommendations immediately

### 5. NEVER REPEAT GREETINGS
- First message: Brief professional welcome
- After that: Jump straight to providing value
- Never start with "Great question!" or filler phrases

## RESPONSE STRUCTURE FOR RECOMMENDATIONS

For each place recommendation, use this format:

*[Place Name]* - [One-line description]
📍 [Specific address/area]
💰 [Price range]
⭐ [Rating if known]
🕐 [Hours or best time to visit]
[Google Maps link]
[Booking link if applicable]

## CONVERSATION CONTINUITY
- Reference previous discussion: "Based on your interest in [X]..."
- Remember preferences from session
- "more" → 3 more specific options
- "cheaper" → 3 budget alternatives with names + links
- "closer" → 3 nearby options with distances
- "different" → 3 options from different category
- "again" → repeat last specific recommendation
- When the user references a previous option ("tell me more about option 2", "the third one", "expand on #1", or just a bare number after a numbered list), look up that exact option in your prior reply (it will be visible in RECENT CONVERSATION) and give a deeper, specific response about THAT place. Never invent a different place. If you cannot identify which option they meant, ask them to clarify by name.

## CONTEXT-AWARE BEHAVIORS

### Time Awareness
- 6-10 AM: Breakfast spots open NOW
- 11 AM-3 PM: Lunch spots, AC if hot
- 3-6 PM: Cafes, snack spots, evening plans
- 6-9 PM: Dinner restaurants with reservations if needed
- 9 PM-12 AM: Late-night dining, safe areas only
- 12-6 AM: 24/7 spots only, prioritize safety
- Always use the user's local time zone when location is known.

### Weather Awareness
- Hot (>35°C): AC restaurants, indoor attractions, malls
- Rainy: Indoor venues, museums, covered markets
- Pleasant: Walking tours, outdoor cafes, viewpoints
- Cold: Warm food spots, indoor attractions

### Budget Levels
- Budget: Under ₹500/$15 - street food, hostels, free attractions
- Mid-range: ₹500-2000/$15-50 - casual dining, 3-star hotels
- Premium: ₹2000+/$50+ - fine dining, luxury hotels

## SPECIAL RESPONSE TYPES

### Food Queries
Provide 3 specific restaurants with full details + maps links + booking links.

### Attraction Queries
Give 3 specific places with: name, why visit, time needed, ticket price, hours, maps link, official site.

### Transport Queries
Specific options with current pricing:
- Uber/Ola estimated fare
- Metro line + station names
- Bus route numbers
- Realistic time estimates

### Itinerary Requests
Format:
"Recommended itinerary:

*Morning (9-12 PM)*
[Specific place 1 with maps link]

*Afternoon (12-4 PM)*
[Specific place 2 with maps link + lunch spot with maps link]

*Evening (4-8 PM)*
[Specific place 3 with maps link]

Total cost: ~[amount]
Total time: [hours]"

### Safety Queries
Direct, factual information:
- Specific areas to avoid (with names)
- Common scams with examples
- Emergency numbers for that country
- Verified safety tips

## FORMATTING FOR WHATSAPP
- Use *bold* for place names and section headers
- Line breaks between recommendations
- Maps links on their own line for easy clicking
- No markdown headers (#)
- Give exactly 3 fully detailed recommendations unless the user explicitly asks for more
- COMPLETENESS RULE: every option must include name, area, price, rating, and a Maps link before you start the next one. Never start option 2 if option 1 isn't complete. Never start option 3 if option 2 isn't complete.
- Hard limit ~3500 characters total. If you cannot fit 3 full options, give 2 complete options instead of 3 truncated ones. Better fewer-and-complete than many-and-cut.
- Never end mid-sentence, mid-link, or mid-option.
- Keep responses scannable

## EXAMPLES

User: "best restaurants in mumbai"
Response:
"Top dining recommendations in Mumbai:

*Trishna* - Award-winning seafood
📍 Fort, Mumbai
💰 ₹3000 for two
⭐ 4.6/5
https://www.google.com/maps/search/?api=1&query=Trishna+Fort+Mumbai

*Bademiya* - Iconic late-night kebabs
📍 Colaba, Mumbai
💰 ₹600 for two
⭐ 4.3/5
https://www.google.com/maps/search/?api=1&query=Bademiya+Colaba+Mumbai

*Britannia & Co* - Heritage Parsi cuisine
📍 Ballard Estate, Mumbai
💰 ₹1200 for two
⭐ 4.5/5
🕐 Closes 4 PM (lunch only)
https://www.google.com/maps/search/?api=1&query=Britannia+and+Co+Mumbai"

User: "hungry"
Response:
"Here are 3 great options near you right now:

*[Restaurant 1]* - [Cuisine]
[Full details with maps link]

*[Restaurant 2]* - [Cuisine]
[Full details with maps link]

*[Restaurant 3]* - [Cuisine]
[Full details with maps link]"

Remember: Be specific, be professional, always include real names and Google Maps links. Use search to verify current information.`;

// =============================================================================
// CONTEXT BUILDER
// =============================================================================

function resolveUserTimezone(userContext) {
  // Priority: weather (most precise, from GPS) > locationData lookup > lastCity lookup.
  if (userContext.weather?.timezone) return userContext.weather.timezone;
  if (userContext.locationData) {
    const tz = resolveTimezone(userContext.locationData);
    if (tz) return tz;
  }
  if (userContext.lastCity) {
    const tz = getTimezoneForCity(userContext.lastCity);
    if (tz) return tz;
  }
  return null;
}

function buildContext(userContext) {
  const parts = [];
  const timezone = resolveUserTimezone(userContext);
  let localTime = null;
  let localDate = null;
  let hour;
  let timeZoneSource = timezone ? 'derived' : 'server';

  const formatInTz = (opts) => new Intl.DateTimeFormat('en-US', {
    ...opts,
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date());

  try {
    localTime = formatInTz({ hour: '2-digit', minute: '2-digit', hour12: false });
    localDate = formatInTz({ weekday: 'short', month: 'short', day: 'numeric' });
    hour = parseInt(formatInTz({ hour: 'numeric', hour12: false }), 10);
  } catch (error) {
    logger.warn('Timezone formatting failed, falling back to server time', { timezone, error: error.message });
    timeZoneSource = 'server-fallback';
    localTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    localDate = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
    hour = new Date().getHours();
  }

  // Time context
  let timeOfDay;
  if (hour >= 6 && hour < 11) timeOfDay = 'Morning';
  else if (hour >= 11 && hour < 15) timeOfDay = 'Afternoon (lunch time)';
  else if (hour >= 15 && hour < 18) timeOfDay = 'Late afternoon';
  else if (hour >= 18 && hour < 21) timeOfDay = 'Evening (dinner time)';
  else if (hour >= 21 || hour < 1) timeOfDay = 'Night';
  else timeOfDay = 'Late night (most places closed)';

  const tzLabel = timezone ? ` (${timezone})` : ' (server time — user has not shared location)';
  parts.push(`🕐 LOCAL TIME: ${localDate} ${localTime}${tzLabel} - ${timeOfDay}`);
  if (timeZoneSource === 'server' || timeZoneSource === 'server-fallback') {
    parts.push(`⚠️ Time may be inaccurate. If you reference the time of day, hedge appropriately.`);
  }

  // Location context — distinguish precise GPS share from a city the user mentioned.
  if (userContext.locationData?.fullAddress) {
    parts.push(`📍 LOCATION (GPS-shared): ${userContext.locationData.fullAddress}`);
    if (userContext.lastCity && userContext.lastCity.toLowerCase() !== (userContext.locationData.city || '').toLowerCase()) {
      parts.push(`🌐 ALSO ASKING ABOUT: ${userContext.lastCity}`);
    }
  } else if (userContext.lastCity) {
    parts.push(`📍 CITY (mentioned, not GPS): ${userContext.lastCity}`);
  } else {
    parts.push(`📍 LOCATION: Not shared yet`);
  }

  // Weather context
  if (userContext.weather) {
    const w = userContext.weather;
    parts.push(`🌤️ WEATHER: ${w.temperature}°C, ${w.condition} ${w.icon}`);
  }

  // User profile
  const profile = [];
  if (userContext.preferences?.budget) profile.push(`Budget: ${userContext.preferences.budget}`);
  if (userContext.preferences?.dietaryRestriction) profile.push(`Diet: ${userContext.preferences.dietaryRestriction}`);
  if (userContext.travelStyle) profile.push(`Style: ${userContext.travelStyle}`);
  if (profile.length > 0) {
    parts.push(`👤 USER: ${profile.join(', ')}`);
  }

  // Session info
  parts.push(`💬 MESSAGE #${userContext.messageCount || 1} in session`);
  if (userContext.hasGreeted) {
    parts.push(`⚠️ ALREADY GREETED - Do NOT say hello/welcome again`);
  }

  // Conversation history. Assistant replies are kept in full so the model can
  // accurately reference its previous recommendations on follow-up turns.
  // User messages are capped because long pastes from users are usually noisy.
  if (userContext.conversationHistory?.length > 0) {
    parts.push(`\n📝 RECENT CONVERSATION:`);
    const USER_CAP = 500;
    const ASSISTANT_CAP = 3500;
    // Always include the most recent assistant reply IN FULL so ordinal references
    // ("option 3", "the second one") can be resolved even if it falls outside the window.
    const history = userContext.conversationHistory;
    const recent = history.slice(-10);
    // Find latest assistant message anywhere in history; if it's not already in recent, prepend.
    let latestAssistantIdx = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') { latestAssistantIdx = i; break; }
    }
    const latestAssistantMsg = latestAssistantIdx >= 0 ? history[latestAssistantIdx] : null;
    const latestInWindow = latestAssistantMsg && recent.includes(latestAssistantMsg);
    if (latestAssistantMsg && !latestInWindow) {
      parts.push(`You (earlier — kept for option references): ${latestAssistantMsg.text}`);
    }
    recent.forEach(msg => {
      const role = msg.role === 'user' ? 'User' : 'You';
      const cap = msg.role === 'user' ? USER_CAP : ASSISTANT_CAP;
      const text = msg.text.length > cap ? msg.text.substring(0, cap) + '...' : msg.text;
      parts.push(`${role}: ${text}`);
    });
  }

  // Saved places
  if (userContext.savedPlaces?.length > 0) {
    parts.push(`\n📌 USER'S SAVED PLACES: ${userContext.savedPlaces.join(', ')}`);
  }

  // Last topic for continuity
  if (userContext.lastTopic) {
    parts.push(`\n💭 LAST TOPIC: ${userContext.lastTopic}`);
  }

  return parts.join('\n');
}

/**
 * Truncate a reply without cutting mid-option. Tries (in order):
 *   1. Find the last complete option boundary (numbered marker, *bold* title line, or
 *      double newline) at or before the limit.
 *   2. Fall back to last full sentence.
 *   3. Last resort: hard cut + ellipsis.
 */
function truncateAtOptionBoundary(text, limit) {
  if (text.length <= limit) return text;

  const window = text.substring(0, limit);

  // 1. Look for option-start markers we'd want to truncate JUST BEFORE.
  const markers = [];
  const numberedRe = /\n\s*\d{1,2}[\.\)\-:]\s+/g;
  let m;
  while ((m = numberedRe.exec(window)) !== null) markers.push(m.index);
  const boldRe = /\n\s*\*[^\*\n]{2,80}\*/g;
  while ((m = boldRe.exec(window)) !== null) markers.push(m.index);

  // The last marker found is the start of an option that is likely INCOMPLETE
  // (since we hit the limit). Cut just before that marker so the prior option
  // remains whole. Require at least 3 markers so we don't accidentally drop
  // option #3 when the model produced exactly 3 options (the common case).
  if (markers.length >= 3) {
    const cutAt = markers[markers.length - 1];
    if (cutAt > limit * 0.4) {
      return text.substring(0, cutAt).trimEnd();
    }
  }

  // 2. Sentence boundary
  const lastSentence = window.lastIndexOf('. ');
  if (lastSentence > limit * 0.7) {
    return text.substring(0, lastSentence + 1);
  }

  // 3. Hard cut
  return window.trimEnd() + '...';
}

// =============================================================================
// MAIN REPLY FUNCTION
// =============================================================================

// Decide whether a Gemini error is worth retrying. Quota / 429 / 5xx / transient
// network issues retry with backoff; safety filters and 4xx do NOT.
function isRetryableError(error) {
  const msg = (error?.message || '').toLowerCase();
  if (msg.includes('safety')) return false;
  if (msg.includes('invalid') || msg.includes('400')) return false;
  if (msg.includes('quota') || msg.includes('429') || msg.includes('rate')) return true;
  if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket')) return true;
  if (msg.includes('fetch failed') || msg.includes('network')) return true;
  return false;
}

const RETRY_DELAYS_MS = [600, 1500, 3500];

async function callGeminiWithRetry(prompt, attempt = 0) {
  try {
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: 'You are Amiplore. Here are your instructions:' }] },
        { role: 'model', parts: [{ text: SYSTEM_PROMPT }] },
      ],
    });
    const result = await chat.sendMessage(prompt);
    return result.response.text().trim();
  } catch (error) {
    if (attempt < RETRY_DELAYS_MS.length && isRetryableError(error)) {
      const delay = RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 250);
      logger.warn('Gemini call failed, retrying', { attempt: attempt + 1, delayMs: delay, error: error.message });
      await new Promise((resolve) => setTimeout(resolve, delay));
      return callGeminiWithRetry(prompt, attempt + 1);
    }
    throw error;
  }
}

export async function getTravelReply({ text, userContext }) {
  return queue.add(async () => {
    try {
      const context = buildContext(userContext);

      const prompt = `${context}

---
USER'S MESSAGE: ${text}
---

Respond naturally as Amiplore. Remember the rules.`;

      logger.debug('Sending to Gemini', {
        messageCount: userContext.messageCount,
        hasLocation: !!userContext.locationData,
        textLength: text.length
      });

      let reply = await callGeminiWithRetry(prompt);

      // Truncate if too long, preserving option completeness.
      if (reply.length > MAX_RESPONSE_LENGTH) {
        reply = truncateAtOptionBoundary(reply, MAX_RESPONSE_LENGTH);
      }

      logger.debug('Gemini response', { replyLength: reply.length });
      return reply;

    } catch (error) {
      logger.error('Gemini API error after retries', { error: error.message });

      if (error.message?.toLowerCase().includes('quota')) {
        return "I am handling a high volume of requests right now. Please try again in a minute.";
      }
      if (error.message?.toLowerCase().includes('safety')) {
        return "I can only help with travel-related questions. What would you like to explore?";
      }
      return "I had trouble reaching my data source. Please try again in a moment.";
    }
  });
}

// =============================================================================
// SPECIAL HANDLERS
// =============================================================================

/**
 * Handle location received
 */
export async function handleLocationReceived({ locationData, userContext, isUpdate }) {
  const location = locationData?.fullAddress || 'your area';

  if (isUpdate) {
    return getTravelReply({
      text: `[SYSTEM: User updated location to ${location}. Briefly acknowledge the new location and ask what they want to explore here. Keep it short.]`,
      userContext: { ...userContext, locationData },
    });
  }

  return getTravelReply({
    text: `[SYSTEM: User just shared location: ${location}. Welcome them to this area briefly. Mention you can help with food, attractions, transport. Ask what they're looking for. Keep it conversational and short.]`,
    userContext: { ...userContext, locationData },
  });
}

/**
 * Welcome message for first-time users
 */
export function getWelcomeMessage({ hasLocation, locationData }) {
  let msg = `Welcome to Amiplore 📍

Your personal travel assistant for verified recommendations on:

*Restaurants* - with ratings, prices, booking links
*Attractions* - tickets, hours, itineraries
*Transport* - routes, fares, timing
*Hotels* - bookings and reviews
*Shopping* - markets and malls

Every recommendation includes Google Maps links for easy navigation.

`;

  if (hasLocation && locationData?.fullAddress) {
    msg += `Detected location: *${locationData.fullAddress}*

What would you like to explore? You can ask things like:
• "Best dinner spots nearby"
• "Things to do this weekend"
• "How to reach the airport"`;
  } else {
    msg += `*To get started, share your location:*
Tap ➕ → Location → Send your current location

Or simply ask about any city worldwide.`;
  }

  return msg;
}

/**
 * Welcome back message for returning users
 */
export function getWelcomeBackMessage({ hasLocation, locationData }) {
  if (hasLocation && locationData?.fullAddress) {
    return `Welcome back 📍

Current location: *${locationData.fullAddress}*

What are you looking for today?`;
  }
  return `Welcome back to Amiplore.

Share your location or ask about any destination to get started.`;
}

/**
 * Help menu
 */
export function getHelpMenu(locationDisplay) {
  let menu = `*Amiplore - Quick Guide*

*Common Requests:*
• "Best restaurants nearby"
• "Things to see today"
• "How to reach [destination]"
• "Hotels under [budget]"
• "Plan my day"

*Refine Results:*
• "more" - additional options
• "cheaper" - budget alternatives
• "closer" - nearby options
• "different" - other categories

*Save & Manage:*
• "save this" - bookmark a place
• "my saves" - view bookmarks

`;
  if (locationDisplay) {
    menu += `📍 Current location: ${locationDisplay}\n\n`;
  }
  menu += `How can I help you?`;
  return menu;
}

/**
 * Emergency response
 */
export function getEmergencyResponse(country = 'India') {
  const emergencyNumbers = {
    'India': {
      police: '100',
      ambulance: '102',
      fire: '101',
      women: '1091',
      tourist: '1363',
    },
    'default': {
      police: '911',
      ambulance: '911',
    }
  };

  const numbers = emergencyNumbers[country] || emergencyNumbers['default'];

  let response = `🚨 *Emergency Numbers*\n\n`;
  response += `🚔 Police: ${numbers.police}\n`;
  response += `🚑 Ambulance: ${numbers.ambulance}\n`;
  if (numbers.fire) response += `🚒 Fire: ${numbers.fire}\n`;
  if (numbers.women) response += `👩 Women Helpline: ${numbers.women}\n`;
  if (numbers.tourist) response += `🧳 Tourist Helpline: ${numbers.tourist}\n`;
  response += `\nAre you safe? What's happening?`;

  return response;
}

/**
 * Saved places response
 */
export function getSavedPlacesResponse(savedPlaces) {
  if (!savedPlaces || savedPlaces.length === 0) {
    return `You haven't saved anything yet!\n\nWhen I suggest something, say "save this" to bookmark it.`;
  }

  let response = `📌 *Your Saved Places*\n\n`;
  savedPlaces.forEach((place, i) => {
    response += `${i + 1}. ${place}\n`;
  });
  response += `\nWant details on any of these?`;
  return response;
}

/**
 * Fallback message
 */
export function getFallbackMessage(hasLocation) {
  if (!hasLocation) {
    return `I didn't quite catch that.\n\nPlease share your 📍 location, or ask about restaurants, attractions, transport, or hotels in any city.`;
  }
  return `Could you rephrase that? You can ask about restaurants, attractions, transport, or type "help" to see all options.`;
}

/**
 * Queue stats
 */
export function getQueueStats() {
  return {
    pending: queue.pending,
    size: queue.size,
    concurrency: AI_CONCURRENCY,
  };
}

export default {
  getTravelReply,
  handleLocationReceived,
  getWelcomeMessage,
  getWelcomeBackMessage,
  getHelpMenu,
  getEmergencyResponse,
  getSavedPlacesResponse,
  getFallbackMessage,
  getQueueStats,
};
