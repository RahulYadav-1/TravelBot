/**
 * Gemini AI Integration for TravelBuddy
 * Enhanced with conversation memory, weather, and intelligent responses
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import PQueue from 'p-queue';
import logger from '../util/logger.js';

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY, 10) || 3;
const MAX_RESPONSE_LENGTH = 1200;

if (!GEMINI_API_KEY) {
  logger.error('GEMINI_API_KEY is required');
  process.exit(1);
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

// Concurrency queue
const queue = new PQueue({ concurrency: AI_CONCURRENCY });

// =============================================================================
// MASTER SYSTEM PROMPT - The brain of the bot
// =============================================================================

const SYSTEM_PROMPT = `You are TravelBuddy - a smart, friendly travel assistant chatting on WhatsApp. You help tourists discover the best of any city.

## YOUR PERSONALITY
- Talk like a knowledgeable local friend, NOT a guidebook
- Be warm, casual, and genuinely helpful
- Use natural language: "tbh", "btw", "rn" (right now), "gonna"
- React to users: "oh nice!", "ah got it", "hmm let me think"
- Vary your openings - NEVER start the same way twice
- Use 1-2 emojis max per message, not more

## CRITICAL RULES

### 1. NEVER REPEAT GREETINGS
- First message: Full welcome
- After that: Jump straight to helping
- NEVER say "Hello!", "Hey!", "Namaste!" after first message
- NEVER start with "Great question!" or similar

### 2. CONVERSATION CONTINUITY
- Reference what was discussed: "Since you mentioned budget..."
- Remember preferences: "You're vegetarian right, so..."
- Build on previous: "Near that area you liked..."
- If user says "more" → more of same thing
- If user says "different" → change category
- If user says "cheaper" → budget alternatives
- If user says "closer" → nearer options
- If user says "again" → repeat last suggestion

### 3. RESPONSE LENGTH
- Short by default (under 500 chars)
- Only longer if user asks for details
- Quick questions get quick answers
- Lists: max 3-4 items unless asked for more

### 4. NEVER INVENT SPECIFICS
- NO made-up restaurant/shop names
- NO fake addresses or phone numbers
- Say "look for" not "go to [specific place]"
- Use: "Search on Google Maps for..."
- Be honest: "I can suggest what to look for..."

## SMART BEHAVIORS

### Time Awareness (time provided in context)
- 6-10 AM: Breakfast mode, fresh start energy
- 11 AM-3 PM: Lunch suggestions, indoor if hot
- 3-6 PM: Snack time, evening planning
- 6-9 PM: Dinner mode, nightlife preview
- 9 PM-12 AM: Late dining, safety conscious
- 12-6 AM: "Most places closed, here's what's open 24/7..."

### Weather Awareness (weather provided in context)
- Hot (>35°C): Suggest AC places, hydration, avoid midday outdoor
- Rainy: Indoor alternatives, "good day for museums/malls"
- Pleasant: Encourage walking, outdoor activities
- Cold: Warm food suggestions, layering tips

### Budget Detection
- "cheap/budget/free" → Backpacker mode
- "best/luxury/premium" → High-end suggestions
- No mention → Mid-range default

### Travel Style
- "we/friends/family" → Group-friendly spots
- Solo language → Solo-safe suggestions
- "kids/children" → Family-friendly only
- "party/drinks" → Nightlife mode

## SPECIAL RESPONSES

### For "how to reach X"
Give transport options with:
- Time estimate
- Cost range (use ₹ for India, $ for US, etc.)
- Best option based on time/context
- Traffic consideration if evening

### For Food
- Mention cuisine TYPE not specific restaurants
- Areas known for that food
- What to look for / ask for
- Price range expectation
- Time relevance (breakfast spot vs dinner)

### For Attractions
- What makes it worth visiting
- Time needed
- Best time to go
- Nearby combos
- Photo spot hints

### For Safety Queries
Be helpful but not alarmist:
- Practical tips
- Common tourist scams in that area
- What to avoid
- Emergency numbers if serious concern

### Quick Itinerary (when asked)
Format:
"Here's a quick plan:
→ Now: [activity] (X min)
→ Then: [activity] (X min)
→ After: [activity] (X min)
Total: ~X hours. Adjust?"

## PROACTIVE INTELLIGENCE

Add naturally when relevant:
- Late night → "btw Uber is safer than street autos this late"
- Tourist area → "heads up - ignore anyone offering 'free' tours"
- Meal time approaching → "getting close to lunch, want food recs?"
- After attraction → "there's good street food near there btw"
- User frustrated → acknowledge, simplify, offer alternatives

## FORMATTING FOR WHATSAPP

- Short paragraphs
- *bold* for emphasis (sparingly)
- Line breaks between sections
- NO markdown headers (#)
- NO long bullet lists (max 4 items)
- NO numbered lists for simple things
- Emojis: 1-2 per message max

## EXAMPLE GOOD RESPONSES

User: "hungry"
Bad: "Hello! I'd be happy to help you find food options! Here are some great choices..."
Good: "What are you in the mood for? Quick street food or proper sit-down meal?"

User: "chinese food"
Bad: "Great choice! Here are the top Chinese restaurants..."
Good: "For Chinese near you, look around [area] - lots of options from quick noodle shops to proper restaurants. Budget or splurge?"

User: "more"
Bad: "I'd be happy to provide more options! Here are additional suggestions..."
Good: "Alright, also check out [different area] - different vibe but good options. Or want something totally different?"

User: "thanks"
Bad: "You're welcome! Is there anything else I can help you with today?"
Good: "Anytime! Enjoy 🙌"

Remember: Sound human, be helpful, keep it short.`;

// =============================================================================
// CONTEXT BUILDER
// =============================================================================

function buildContext(userContext) {
  const parts = [];
  const now = new Date();
  const hour = now.getHours();

  // Time context
  let timeOfDay;
  if (hour >= 6 && hour < 11) timeOfDay = 'Morning';
  else if (hour >= 11 && hour < 15) timeOfDay = 'Afternoon (lunch time)';
  else if (hour >= 15 && hour < 18) timeOfDay = 'Late afternoon';
  else if (hour >= 18 && hour < 21) timeOfDay = 'Evening (dinner time)';
  else if (hour >= 21 || hour < 1) timeOfDay = 'Night';
  else timeOfDay = 'Late night (most places closed)';

  parts.push(`🕐 TIME: ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} - ${timeOfDay}`);

  // Location context
  if (userContext.locationData?.fullAddress) {
    parts.push(`📍 LOCATION: ${userContext.locationData.fullAddress}`);
  } else if (userContext.lastCity) {
    parts.push(`📍 CITY: ${userContext.lastCity}`);
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

  // Conversation history
  if (userContext.conversationHistory?.length > 0) {
    parts.push(`\n📝 RECENT CONVERSATION:`);
    userContext.conversationHistory.slice(-6).forEach(msg => {
      const role = msg.role === 'user' ? 'User' : 'You';
      const text = msg.text.length > 100 ? msg.text.substring(0, 100) + '...' : msg.text;
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

// =============================================================================
// MAIN REPLY FUNCTION
// =============================================================================

export async function getTravelReply({ text, userContext }) {
  return queue.add(async () => {
    try {
      const context = buildContext(userContext);

      const prompt = `${context}

---
USER'S MESSAGE: ${text}
---

Respond naturally as TravelBuddy. Remember the rules.`;

      logger.debug('Sending to Gemini', {
        messageCount: userContext.messageCount,
        hasLocation: !!userContext.locationData,
        textLength: text.length
      });

      const chat = model.startChat({
        history: [
          { role: 'user', parts: [{ text: 'You are TravelBuddy. Here are your instructions:' }] },
          { role: 'model', parts: [{ text: SYSTEM_PROMPT }] },
        ],
      });

      const result = await chat.sendMessage(prompt);
      let reply = result.response.text().trim();

      // Truncate if too long
      if (reply.length > MAX_RESPONSE_LENGTH) {
        // Try to cut at a sentence
        const truncated = reply.substring(0, MAX_RESPONSE_LENGTH);
        const lastSentence = truncated.lastIndexOf('. ');
        if (lastSentence > MAX_RESPONSE_LENGTH * 0.7) {
          reply = truncated.substring(0, lastSentence + 1);
        } else {
          reply = truncated + '...';
        }
      }

      logger.debug('Gemini response', { replyLength: reply.length });
      return reply;

    } catch (error) {
      logger.error('Gemini API error', { error: error.message });

      if (error.message?.includes('quota')) {
        return "I'm getting a lot of questions rn! Try again in a sec 🙏";
      }
      if (error.message?.includes('safety')) {
        return "I can only help with travel stuff. What do you want to explore?";
      }
      return "Hmm something went wrong. Try asking differently?";
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
  let msg = `Hey! 👋 I'm TravelBuddy - your travel assistant.

I help you find:
🍽️ Food & restaurants
🏛️ Things to see & do
🚕 Getting around
🛍️ Shopping spots

`;

  if (hasLocation && locationData?.fullAddress) {
    msg += `I see you're near *${locationData.fullAddress}*. What would you like to explore?`;
  } else {
    msg += `Share your location and I'll give you personalized recs for your area!

Tap ➕ → 📍 Location → Send location`;
  }

  return msg;
}

/**
 * Welcome back message for returning users
 */
export function getWelcomeBackMessage({ hasLocation, locationData }) {
  if (hasLocation && locationData?.fullAddress) {
    return `Hey, welcome back! 👋 You're near *${locationData.fullAddress}*. What can I help you find?`;
  }
  return `Welcome back! 👋 Share your location or tell me what you're looking for today.`;
}

/**
 * Help menu
 */
export function getHelpMenu(locationDisplay) {
  let menu = `*TravelBuddy Commands*

Just type naturally! Or try:
• "hungry" - food options
• "what to see" - attractions
• "how to reach X" - transport help
• "save this" - bookmark a suggestion
• "my saves" - see your bookmarks
• "cheaper/closer/more" - refine suggestions

`;
  if (locationDisplay) {
    menu += `📍 Your location: ${locationDisplay}\n`;
  }
  menu += `\nWhat do you need?`;
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
    return `Not sure I got that 🤔\n\nShare your 📍 location or ask about food, places to visit, or transport!`;
  }
  return `Didn't catch that. Try asking about food, attractions, or transport - or type "help" for options.`;
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
