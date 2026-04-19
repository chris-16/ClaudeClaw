import crypto from 'crypto';

import {
  createMissionTask,
  findPlaceByCoordinates,
  getCurrentLocation,
  insertLocationEvent,
  markNudged,
  OwnTracksPayload,
  upsertCurrentLocation,
  upsertPlace,
  wasNudgedRecently,
} from './db.js';
import { logger } from './logger.js';

const DEFAULT_USER_ID = 'chris';
const NUDGE_THROTTLE_SEC = 10 * 60;
const QUIET_HOURS_TZ = 'America/Santiago';
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 8;

export async function ingestOwnTracksPayload(
  userId: string,
  events: OwnTracksPayload[],
): Promise<number> {
  // Sort ascending by tst so the LWW upsert converges on the latest event
  // even when OwnTracks delivers a queued batch out of order.
  const sorted = events.slice().sort((a, b) => (a.tst ?? 0) - (b.tst ?? 0));
  let processed = 0;

  for (const e of sorted) {
    if (e._type !== 'location' && e._type !== 'transition') continue;
    if (typeof e.tst !== 'number') continue;

    insertLocationEvent(userId, e);
    const changed = upsertCurrentLocation(userId, e);

    // Auto-create place from OwnTracks region on first transition event
    if (e._type === 'transition' && e.desc && typeof e.lat === 'number' && typeof e.lon === 'number') {
      try {
        autoCreatePlaceFromRegion(e);
      } catch (err) {
        logger.debug({ err, region: e.desc }, 'Failed to auto-create place from region');
      }
    }

    // Match coordinates against known places for semantic location
    if (typeof e.lat === 'number' && typeof e.lon === 'number') {
      try {
        const place = findPlaceByCoordinates(e.lat, e.lon);
        if (place) {
          logger.debug({ place: place.name, lat: e.lat, lon: e.lon }, 'Matched location to place');
        }
      } catch (err) {
        logger.debug({ err }, 'Place matching failed');
      }
    }

    if (e._type === 'transition' && changed) {
      try {
        maybeEnqueueTransitionNudge(userId, e);
      } catch (err) {
        logger.debug({ err }, 'OwnTracks transition nudge failed');
      }
    }
    processed++;
  }

  return processed;
}

function isQuietHours(now: Date): boolean {
  const hour = Number(
    now.toLocaleString('en-US', {
      timeZone: QUIET_HOURS_TZ,
      hour: 'numeric',
      hour12: false,
    }),
  );
  if (Number.isNaN(hour)) return false;
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * Auto-create a place from an OwnTracks region transition event.
 * Uses the region name and coordinates from the transition.
 */
function autoCreatePlaceFromRegion(e: OwnTracksPayload): void {
  if (!e.desc || typeof e.lat !== 'number' || typeof e.lon !== 'number') return;

  // Use region desc as the place ID (normalized)
  const placeId = e.desc.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  upsertPlace({
    id: placeId,
    name: e.desc,
    lat: e.lat,
    lon: e.lon,
    radius: 100, // Default 100m radius
    type: 'region', // Mark as auto-created from OwnTracks region
  });

  logger.info({ placeId, name: e.desc, lat: e.lat, lon: e.lon }, 'Auto-created place from OwnTracks region');
}

function maybeEnqueueTransitionNudge(userId: string, e: OwnTracksPayload): void {
  if (!e.event || !e.desc) return;

  const key = `${e.event}:${e.desc}`;
  if (wasNudgedRecently(userId, key, NUDGE_THROTTLE_SEC)) return;
  if (isQuietHours(new Date())) return;

  const verb = e.event === 'enter' ? 'arrived at' : 'left';
  const nowIso = new Date().toISOString();
  const santiago = new Date().toLocaleString('es-CL', { timeZone: QUIET_HOURS_TZ });
  const loc = getCurrentLocation(userId);
  const contextLine = loc && loc.region
    ? `They are now at: ${loc.region}.`
    : `They are now out.`;

  const title = `Location transition: ${e.event} ${e.desc}`;
  const prompt = [
    `Chris just ${verb} "${e.desc}" (OwnTracks transition event).`,
    contextLine,
    `Server time: ${nowIso}. Santiago time: ${santiago}.`,
    ``,
    `Decide whether to send a short, proactive Telegram nudge.`,
    `- Only notify if you have a concrete, time-sensitive reason (pending task tied to this place, calendar conflict, habit reminder, errand on the way).`,
    `- Do NOT acknowledge the transition itself. He knows he moved.`,
    `- If nothing is worth sending, respond with the single word "skip" and take no action.`,
    `- If you do notify, keep it to one short sentence sent via the normal Telegram reply path.`,
  ].join('\n');

  createMissionTask(crypto.randomUUID(), title, prompt, 'main', 'owntracks', 3);
  markNudged(userId, key);
  logger.info({ event: e.event, region: e.desc }, 'OwnTracks transition nudge enqueued');
}

export { DEFAULT_USER_ID };
