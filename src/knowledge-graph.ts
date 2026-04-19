import Database from 'better-sqlite3';
import fs from 'fs';

import { cosineSimilarity, embedText } from './embeddings.js';

export interface KGEntity {
  id: number;
  chat_id: string;
  name: string;
  entity_type: string;
  importance: number;
  salience: number;
  embedding: string | null;
  notion_page_id: string | null;
  notion_synced_at: number | null;
  created_at: number;
  accessed_at: number;
}

export interface KGObservation {
  id: number;
  entity_id: number;
  content: string;
  embedding: string | null;
  created_at: number;
  agent_id: string;
}

export interface KGRelation {
  id: number;
  chat_id: string;
  from_entity_id: number;
  to_entity_id: number;
  relation_type: string;
  created_at: number;
}

export interface EntityWithObservations {
  name: string;
  entityType: string;
  importance: number;
  observations: string[];
}

export interface RelationView {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeHit {
  entityId: number;
  entityName: string;
  entityType: string;
  content: string;
  score: number;
  agentId: string;
}

// ── Schema ───────────────────────────────────────────────────────────

const KG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS kg_entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    entity_type TEXT NOT NULL DEFAULT 'unknown',
    importance  REAL NOT NULL DEFAULT 0.5,
    salience    REAL NOT NULL DEFAULT 1.0,
    embedding   TEXT,
    created_at  INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL,
    UNIQUE(chat_id, name)
  );

  CREATE INDEX IF NOT EXISTS idx_kg_entities_chat ON kg_entities(chat_id, name);
  CREATE INDEX IF NOT EXISTS idx_kg_entities_salience ON kg_entities(chat_id, salience DESC);

  CREATE TABLE IF NOT EXISTS kg_observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id   INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    embedding   TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(entity_id, content)
  );

  CREATE INDEX IF NOT EXISTS idx_kg_observations_entity ON kg_observations(entity_id);

  CREATE TABLE IF NOT EXISTS kg_relations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id         TEXT NOT NULL,
    from_entity_id  INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    to_entity_id    INTEGER NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
    relation_type   TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    UNIQUE(chat_id, from_entity_id, to_entity_id, relation_type)
  );

  CREATE INDEX IF NOT EXISTS idx_kg_relations_chat ON kg_relations(chat_id);
  CREATE INDEX IF NOT EXISTS idx_kg_relations_from ON kg_relations(from_entity_id);
  CREATE INDEX IF NOT EXISTS idx_kg_relations_to ON kg_relations(to_entity_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS kg_entities_fts USING fts5(
    name,
    entity_type,
    content=kg_entities,
    content_rowid=id
  );

  CREATE TRIGGER IF NOT EXISTS kg_entities_fts_insert AFTER INSERT ON kg_entities BEGIN
    INSERT INTO kg_entities_fts(rowid, name, entity_type)
      VALUES (new.id, new.name, new.entity_type);
  END;

  CREATE TRIGGER IF NOT EXISTS kg_entities_fts_delete AFTER DELETE ON kg_entities BEGIN
    INSERT INTO kg_entities_fts(kg_entities_fts, rowid, name, entity_type)
      VALUES ('delete', old.id, old.name, old.entity_type);
  END;

  CREATE TRIGGER IF NOT EXISTS kg_entities_fts_update AFTER UPDATE ON kg_entities BEGIN
    INSERT INTO kg_entities_fts(kg_entities_fts, rowid, name, entity_type)
      VALUES ('delete', old.id, old.name, old.entity_type);
    INSERT INTO kg_entities_fts(rowid, name, entity_type)
      VALUES (new.id, new.name, new.entity_type);
  END;

  CREATE VIRTUAL TABLE IF NOT EXISTS kg_observations_fts USING fts5(
    content,
    content=kg_observations,
    content_rowid=id
  );

  CREATE TRIGGER IF NOT EXISTS kg_obs_fts_insert AFTER INSERT ON kg_observations BEGIN
    INSERT INTO kg_observations_fts(rowid, content)
      VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS kg_obs_fts_delete AFTER DELETE ON kg_observations BEGIN
    INSERT INTO kg_observations_fts(kg_observations_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS kg_obs_fts_update AFTER UPDATE ON kg_observations BEGIN
    INSERT INTO kg_observations_fts(kg_observations_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    INSERT INTO kg_observations_fts(rowid, content)
      VALUES (new.id, new.content);
  END;
`;

// ── Migrations ───────────────────────────────────────────────────────

function hasColumn(database: Database.Database, table: string, column: string): boolean {
  const cols = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function runMigrations(database: Database.Database): void {
  if (!hasColumn(database, 'kg_entities', 'notion_page_id')) {
    database.exec('ALTER TABLE kg_entities ADD COLUMN notion_page_id TEXT');
  }
  if (!hasColumn(database, 'kg_entities', 'notion_synced_at')) {
    database.exec('ALTER TABLE kg_entities ADD COLUMN notion_synced_at INTEGER');
  }
  // agent_id: tracks which agent originated the entity/observation so retrieval
  // can boost the current agent's own knowledge without hiding cross-agent data.
  if (!hasColumn(database, 'kg_entities', 'agent_id')) {
    database.exec("ALTER TABLE kg_entities ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'");
  }
  if (!hasColumn(database, 'kg_observations', 'agent_id')) {
    database.exec("ALTER TABLE kg_observations ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'");
  }
}

// ── DB Access ────────────────────────────────────────────────────────

let db: Database.Database | null = null;

/**
 * Initialize the knowledge graph tables on an existing database connection.
 * Called from initDatabase() in db.ts for the bot process.
 */
export function initKnowledgeGraph(database: Database.Database): void {
  db = database;
  database.exec(KG_SCHEMA);
  runMigrations(database);
}

/**
 * Open a standalone connection to the DB. Used by the MCP server process.
 * Enables WAL mode and busy_timeout for concurrent access.
 */
export function openStandaloneDb(dbPath: string): Database.Database {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  const conn = new Database(dbPath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  conn.exec(KG_SCHEMA);
  runMigrations(conn);
  db = conn;
  return conn;
}

function getDb(): Database.Database {
  if (!db) throw new Error('Knowledge graph not initialized. Call initKnowledgeGraph() first.');
  return db;
}

// ── Entity CRUD ──────────────────────────────────────────────────────

export function createEntity(
  chatId: string,
  name: string,
  entityType: string,
  importance = 0.5,
  observations: string[] = [],
  agentId: string = 'main',
): KGEntity {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  d.prepare(`
    INSERT INTO kg_entities (chat_id, name, entity_type, importance, created_at, accessed_at, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, name) DO UPDATE SET
      entity_type = excluded.entity_type,
      importance = MAX(kg_entities.importance, excluded.importance),
      accessed_at = excluded.accessed_at
  `).run(chatId, name, entityType, importance, now, now, agentId);
  const entity = d.prepare('SELECT * FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, name) as KGEntity;
  if (observations.length > 0) {
    addObservations(entity.id, observations, agentId);
  }
  return entity;
}

export function addObservations(
  entityId: number,
  observations: string[],
  agentId: string = 'main',
): KGObservation[] {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const results: KGObservation[] = [];
  const stmt = d.prepare(`
    INSERT INTO kg_observations (entity_id, content, created_at, agent_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(entity_id, content) DO NOTHING
  `);
  for (const content of observations) {
    if (!content.trim()) continue;
    const info = stmt.run(entityId, content.trim(), now, agentId);
    if (info.changes > 0) {
      const obs = d.prepare('SELECT * FROM kg_observations WHERE id = ?').get(info.lastInsertRowid) as KGObservation;
      results.push(obs);
    }
  }
  touchEntity(entityId);
  return results;
}

export function deleteEntity(chatId: string, name: string): boolean {
  const d = getDb();
  const result = d.prepare('DELETE FROM kg_entities WHERE chat_id = ? AND name = ?').run(chatId, name);
  return result.changes > 0;
}

export function deleteObservations(entityName: string, chatId: string, observations: string[]): number {
  const d = getDb();
  const entity = d.prepare('SELECT id FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, entityName) as { id: number } | undefined;
  if (!entity) return 0;
  let deleted = 0;
  const stmt = d.prepare('DELETE FROM kg_observations WHERE entity_id = ? AND content = ?');
  for (const content of observations) {
    const result = stmt.run(entity.id, content.trim());
    deleted += result.changes;
  }
  return deleted;
}

// ── Relation CRUD ────────────────────────────────────────────────────

export function createRelation(
  chatId: string,
  fromName: string,
  toName: string,
  relationType: string,
): KGRelation | null {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const fromEntity = d.prepare('SELECT id FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, fromName) as { id: number } | undefined;
  const toEntity = d.prepare('SELECT id FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, toName) as { id: number } | undefined;
  if (!fromEntity || !toEntity) return null;
  d.prepare(`
    INSERT INTO kg_relations (chat_id, from_entity_id, to_entity_id, relation_type, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, from_entity_id, to_entity_id, relation_type) DO NOTHING
  `).run(chatId, fromEntity.id, toEntity.id, relationType, now);
  return d.prepare(`
    SELECT * FROM kg_relations
    WHERE chat_id = ? AND from_entity_id = ? AND to_entity_id = ? AND relation_type = ?
  `).get(chatId, fromEntity.id, toEntity.id, relationType) as KGRelation;
}

export function deleteRelation(
  chatId: string,
  fromName: string,
  toName: string,
  relationType: string,
): boolean {
  const d = getDb();
  const fromEntity = d.prepare('SELECT id FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, fromName) as { id: number } | undefined;
  const toEntity = d.prepare('SELECT id FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, toName) as { id: number } | undefined;
  if (!fromEntity || !toEntity) return false;
  const result = d.prepare(
    'DELETE FROM kg_relations WHERE chat_id = ? AND from_entity_id = ? AND to_entity_id = ? AND relation_type = ?'
  ).run(chatId, fromEntity.id, toEntity.id, relationType);
  return result.changes > 0;
}

// ── Graph Reads ──────────────────────────────────────────────────────

export function readGraph(chatId: string): {
  entities: EntityWithObservations[];
  relations: RelationView[];
} {
  const d = getDb();
  const entities = d.prepare(
    'SELECT * FROM kg_entities WHERE chat_id = ? ORDER BY importance DESC, accessed_at DESC'
  ).all(chatId) as KGEntity[];
  const result: EntityWithObservations[] = [];
  for (const e of entities) {
    const obs = d.prepare('SELECT content FROM kg_observations WHERE entity_id = ? ORDER BY created_at DESC').all(e.id) as Array<{ content: string }>;
    result.push({
      name: e.name,
      entityType: e.entity_type,
      importance: e.importance,
      observations: obs.map((o) => o.content),
    });
  }
  const rels = d.prepare(`
    SELECT
      ef.name as "from",
      et.name as "to",
      r.relation_type as relationType
    FROM kg_relations r
    JOIN kg_entities ef ON r.from_entity_id = ef.id
    JOIN kg_entities et ON r.to_entity_id = et.id
    WHERE r.chat_id = ?
    ORDER BY r.created_at DESC
  `).all(chatId) as RelationView[];
  return { entities: result, relations: rels };
}

export function openNodes(chatId: string, names: string[]): EntityWithObservations[] {
  const d = getDb();
  const results: EntityWithObservations[] = [];
  for (const name of names) {
    const entity = d.prepare('SELECT * FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, name) as KGEntity | undefined;
    if (!entity) continue;
    touchEntity(entity.id);
    const obs = d.prepare('SELECT content FROM kg_observations WHERE entity_id = ? ORDER BY created_at DESC').all(entity.id) as Array<{ content: string }>;
    results.push({
      name: entity.name,
      entityType: entity.entity_type,
      importance: entity.importance,
      observations: obs.map((o) => o.content),
    });
  }
  return results;
}

export function searchNodes(chatId: string, query: string, limit = 10): EntityWithObservations[] {
  const d = getDb();
  const ftsQuery = query.replace(/[^\w\s]/g, '').trim();
  let entityIds: number[] = [];

  if (ftsQuery) {
    const ftsTerms = ftsQuery.split(/\s+/).map((w) => `"${w}"*`).join(' OR ');
    try {
      const ftsResults = d.prepare(`
        SELECT kg_entities.id FROM kg_entities
        JOIN kg_entities_fts ON kg_entities.id = kg_entities_fts.rowid
        WHERE kg_entities_fts MATCH ? AND kg_entities.chat_id = ?
        LIMIT ?
      `).all(ftsTerms, chatId, limit) as Array<{ id: number }>;
      entityIds = ftsResults.map((r) => r.id);
    } catch {
      // FTS query might fail on special chars, fall through
    }
  }

  if (entityIds.length < limit && ftsQuery) {
    const ftsTerms = ftsQuery.split(/\s+/).map((w) => `"${w}"*`).join(' OR ');
    try {
      const obsResults = d.prepare(`
        SELECT DISTINCT kg_observations.entity_id FROM kg_observations
        JOIN kg_observations_fts ON kg_observations.id = kg_observations_fts.rowid
        JOIN kg_entities ON kg_observations.entity_id = kg_entities.id
        WHERE kg_observations_fts MATCH ? AND kg_entities.chat_id = ?
        LIMIT ?
      `).all(ftsTerms, chatId, limit) as Array<{ entity_id: number }>;
      for (const r of obsResults) {
        if (!entityIds.includes(r.entity_id)) entityIds.push(r.entity_id);
      }
    } catch {
      // FTS fallback
    }
  }

  if (entityIds.length === 0) {
    const pattern = `%${query.replace(/[%_]/g, '')}%`;
    const likeResults = d.prepare(`
      SELECT id FROM kg_entities
      WHERE chat_id = ? AND (name LIKE ? OR entity_type LIKE ?)
      LIMIT ?
    `).all(chatId, pattern, pattern, limit) as Array<{ id: number }>;
    entityIds = likeResults.map((r) => r.id);
    if (entityIds.length < limit) {
      const obsLike = d.prepare(`
        SELECT DISTINCT entity_id FROM kg_observations
        JOIN kg_entities ON kg_observations.entity_id = kg_entities.id
        WHERE kg_entities.chat_id = ? AND kg_observations.content LIKE ?
        LIMIT ?
      `).all(chatId, pattern, limit) as Array<{ entity_id: number }>;
      for (const r of obsLike) {
        if (!entityIds.includes(r.entity_id)) entityIds.push(r.entity_id);
      }
    }
  }

  const results: EntityWithObservations[] = [];
  for (const id of entityIds.slice(0, limit)) {
    const entity = d.prepare('SELECT * FROM kg_entities WHERE id = ?').get(id) as KGEntity | undefined;
    if (!entity) continue;
    touchEntity(entity.id);
    const obs = d.prepare('SELECT content FROM kg_observations WHERE entity_id = ? ORDER BY created_at DESC').all(entity.id) as Array<{ content: string }>;
    results.push({
      name: entity.name,
      entityType: entity.entity_type,
      importance: entity.importance,
      observations: obs.map((o) => o.content),
    });
  }
  return results;
}

/**
 * Semantic search using embeddings. Returns entities whose embeddings
 * (or whose observations' embeddings) are closest to the query embedding.
 */
export async function searchNodesSemantic(
  chatId: string,
  query: string,
  limit = 10,
): Promise<EntityWithObservations[]> {
  const d = getDb();
  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(query);
  } catch {
    return searchNodes(chatId, query, limit);
  }
  if (queryEmbedding.length === 0) return searchNodes(chatId, query, limit);

  // Cap the candidate set so a cold MCP invocation never loads ~9k embeddings.
  // Ordering by salience × importance keeps the most useful entries and bounds
  // the memory spike (~12MB at 2000 rows vs ~120MB at 9000).
  const MAX_CANDIDATES = parseInt(process.env.KG_CACHE_MAX_ROWS || '2000', 10);

  const entities = d.prepare(
    `SELECT id, name, entity_type, importance, salience, embedding FROM kg_entities
     WHERE chat_id = ? AND embedding IS NOT NULL
     ORDER BY (salience * importance) DESC
     LIMIT ?`
  ).all(chatId, MAX_CANDIDATES) as Array<Pick<KGEntity, 'id' | 'name' | 'entity_type' | 'importance' | 'salience' | 'embedding'>>;

  const scored: Array<{ id: number; score: number }> = [];
  for (const e of entities) {
    if (!e.embedding) continue;
    const emb = JSON.parse(e.embedding) as number[];
    const score = cosineSimilarity(queryEmbedding, emb);
    if (score > 0.3) scored.push({ id: e.id, score });
  }

  const obsRows = d.prepare(`
    SELECT o.entity_id, o.embedding FROM kg_observations o
    JOIN kg_entities e ON o.entity_id = e.id
    WHERE e.chat_id = ? AND o.embedding IS NOT NULL
    ORDER BY (e.salience * e.importance) DESC, o.created_at DESC
    LIMIT ?
  `).all(chatId, MAX_CANDIDATES) as Array<{ entity_id: number; embedding: string }>;

  for (const o of obsRows) {
    const emb = JSON.parse(o.embedding) as number[];
    const score = cosineSimilarity(queryEmbedding, emb);
    if (score > 0.3) {
      const existing = scored.find((s) => s.id === o.entity_id);
      if (existing) existing.score = Math.max(existing.score, score);
      else scored.push({ id: o.entity_id, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topIds = scored.slice(0, limit).map((s) => s.id);
  if (topIds.length === 0) return searchNodes(chatId, query, limit);

  const results: EntityWithObservations[] = [];
  // Batch-update accessed_at + salience in a single write instead of N round-trips.
  // Previously N touchEntity calls contended with live bot writes and could stall.
  const now = Math.floor(Date.now() / 1000);
  const placeholders = topIds.map(() => '?').join(',');
  try {
    d.prepare(
      `UPDATE kg_entities SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0)
       WHERE id IN (${placeholders})`
    ).run(now, ...topIds);
  } catch { /* touch is advisory; don't fail the read */ }

  for (const id of topIds) {
    const entity = d.prepare('SELECT * FROM kg_entities WHERE id = ?').get(id) as KGEntity | undefined;
    if (!entity) continue;
    const obs = d.prepare('SELECT content FROM kg_observations WHERE entity_id = ? ORDER BY created_at DESC LIMIT 10').all(entity.id) as Array<{ content: string }>;
    results.push({
      name: entity.name,
      entityType: entity.entity_type,
      importance: entity.importance,
      observations: obs.map((o) => o.content),
    });
  }
  return results;
}

/**
 * In-memory cache of parsed KG embeddings per chat_id. Parsing ~9,000 JSON
 * embedding strings takes 1-2s per call; caching the Float arrays drops warm
 * retrieval to ~30-50ms. Invalidated when row count or max observation id
 * changes (covers inserts + deletes without timestamps).
 */
interface KGCacheEntry {
  rows: Array<{
    entityId: number;
    entityName: string;
    entityType: string;
    content: string;
    salience: number;
    importance: number;
    obsEmbedding: number[] | null;
    entityEmbedding: number[] | null;
    obsAgent: string;
    entityAgent: string;
  }>;
  builtAt: number;
  rowSig: string;
}

const kgCache = new Map<string, KGCacheEntry>();
const KG_CACHE_TTL_MS = 5 * 60 * 1000;
// Each parsed embedding is a 768-float array (~6KB after JS overhead).
// 2000 rows × 6KB ≈ 12MB per agent process. With 5 agent processes on a
// 15GB VPS that's ~60MB total — safe even when Claude Code subprocesses
// balloon concurrently. Lower-salience entries are reachable via the MCP
// search_nodes tool when the agent explicitly needs deep recall.
const KG_CACHE_MAX_ROWS = parseInt(process.env.KG_CACHE_MAX_ROWS || '2000', 10);

function getKGCache(chatId: string): KGCacheEntry {
  const d = getDb();
  const sig = d.prepare(
    'SELECT COUNT(*) AS c, COALESCE(MAX(o.id), 0) AS m FROM kg_observations o JOIN kg_entities e ON o.entity_id = e.id WHERE e.chat_id = ?'
  ).get(chatId) as { c: number; m: number };
  const rowSig = `${sig.c}:${sig.m}:${KG_CACHE_MAX_ROWS}`;

  const cached = kgCache.get(chatId);
  if (cached && cached.rowSig === rowSig && Date.now() - cached.builtAt < KG_CACHE_TTL_MS) {
    return cached;
  }

  // Load only the highest-value observations: rank by entity salience × importance,
  // then by observation recency. Cold misses for low-priority entities fall back
  // to the MCP search_nodes tool, which reads directly from disk.
  const rows = d.prepare(`
    SELECT
      o.content,
      o.embedding AS obs_embedding,
      o.agent_id AS obs_agent,
      e.id AS entity_id,
      e.name AS entity_name,
      e.entity_type,
      e.salience,
      e.importance,
      e.embedding AS entity_embedding,
      e.agent_id AS entity_agent
    FROM kg_observations o
    JOIN kg_entities e ON o.entity_id = e.id
    WHERE e.chat_id = ?
    ORDER BY (e.salience * e.importance) DESC, o.created_at DESC
    LIMIT ?
  `).all(chatId, KG_CACHE_MAX_ROWS) as Array<{
    content: string;
    obs_embedding: string | null;
    obs_agent: string;
    entity_id: number;
    entity_name: string;
    entity_type: string;
    salience: number;
    importance: number;
    entity_embedding: string | null;
    entity_agent: string;
  }>;

  const parsed = rows.map((r) => {
    let obsEmbedding: number[] | null = null;
    let entityEmbedding: number[] | null = null;
    if (r.obs_embedding) {
      try { obsEmbedding = JSON.parse(r.obs_embedding) as number[]; } catch { /* malformed */ }
    }
    if (r.entity_embedding) {
      try { entityEmbedding = JSON.parse(r.entity_embedding) as number[]; } catch { /* malformed */ }
    }
    return {
      entityId: r.entity_id,
      entityName: r.entity_name,
      entityType: r.entity_type,
      content: r.content,
      salience: r.salience,
      importance: r.importance,
      obsEmbedding,
      entityEmbedding,
      obsAgent: r.obs_agent,
      entityAgent: r.entity_agent,
    };
  });

  const entry: KGCacheEntry = { rows: parsed, builtAt: Date.now(), rowSig };
  kgCache.set(chatId, entry);
  return entry;
}

/** Invalidate the cached KG index for a chat. Call after bulk writes. */
export function invalidateKnowledgeCache(chatId?: string): void {
  if (chatId) kgCache.delete(chatId);
  else kgCache.clear();
}

/**
 * Fast KG retrieval for inline use inside buildMemoryContext.
 * Takes a pre-computed query embedding (avoids a second API call per turn),
 * scores observation+entity embeddings, applies a soft agent-id boost so the
 * calling agent's own knowledge ranks slightly higher without hiding the rest.
 */
export function searchKnowledgeSemantic(
  chatId: string,
  queryEmbedding: number[],
  limit: number = 5,
  currentAgentId: string = 'main',
): KnowledgeHit[] {
  if (queryEmbedding.length === 0) return [];

  const cache = getKGCache(chatId);
  const hits: KnowledgeHit[] = [];

  for (const r of cache.rows) {
    let best = 0;
    if (r.obsEmbedding) {
      best = cosineSimilarity(queryEmbedding, r.obsEmbedding);
    }
    if (best < 0.3 && r.entityEmbedding) {
      const entScore = cosineSimilarity(queryEmbedding, r.entityEmbedding);
      if (entScore > best) best = entScore;
    }
    if (best < 0.3) continue;

    const salienceWeight = Math.sqrt(Math.max(0.05, r.salience));
    const agentBoost = r.obsAgent === currentAgentId || r.entityAgent === currentAgentId ? 1.3 : 1.0;
    const score = best * salienceWeight * agentBoost;

    hits.push({
      entityId: r.entityId,
      entityName: r.entityName,
      entityType: r.entityType,
      content: r.content,
      score,
      agentId: r.obsAgent,
    });
  }

  hits.sort((a, b) => b.score - a.score);

  // Dedup by entityId (one observation per entity for context compactness)
  const seen = new Set<number>();
  const deduped: KnowledgeHit[] = [];
  for (const h of hits) {
    if (seen.has(h.entityId)) continue;
    seen.add(h.entityId);
    deduped.push(h);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

// ── Maintenance ──────────────────────────────────────────────────────

export function touchEntity(entityId: number): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(
    'UPDATE kg_entities SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?'
  ).run(now, entityId);
}

/**
 * Decay entity salience based on importance tiers.
 * Entities with salience < 0.05 are deleted (CASCADE removes obs + rels).
 */
export function decayEntities(): { decayed: number; deleted: number } {
  const d = getDb();
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  const decayResult = d.prepare(`
    UPDATE kg_entities SET salience = salience * CASE
      WHEN importance >= 0.8 THEN 0.99
      WHEN importance >= 0.5 THEN 0.98
      ELSE 0.95
    END
    WHERE created_at < ?
  `).run(oneDayAgo);
  const deleteResult = d.prepare('DELETE FROM kg_entities WHERE salience < 0.05').run();
  return { decayed: decayResult.changes, deleted: deleteResult.changes };
}

// ── Notion Sync ──────────────────────────────────────────────────────

export function markSyncedToNotion(chatId: string, entityName: string, notionPageId: string): boolean {
  const d = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = d.prepare(`
    UPDATE kg_entities SET notion_page_id = ?, notion_synced_at = ?
    WHERE chat_id = ? AND name = ?
  `).run(notionPageId, now, chatId, entityName);
  return result.changes > 0;
}

export function getUnsyncedEntities(
  chatId: string,
  minImportance = 0.7,
  limit = 20,
): Array<EntityWithObservations & { id: number; notion_page_id: string | null }> {
  const d = getDb();
  const entities = d.prepare(`
    SELECT * FROM kg_entities
    WHERE chat_id = ? AND importance >= ?
      AND (notion_synced_at IS NULL OR accessed_at > notion_synced_at)
    ORDER BY importance DESC, accessed_at DESC
    LIMIT ?
  `).all(chatId, minImportance, limit) as KGEntity[];
  return entities.map((e) => {
    const obs = d.prepare('SELECT content FROM kg_observations WHERE entity_id = ? ORDER BY created_at DESC').all(e.id) as Array<{ content: string }>;
    return {
      id: e.id,
      name: e.name,
      entityType: e.entity_type,
      importance: e.importance,
      observations: obs.map((o) => o.content),
      notion_page_id: e.notion_page_id,
    };
  });
}

export function saveEntityEmbedding(entityId: number, embedding: number[]): void {
  getDb().prepare('UPDATE kg_entities SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), entityId);
}

export function saveObservationEmbedding(observationId: number, embedding: number[]): void {
  getDb().prepare('UPDATE kg_observations SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), observationId);
}

export function getIsolatedEntities(chatId: string, maxRelations = 1, limit = 20): KGEntity[] {
  return getDb().prepare(`
    SELECT e.* FROM kg_entities e
    LEFT JOIN (
      SELECT from_entity_id as eid, COUNT(*) as cnt FROM kg_relations WHERE chat_id = ? GROUP BY from_entity_id
      UNION ALL
      SELECT to_entity_id as eid, COUNT(*) as cnt FROM kg_relations WHERE chat_id = ? GROUP BY to_entity_id
    ) rc ON e.id = rc.eid
    WHERE e.chat_id = ? AND COALESCE(rc.cnt, 0) <= ?
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(chatId, chatId, chatId, maxRelations, limit) as KGEntity[];
}

export function getAllEntityNames(chatId: string): Array<{ id: number; name: string; entity_type: string }> {
  return getDb().prepare(
    'SELECT id, name, entity_type FROM kg_entities WHERE chat_id = ? ORDER BY name'
  ).all(chatId) as Array<{ id: number; name: string; entity_type: string }>;
}

export function mergeEntities(chatId: string, targetName: string, sourceName: string): boolean {
  const d = getDb();
  const target = d.prepare('SELECT id FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, targetName) as { id: number } | undefined;
  const source = d.prepare('SELECT id FROM kg_entities WHERE chat_id = ? AND name = ?').get(chatId, sourceName) as { id: number } | undefined;
  if (!target || !source) return false;
  d.prepare('UPDATE OR IGNORE kg_observations SET entity_id = ? WHERE entity_id = ?').run(target.id, source.id);
  d.prepare('UPDATE OR IGNORE kg_relations SET from_entity_id = ? WHERE from_entity_id = ? AND chat_id = ?').run(target.id, source.id, chatId);
  d.prepare('UPDATE OR IGNORE kg_relations SET to_entity_id = ? WHERE to_entity_id = ? AND chat_id = ?').run(target.id, source.id, chatId);
  d.prepare('DELETE FROM kg_entities WHERE id = ?').run(source.id);
  return true;
}

export function getInsights(chatId: string): {
  entityCount: number;
  relationCount: number;
  observationCount: number;
  topEntities: Array<{ name: string; entityType: string; importance: number; relationCount: number; observationCount: number }>;
  recentEntities: Array<{ name: string; entityType: string; createdAt: number }>;
  entityTypes: Array<{ type: string; count: number }>;
} {
  const d = getDb();
  const entityCount = (d.prepare('SELECT COUNT(*) as cnt FROM kg_entities WHERE chat_id = ?').get(chatId) as { cnt: number }).cnt;
  const relationCount = (d.prepare('SELECT COUNT(*) as cnt FROM kg_relations WHERE chat_id = ?').get(chatId) as { cnt: number }).cnt;
  const observationCount = (d.prepare(`
    SELECT COUNT(*) as cnt FROM kg_observations o
    JOIN kg_entities e ON o.entity_id = e.id
    WHERE e.chat_id = ?
  `).get(chatId) as { cnt: number }).cnt;
  const topEntities = d.prepare(`
    SELECT
      e.name,
      e.entity_type as entityType,
      e.importance,
      (SELECT COUNT(*) FROM kg_relations WHERE from_entity_id = e.id OR to_entity_id = e.id) as relationCount,
      (SELECT COUNT(*) FROM kg_observations WHERE entity_id = e.id) as observationCount
    FROM kg_entities e
    WHERE e.chat_id = ?
    ORDER BY e.importance DESC, relationCount DESC
    LIMIT 10
  `).all(chatId) as Array<{ name: string; entityType: string; importance: number; relationCount: number; observationCount: number }>;
  const recentEntities = d.prepare(`
    SELECT name, entity_type as entityType, created_at as createdAt
    FROM kg_entities WHERE chat_id = ?
    ORDER BY created_at DESC LIMIT 10
  `).all(chatId) as Array<{ name: string; entityType: string; createdAt: number }>;
  const entityTypes = d.prepare(`
    SELECT entity_type as type, COUNT(*) as count
    FROM kg_entities WHERE chat_id = ?
    GROUP BY entity_type ORDER BY count DESC
  `).all(chatId) as Array<{ type: string; count: number }>;
  return { entityCount, relationCount, observationCount, topEntities, recentEntities, entityTypes };
}
