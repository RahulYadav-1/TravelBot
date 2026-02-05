/**
 * Weather API Integration using Open-Meteo (100% Free, No API Key)
 */

import logger from './logger.js';

const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast';

// Cache weather data for 30 minutes
const weatherCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

/**
 * Get current weather for coordinates
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<object>} Weather data
 */
export async function getWeather(latitude, longitude) {
  const lat = Math.round(latitude * 100) / 100;
  const lng = Math.round(longitude * 100) / 100;
  const cacheKey = `${lat},${lng}`;

  // Check cache
  const cached = weatherCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.debug('Weather cache hit', { cacheKey });
    return cached.data;
  }

  try {
    const url = `${WEATHER_API_URL}?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Weather API error: ${response.status}`);
    }

    const data = await response.json();
    const result = parseWeatherResponse(data);

    // Cache result
    weatherCache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });

    logger.info('Fetched weather', { location: cacheKey, temp: result.temperature });

    return result;
  } catch (error) {
    logger.error('Weather API failed', { error: error.message });
    return null;
  }
}

/**
 * Parse Open-Meteo response
 */
function parseWeatherResponse(data) {
  const current = data.current;

  return {
    temperature: Math.round(current.temperature_2m),
    humidity: current.relative_humidity_2m,
    windSpeed: Math.round(current.wind_speed_10m),
    condition: getWeatherCondition(current.weather_code),
    icon: getWeatherIcon(current.weather_code),
    isGoodForOutdoor: isGoodOutdoorWeather(current),
  };
}

/**
 * Convert WMO weather code to readable condition
 */
function getWeatherCondition(code) {
  const conditions = {
    0: 'Clear sky',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Foggy',
    48: 'Foggy',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Light showers',
    81: 'Showers',
    82: 'Heavy showers',
    85: 'Snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with heavy hail',
  };

  return conditions[code] || 'Unknown';
}

/**
 * Get emoji icon for weather
 */
function getWeatherIcon(code) {
  if (code === 0 || code === 1) return '☀️';
  if (code === 2) return '⛅';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 55) return '🌧️';
  if (code >= 61 && code <= 65) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code >= 85 && code <= 86) return '🌨️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}

/**
 * Check if weather is good for outdoor activities
 */
function isGoodOutdoorWeather(current) {
  const temp = current.temperature_2m;
  const code = current.weather_code;

  // Bad weather codes (rain, snow, storm)
  const badCodes = [51, 53, 55, 61, 63, 65, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];

  if (badCodes.includes(code)) return false;
  if (temp > 40 || temp < 5) return false;

  return true;
}

/**
 * Get weather-based suggestion
 */
export function getWeatherSuggestion(weather) {
  if (!weather) return null;

  const { temperature, condition, isGoodForOutdoor, icon } = weather;

  let suggestion = `${icon} ${temperature}°C, ${condition}. `;

  if (temperature > 38) {
    suggestion += 'It\'s very hot! Stick to AC places, stay hydrated. Outdoor sightseeing best before 10 AM or after 5 PM.';
  } else if (temperature > 32) {
    suggestion += 'Warm day. Carry water, prefer shaded areas. Indoor attractions good for afternoon.';
  } else if (temperature < 10) {
    suggestion += 'It\'s cold! Layer up. Hot chai and warm food weather.';
  } else if (!isGoodForOutdoor) {
    suggestion += 'Not ideal for outdoor activities. Good day for museums, malls, cafes.';
  } else {
    suggestion += 'Nice weather for exploring outside!';
  }

  return suggestion;
}

export default {
  getWeather,
  getWeatherSuggestion,
};
