/**
 * Backfill embeddings for kg_observations, kg_entities, and memories.
 *
 * Reads rows where embedding IS NULL, generates embeddings in batches,
 * and writes them back. Safe to run while the bot is live (WAL mode).
 *
 * Usage: npx tsx scripts/backfill-kg-embeddings.ts [--dry-run] [--limit N]
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

import { embedTextBatch } from '../src/embeddings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', 'store', 'claudeclaw.db');

const BATCH_SIZE = 40;
const PROGRESS_EVERY = 5;
const INTER_BATCH_MS = 1000; // ~40/s = 2400/min, well under 3000/min quota
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractRetryDelayMs(err: unknown): number | null {
  try {
    const msg = (err as Error).message ?? '';
    const parsed = JSON.parse(msg);
    const details = parsed?.error?.details ?? [];
    for (const d of details) {
      if (d['@type']?.includes('RetryInfo') && d.retryDelay) {
        const match = /^([\d.]+)s$/.exec(d.retryDelay);
        if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 500;
      }
    }
    if (parsed?.error?.code === 429) return 25000;
  } catch {
    if (/\b429\b|RESOURCE_EXHAUSTED/.test(String((err as Error).message ?? ''))) return 25000;
  }
  return null;
}

interface Row {
  id: number;
  content: string;
}

interface JobConfig {
  label: string;
  selectSql: string;
  updateSql: string;
  contentCol: string;
}

const jobs: JobConfig[] = [
  {
    label: 'kg_observations',
    selectSql: 'SELECT id, content FROM kg_observations WHERE embedding IS NULL',
    updateSql: 'UPDATE kg_observations SET embedding = ? WHERE id = ?',
    contentCol: 'content',
  },
  {
    label: 'kg_entities',
    selectSql: "SELECT id, name || ' (' || entity_type || ')' AS content FROM kg_entities WHERE embedding IS NULL",
    updateSql: 'UPDATE kg_entities SET embedding = ? WHERE id = ?',
    contentCol: 'content',
  },
  {
    label: 'memories',
    selectSql: 'SELECT id, COALESCE(summary, raw_text) AS content FROM memories WHERE embedding IS NULL',
    updateSql: 'UPDATE memories SET embedding = ? WHERE id = ?',
    contentCol: 'content',
  },
];

async function runJob(
  db: Database.Database,
  job: JobConfig,
  opts: { dryRun: boolean; limit?: number },
): Promise<{ processed: number; failed: number }> {
  const rows = db.prepare(job.selectSql).all() as Row[];
  const toProcess = opts.limit ? rows.slice(0, opts.limit) : rows;

  if (toProcess.length === 0) {
    console.log(`[${job.label}] nothing to backfill`);
    return { processed: 0, failed: 0 };
  }

  console.log(`[${job.label}] ${toProcess.length} rows to embed`);

  if (opts.dryRun) {
    console.log(`[${job.label}] dry-run: skipping API calls`);
    return { processed: 0, failed: 0 };
  }

  const updateStmt = db.prepare(job.updateSql);
  const txn = db.transaction((items: Array<{ id: number; embedding: string }>) => {
    for (const item of items) updateStmt.run(item.embedding, item.id);
  });

  let processed = 0;
  let failed = 0;
  const start = Date.now();

  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => (r.content || '').slice(0, 8000));

    let attempt = 0;
    let success = false;
    while (attempt <= MAX_RETRIES && !success) {
      try {
        const embeddings = await embedTextBatch(texts);
        const writes = batch.map((r, idx) => ({
          id: r.id,
          embedding: JSON.stringify(embeddings[idx] ?? []),
        })).filter((w) => w.embedding !== '[]');

        txn(writes);
        processed += writes.length;
        failed += batch.length - writes.length;
        success = true;
      } catch (err) {
        const retryMs = extractRetryDelayMs(err);
        if (retryMs && attempt < MAX_RETRIES) {
          console.log(`[${job.label}] batch ${i}-${i + batch.length} 429, waiting ${Math.round(retryMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await sleep(retryMs);
          attempt++;
          continue;
        }
        console.error(`[${job.label}] batch ${i}-${i + batch.length} failed after ${attempt + 1} attempts:`, (err as Error).message.slice(0, 200));
        failed += batch.length;
        break;
      }
    }

    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
    if (batchIndex % PROGRESS_EVERY === 0 || i + BATCH_SIZE >= toProcess.length) {
      const pct = Math.round(((i + batch.length) / toProcess.length) * 100);
      const elapsed = Math.round((Date.now() - start) / 1000);
      console.log(`[${job.label}] ${i + batch.length}/${toProcess.length} (${pct}%) in ${elapsed}s`);
    }

    if (i + BATCH_SIZE < toProcess.length) await sleep(INTER_BATCH_MS);
  }

  return { processed, failed };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : undefined;
  const only = args.find((a) => a.startsWith('--only='))?.slice(7);

  console.log(`DB: ${DB_PATH}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}${limit ? ` (limit ${limit})` : ''}${only ? ` (only ${only})` : ''}`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  const totals = { processed: 0, failed: 0 };
  for (const job of jobs) {
    if (only && job.label !== only) continue;
    const res = await runJob(db, job, { dryRun, limit });
    totals.processed += res.processed;
    totals.failed += res.failed;
  }

  console.log(`\nDone. Processed: ${totals.processed}, Failed: ${totals.failed}`);
  db.close();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
