import type Database from 'better-sqlite3';

import { GOOGLE_API_KEY } from './config.js';
import { getDbInstance } from './db.js';
import { embedTextBatch } from './embeddings.js';
import { invalidateKnowledgeCache } from './knowledge-graph.js';
import { logger } from './logger.js';

/**
 * Async embedding worker. Periodically sweeps rows with missing embeddings
 * (memories, kg_observations, kg_entities, consolidations) and backfills them
 * in batches. Lets ingestion and KG writes proceed synchronously without
 * blocking on Gemini calls.
 *
 * Starts on bot boot, stops on shutdown. Idempotent: if the bot restarts mid-
 * sweep, next tick picks up the still-NULL rows.
 */

const BATCH_SIZE = 20;
const TICK_INTERVAL_MS = 30 * 1000;
const MAX_ATTEMPTS_PER_TICK = 3;

interface SweepTarget {
  label: string;
  select: string;
  update: string;
}

const TARGETS: SweepTarget[] = [
  {
    label: 'kg_observations',
    select: 'SELECT id, content AS text FROM kg_observations WHERE embedding IS NULL LIMIT ?',
    update: 'UPDATE kg_observations SET embedding = ? WHERE id = ?',
  },
  {
    label: 'kg_entities',
    select: "SELECT id, name || ' (' || entity_type || ')' AS text FROM kg_entities WHERE embedding IS NULL LIMIT ?",
    update: 'UPDATE kg_entities SET embedding = ? WHERE id = ?',
  },
  {
    label: 'memories',
    select: 'SELECT id, COALESCE(summary, raw_text) AS text FROM memories WHERE embedding IS NULL LIMIT ?',
    update: 'UPDATE memories SET embedding = ? WHERE id = ?',
  },
  {
    label: 'consolidations',
    select: "SELECT id, COALESCE(summary, '') || ' ' || COALESCE(insight, '') AS text FROM consolidations WHERE embedding IS NULL LIMIT ?",
    update: 'UPDATE consolidations SET embedding = ? WHERE id = ?',
  },
];

let timer: NodeJS.Timeout | null = null;
let busy = false;

async function sweepOnce(db: Database.Database): Promise<{ embedded: number; skipped: number }> {
  let embedded = 0;
  let skipped = 0;

  for (const target of TARGETS) {
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS_PER_TICK) {
      const rows = db.prepare(target.select).all(BATCH_SIZE) as Array<{ id: number; text: string }>;
      if (rows.length === 0) break;

      const texts = rows.map((r) => (r.text || '').slice(0, 8000));
      try {
        const embeddings = await embedTextBatch(texts);
        const writes: Array<{ id: number; embedding: string }> = [];
        for (let i = 0; i < rows.length; i++) {
          const vec = embeddings[i];
          if (!vec || vec.length === 0) {
            skipped++;
            continue;
          }
          writes.push({ id: rows[i].id, embedding: JSON.stringify(vec) });
        }
        if (writes.length > 0) {
          const stmt = db.prepare(target.update);
          const tx = db.transaction((items: Array<{ id: number; embedding: string }>) => {
            for (const w of items) stmt.run(w.embedding, w.id);
          });
          tx(writes);
          embedded += writes.length;
        }
      } catch (err) {
        // 429s are transient — next tick will retry. Log and stop this target.
        logger.debug({ err: (err as Error).message?.slice(0, 200), target: target.label }, 'Embedding worker tick failed');
        break;
      }

      attempts++;
      if (rows.length < BATCH_SIZE) break;
    }
  }

  if (embedded > 0) {
    invalidateKnowledgeCache();
    logger.info({ embedded, skipped }, 'Embedding worker sweep');
  }

  return { embedded, skipped };
}

export function startEmbeddingWorker(): void {
  if (timer) return;
  if (!GOOGLE_API_KEY) {
    logger.info('Embedding worker disabled (no GOOGLE_API_KEY)');
    return;
  }
  const db = getDbInstance();
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    sweepOnce(db)
      .catch((err) => logger.error({ err }, 'Embedding worker tick failed'))
      .finally(() => { busy = false; });
  }, TICK_INTERVAL_MS);
  if (typeof (timer as NodeJS.Timeout).unref === 'function') timer.unref();
  logger.info({ intervalMs: TICK_INTERVAL_MS, batchSize: BATCH_SIZE }, 'Embedding worker started');
}

export function stopEmbeddingWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Single-shot trigger (used for tests or ad-hoc invocation). */
export async function sweepEmbeddingsNow(): Promise<{ embedded: number; skipped: number }> {
  return sweepOnce(getDbInstance());
}
