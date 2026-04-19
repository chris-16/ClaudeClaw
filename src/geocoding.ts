/**
 * geocoding.ts
 *
 * Reverse geocoding utilities using OpenStreetMap Nominatim API.
 * Converts coordinates to human-readable addresses and place names.
 */

import { logger } from './logger.js';

export interface GeocodingResult {
  displayName: string;
  city?: string;
  country?: string;
  countryCode?: string;
  address?: {
    road?: string;
    suburb?: string;
    city?: string;
    state?: string;
    country?: string;
    postcode?: string;
  };
}

const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'ClaudeClaw/1.0 (Location Tracking)';

// Rate limiting: Nominatim allows max 1 request per second
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 1000;

/**
 * Wait to respect Nominatim's rate limit (1 req/sec)
 */
async function rateLimitedDelay(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    const delayMs = MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  lastRequestTime = Date.now();
}

/**
 * Reverse geocode coordinates to get address and place information.
 * Uses OpenStreetMap Nominatim API (free, no API key required).
 *
 * Rate limit: 1 request per second (enforced automatically)
 * Usage policy: https://operations.osmfoundation.org/policies/nominatim/
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<GeocodingResult | null> {
  try {
    await rateLimitedDelay();

    const url = new URL(`${NOMINATIM_BASE_URL}/reverse`);
    url.searchParams.set('lat', lat.toString());
    url.searchParams.set('lon', lon.toString());
    url.searchParams.set('format', 'json');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('zoom', '18'); // Building/POI level

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': USER_AGENT,
      },
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status, lat, lon },
        'Nominatim API request failed',
      );
      return null;
    }

    const data = await response.json();

    if (!data.display_name) {
      logger.debug({ lat, lon }, 'No geocoding result found');
      return null;
    }

    const result: GeocodingResult = {
      displayName: data.display_name,
      address: data.address,
    };

    // Extract common fields
    if (data.address) {
      result.city =
        data.address.city ||
        data.address.town ||
        data.address.village ||
        data.address.municipality;
      result.country = data.address.country;
      result.countryCode = data.address.country_code?.toUpperCase();
    }

    logger.info(
      { lat, lon, city: result.city, country: result.country },
      'Reverse geocoded location',
    );

    return result;
  } catch (error) {
    logger.error({ error, lat, lon }, 'Reverse geocoding failed');
    return null;
  }
}

/**
 * Extract a simple place name from geocoding result.
 * Tries to find the most relevant name (POI, building, road, or city).
 */
export function extractPlaceName(result: GeocodingResult): string {
  // If there's a specific place name in the display name before the first comma, use that
  const parts = result.displayName.split(',');
  if (parts.length > 0) {
    const firstPart = parts[0].trim();
    // If it's not just a number (house number), use it
    if (firstPart && !/^\d+$/.test(firstPart)) {
      return firstPart;
    }
  }

  // Fall back to road or city
  if (result.address?.road) {
    return result.address.road;
  }

  if (result.city) {
    return result.city;
  }

  // Last resort: use the full display name, truncated
  return result.displayName.split(',').slice(0, 2).join(', ');
}
