/**
 * Reverse Geocoding using OpenStreetMap Nominatim (Free)
 */

import logger from './logger.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT = 'TravelBot/1.0';

// Cache to avoid repeated API calls for same coordinates
const geocodeCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Reverse geocode coordinates to location name
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<object>} Location details
 */
export async function reverseGeocode(latitude, longitude) {
  // Round to 4 decimal places for caching (roughly 11m accuracy)
  const lat = Math.round(latitude * 10000) / 10000;
  const lng = Math.round(longitude * 10000) / 10000;
  const cacheKey = `${lat},${lng}`;

  // Check cache
  const cached = geocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    logger.debug('Geocode cache hit', { cacheKey });
    return cached.data;
  }

  try {
    const url = `${NOMINATIM_URL}?lat=${lat}&lon=${lng}&format=json&addressdetails=1&zoom=16`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en',
      },
    });

    if (!response.ok) {
      throw new Error(`Nominatim API error: ${response.status}`);
    }

    const data = await response.json();

    const result = parseNominatimResponse(data, lat, lng);

    // Cache result
    geocodeCache.set(cacheKey, {
      data: result,
      timestamp: Date.now(),
    });

    logger.info('Reverse geocoded location', {
      coordinates: cacheKey,
      area: result.areaName
    });

    return result;
  } catch (error) {
    logger.error('Geocoding failed', { error: error.message });

    // Return fallback with just coordinates
    return {
      areaName: null,
      city: null,
      state: null,
      country: null,
      fullAddress: null,
      coordinates: { lat, lng },
      raw: null,
    };
  }
}

/**
 * Parse Nominatim response into clean structure
 */
function parseNominatimResponse(data, lat, lng) {
  const address = data.address || {};

  // Try to get the most useful area name
  const areaName =
    address.neighbourhood ||
    address.suburb ||
    address.quarter ||
    address.village ||
    address.town ||
    address.city_district ||
    address.district ||
    null;

  const city =
    address.city ||
    address.town ||
    address.municipality ||
    address.county ||
    null;

  const state = address.state || null;
  const country = address.country || null;

  // Build a readable location string
  let fullAddress = '';
  if (areaName && city) {
    fullAddress = `${areaName}, ${city}`;
  } else if (city) {
    fullAddress = city;
  } else if (areaName) {
    fullAddress = areaName;
  }

  if (country && fullAddress) {
    fullAddress += `, ${country}`;
  }

  return {
    areaName,
    city,
    state,
    country,
    fullAddress: fullAddress || data.display_name || null,
    coordinates: { lat, lng },
    raw: address,
  };
}

/**
 * Get a friendly location string for display
 */
export function getLocationDisplay(locationData) {
  if (!locationData) return null;

  if (locationData.areaName && locationData.city) {
    return `${locationData.areaName}, ${locationData.city}`;
  }

  if (locationData.city) {
    return locationData.city;
  }

  if (locationData.fullAddress) {
    return locationData.fullAddress;
  }

  if (locationData.coordinates) {
    return `${locationData.coordinates.lat.toFixed(4)}, ${locationData.coordinates.lng.toFixed(4)}`;
  }

  return null;
}

export default {
  reverseGeocode,
  getLocationDisplay,
};
