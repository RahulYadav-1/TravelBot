/**
 * Gemini AI Integration for TravelBuddy
 * Enhanced with conversation memory, weather, and intelligent responses
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import PQueue from 'p-queue';
import logger from '../util/logger.js';

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY, 10) || 3;
const MAX_RESPONSE_LENGTH = 1200;

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

const SYSTEM_PROMPT = `You are TravelBuddy - a professional, knowledgeable travel assistant on WhatsApp. You help travelers discover real places with verified information.

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

## CONTEXT-AWARE BEHAVIORS

### Time Awareness
- 6-10 AM: Breakfast spots open NOW
- 11 AM-3 PM: Lunch spots, AC if hot
- 3-6 PM: Cafes, snack spots, evening plans
- 6-9 PM: Dinner restaurants with reservations if needed
- 9 PM-12 AM: Late-night dining, safe areas only
- 12-6 AM: 24/7 spots only, prioritize safety

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
- Maximum 3-4 recommendations per response
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
  let msg = `Welcome to TravelBuddy 📍

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
  return `Welcome back to TravelBuddy.

Share your location or ask about any destination to get started.`;
}

/**
 * Help menu
 */
export function getHelpMenu(locationDisplay) {
  let menu = `*TravelBuddy - Quick Guide*

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
