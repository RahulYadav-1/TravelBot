/**
 * Gemini AI Integration for Travel Assistant
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

// System instruction for travel assistant
const SYSTEM_INSTRUCTION = `You are a friendly and helpful WhatsApp travel assistant. Your role is to help users with travel-related questions and suggestions.

GUIDELINES:
- Be concise and actionable - WhatsApp users prefer short, clear messages
- Keep responses under 1000 characters when possible
- Use simple formatting: line breaks and emojis sparingly for readability
- If the user mentions a city or destination:
  * Suggest 3-5 things to do (activities, attractions, experiences)
  * Recommend 3 types of local food/cuisine to try
  * Include 1 practical safety or transport tip
- If the user asks about places "near me" without sharing location, politely ask them to share their location via WhatsApp
- Ask ONE clarifying question if needed (budget, cuisine preference, travel dates, etc.)
- IMPORTANT: Do NOT make up specific business names, addresses, or phone numbers since you don't have access to real-time data
- Instead say things like "Look for local [type] restaurants" or "Search for [category] on Google Maps"
- Be honest about limitations - suggest the user verify details on Google Maps or local sources
- If user shares coordinates, acknowledge the location and ask what they're looking for (food, activities, transport, etc.)

TONE:
- Friendly but professional
- Helpful and proactive
- Culturally aware and respectful`;

/**
 * Build the prompt with user context
 * @param {object} params
 * @param {string} params.text - User's message
 * @param {object} params.userContext - User's context/memory
 * @returns {string}
 */
function buildPrompt({ text, userContext }) {
  let contextPart = '';

  if (userContext) {
    const parts = [];

    if (userContext.lastCity) {
      parts.push(`Previously mentioned city: ${userContext.lastCity}`);
    }

    if (userContext.lastLocationLatLng) {
      const { lat, lng } = userContext.lastLocationLatLng;
      parts.push(`User's shared location: ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    }

    if (userContext.lastIntent) {
      parts.push(`Previous interest: ${userContext.lastIntent}`);
    }

    if (parts.length > 0) {
      contextPart = `\n\n[User Context]\n${parts.join('\n')}\n`;
    }
  }

  return `${contextPart}\nUser message: ${text}`;
}

/**
 * Summarize a response that's too long
 * @param {string} text
 * @returns {Promise<string>}
 */
async function summarizeResponse(text) {
  logger.debug('Summarizing long response', { originalLength: text.length });

  const summarizePrompt = `Summarize the following travel information to under ${SUMMARIZE_TARGET_LENGTH} characters while keeping the most important and actionable details. Maintain the friendly tone:\n\n${text}`;

  const result = await model.generateContent(summarizePrompt);
  const response = result.response;
  const summarized = response.text().trim();

  logger.debug('Summarized response', { newLength: summarized.length });

  return summarized;
}

/**
 * Get a travel-related reply from Gemini
 * @param {object} params
 * @param {string} params.text - User's message
 * @param {object} params.userContext - User's stored context
 * @returns {Promise<string>}
 */
export async function getTravelReply({ text, userContext }) {
  return queue.add(async () => {
    try {
      logger.debug('Generating travel reply', {
        textLength: text?.length,
        hasContext: !!userContext,
      });

      const prompt = buildPrompt({ text, userContext });

      // Create chat with system instruction
      const chat = model.startChat({
        history: [
          {
            role: 'user',
            parts: [{ text: 'You are a travel assistant. Please follow these instructions for all responses:' }],
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

        // If still too long after summarization, truncate gracefully
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

      // Return a friendly error message
      if (error.message?.includes('quota')) {
        return "I'm a bit overwhelmed right now. Please try again in a moment!";
      }

      if (error.message?.includes('safety')) {
        return "I can only help with travel-related questions. How can I assist with your travel plans?";
      }

      return "Sorry, I couldn't process that. Could you try rephrasing your travel question?";
    }
  });
}

/**
 * Handle location-based queries
 * @param {object} params
 * @param {number} params.latitude
 * @param {number} params.longitude
 * @param {object} params.userContext
 * @returns {Promise<string>}
 */
export async function handleLocation({ latitude, longitude, userContext }) {
  const text = `The user just shared their location (coordinates: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}). Acknowledge this and ask what kind of help they need - are they looking for food recommendations, activities, transport options, or something else? Be helpful and offer a few options.`;

  return getTravelReply({ text, userContext });
}

/**
 * Get queue stats
 * @returns {object}
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
  handleLocation,
  getQueueStats,
};
