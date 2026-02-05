/**
 * Gemini AI Integration for Travel Assistant
 * Enhanced with location context and smart responses
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import PQueue from 'p-queue';
import logger from '../util/logger.js';

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const AI_CONCURRENCY = parseInt(process.env.AI_CONCURRENCY, 10) || 3;
const MAX_RESPONSE_LENGTH = 1200;
const SUMMARIZE_TARGET_LENGTH = 900;

if (!GEMINI_API_KEY) {
  logger.error('GEMINI_API_KEY is required');
  process.exit(1);
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

// Concurrency queue for API calls
const queue = new PQueue({ concurrency: AI_CONCURRENCY });

// Enhanced system instruction for travel assistant
const SYSTEM_INSTRUCTION = `You are TravelBuddy, a friendly and knowledgeable WhatsApp travel assistant. You help tourists discover the best of any city - food, attractions, transport, and local tips.

PERSONALITY:
- Warm, helpful, and enthusiastic about travel
- Speak like a knowledgeable local friend
- Use emojis sparingly for visual appeal (1-3 per message)
- Be concise - WhatsApp users prefer short, scannable messages

RESPONSE FORMAT:
- Use bullet points for lists
- Keep responses under 800 characters when possible
- Always end with a follow-up question to keep conversation going
- Use simple formatting that works in WhatsApp

IMPORTANT RULES:
1. NEVER invent specific business names, addresses, or phone numbers
2. Instead, describe TYPES of places and WHERE to look for them
3. Say "look for" or "search for" instead of "go to [specific place]"
4. Suggest users verify on Google Maps for exact locations
5. Be honest about limitations - you provide guidance, not exact listings

FOR FOOD RECOMMENDATIONS:
- Describe cuisine types and what to expect
- Mention areas/streets known for that food
- Give tips on what to order or ask for
- Suggest price range expectations

FOR ATTRACTIONS:
- Describe what makes it worth visiting
- Mention approximate walking/travel time from user's location
- Give best time to visit tips
- Suggest combining nearby attractions

FOR TRANSPORT:
- Explain available options (metro, bus, taxi, auto)
- Give general direction and route guidance
- Mention apps to use (Uber, local metro apps)
- Warn about common tourist transport scams

FOR SAFETY:
- Be honest but not alarmist
- Give practical tips specific to the area
- Mention what to watch out for
- Suggest safe practices

TIME AWARENESS:
- Morning (6-11 AM): Suggest breakfast spots, early attractions
- Afternoon (11 AM-4 PM): Lunch, indoor activities if hot, sightseeing
- Evening (4-8 PM): Sunset spots, dinner areas, markets
- Night (8 PM-12 AM): Nightlife areas, safe late-night food
- Late night (12-6 AM): Mention most places closed, suggest 24/7 options

ALWAYS:
- Acknowledge the user's location when relevant
- Ask clarifying questions (budget, cuisine preference, walking vs transport)
- Provide actionable next steps
- Be culturally sensitive and respectful`;

/**
 * Get current time period for context
 */
function getTimePeriod() {
  const hour = new Date().getHours();

  if (hour >= 6 && hour < 11) return { period: 'morning', description: 'Morning time' };
  if (hour >= 11 && hour < 16) return { period: 'afternoon', description: 'Afternoon' };
  if (hour >= 16 && hour < 20) return { period: 'evening', description: 'Evening time' };
  if (hour >= 20 || hour < 1) return { period: 'night', description: 'Night time' };
  return { period: 'late_night', description: 'Late night' };
}

/**
 * Build context-rich prompt for Gemini
 */
function buildPrompt({ text, userContext }) {
  const parts = [];
  const timeInfo = getTimePeriod();

  // Add location context
  if (userContext?.locationData?.fullAddress) {
    parts.push(`📍 User's Location: ${userContext.locationData.fullAddress}`);
    if (userContext.locationData.coordinates) {
      parts.push(`   Coordinates: ${userContext.locationData.coordinates.lat.toFixed(4)}, ${userContext.locationData.coordinates.lng.toFixed(4)}`);
    }
  } else if (userContext?.lastCity) {
    parts.push(`📍 User mentioned city: ${userContext.lastCity}`);
  } else {
    parts.push(`📍 Location: Not shared yet`);
  }

  // Add time context
  parts.push(`🕐 Current time: ${timeInfo.description} (${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })})`);

  // Add user preferences if known
  if (userContext?.preferences) {
    const prefs = [];
    if (userContext.preferences.budget) prefs.push(`Budget: ${userContext.preferences.budget}`);
    if (userContext.preferences.dietaryRestriction) prefs.push(`Diet: ${userContext.preferences.dietaryRestriction}`);
    if (prefs.length > 0) {
      parts.push(`👤 Preferences: ${prefs.join(', ')}`);
    }
  }

  // Add last intent for continuity
  if (userContext?.lastIntent) {
    parts.push(`💭 Previous interest: ${userContext.lastIntent}`);
  }

  // Add conversation state
  if (userContext?.isNewUser) {
    parts.push(`ℹ️ This is a NEW user - be extra welcoming`);
  }

  parts.push('');
  parts.push(`User message: ${text}`);

  return parts.join('\n');
}

/**
 * Summarize a response that's too long
 */
async function summarizeResponse(text) {
  logger.debug('Summarizing long response', { originalLength: text.length });

  const summarizePrompt = `Summarize this travel info to under ${SUMMARIZE_TARGET_LENGTH} characters. Keep the most useful details, emojis, and the follow-up question:\n\n${text}`;

  const result = await model.generateContent(summarizePrompt);
  const response = result.response;
  const summarized = response.text().trim();

  logger.debug('Summarized response', { newLength: summarized.length });
  return summarized;
}

/**
 * Get a travel-related reply from Gemini
 */
export async function getTravelReply({ text, userContext }) {
  return queue.add(async () => {
    try {
      logger.debug('Generating travel reply', {
        textLength: text?.length,
        hasLocation: !!userContext?.locationData,
      });

      const prompt = buildPrompt({ text, userContext });

      const chat = model.startChat({
        history: [
          {
            role: 'user',
            parts: [{ text: 'You are TravelBuddy. Follow these instructions for all responses:' }],
          },
          {
            role: 'model',
            parts: [{ text: SYSTEM_INSTRUCTION }],
          },
        ],
      });

      const result = await chat.sendMessage(prompt);
      const response = result.response;
      let reply = response.text().trim();

      // Check if response is too long
      if (reply.length > MAX_RESPONSE_LENGTH) {
        reply = await summarizeResponse(reply);
        if (reply.length > MAX_RESPONSE_LENGTH) {
          reply = reply.substring(0, MAX_RESPONSE_LENGTH - 3) + '...';
        }
      }

      logger.debug('Generated reply', { replyLength: reply.length });
      return reply;
    } catch (error) {
      logger.error('Gemini API error', {
        error: error.message,
        code: error.code,
      });

      if (error.message?.includes('quota')) {
        return "I'm getting a lot of questions right now! Please try again in a moment. 🙏";
      }

      if (error.message?.includes('safety')) {
        return "I can only help with travel-related questions. What would you like to know about this area? 🗺️";
      }

      return "Sorry, I couldn't process that. Could you try asking in a different way? 🤔";
    }
  });
}

/**
 * Handle location-based queries with geocoded data
 */
export async function handleLocationReceived({ locationData, userContext, isUpdate }) {
  const locationDisplay = locationData?.fullAddress || 'your location';

  const contextMessage = isUpdate
    ? `User just UPDATED their location to: ${locationDisplay}. Acknowledge the update briefly and ask what they'd like to explore in this new area.`
    : `User just shared their location: ${locationDisplay}. This is their first location share. Welcome them to the area and offer to help with: food, attractions, transport, or shopping. Keep it brief and friendly.`;

  return getTravelReply({
    text: contextMessage,
    userContext: { ...userContext, locationData },
  });
}

/**
 * Generate welcome message for new users
 */
export async function getWelcomeMessage({ isNewUser, hasLocation, locationData }) {
  if (isNewUser) {
    let message = `Hey there! 👋 I'm TravelBuddy, your personal travel assistant.

I can help you discover:
🍽️ Great food & restaurants
🏛️ Attractions & things to do
🚕 Transport & getting around
🛍️ Shopping spots

`;
    if (hasLocation && locationData?.fullAddress) {
      message += `I see you're near *${locationData.fullAddress}*! What would you like to explore?`;
    } else {
      message += `Share your location and I'll give you personalized recommendations for your area!

Tap ➕ → 📍 Location → Send your current location`;
    }
    return message;
  }

  // Returning user
  if (hasLocation && locationData?.fullAddress) {
    return `Welcome back! 👋 You're near *${locationData.fullAddress}*. What can I help you find today?`;
  }

  return `Welcome back! 👋 Ready to explore? Share your location or tell me what you're looking for!`;
}

/**
 * Generate help menu
 */
export function getHelpMenu(locationDisplay) {
  let menu = `📍 *TravelBuddy Menu*

I can help you with:

🍽️ *Food* - Say "hungry" or "food"
🏛️ *Attractions* - Say "visit" or "see"
🚕 *Transport* - Say "taxi" or "metro"
🛍️ *Shopping* - Say "shop" or "market"
⚠️ *Safety* - Say "safety tips"
📍 *Update Location* - Share new location

`;
  if (locationDisplay) {
    menu += `Currently helping you at: *${locationDisplay}*\n\n`;
  }
  menu += `What would you like to explore?`;
  return menu;
}

/**
 * Generate fallback message
 */
export function getFallbackMessage(hasLocation) {
  if (!hasLocation) {
    return `I'm not sure I understood that. 🤔

To help you better, please:
📍 Share your location (tap ➕ → Location)
OR
💬 Ask about food, attractions, or transport

Type "help" for all options!`;
  }

  return `I didn't quite catch that. 🤔

Try asking about:
• "Where can I eat nearby?"
• "What's worth visiting?"
• "How do I get around?"

Or type "help" to see all options!`;
}

/**
 * Get queue stats
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
  getHelpMenu,
  getFallbackMessage,
  getQueueStats,
};
