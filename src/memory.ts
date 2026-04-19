import crypto from 'crypto';

import { agentObsidianConfig, GOOGLE_API_KEY } from './config.js';
import {
  batchUpdateMemoryRelevance,
  decayMemories,
  getAgentRecentConversation,
  getCachedEmbeddingFromDb,
  getConsolidationsWithEmbeddings,
  getOtherAgentActivity,
  getRecentConsolidations,
  getRecentHighImportanceMemories,
  getWorkingMemory,
  logConversationTurn,
  logRetrievalMetric,
  pruneConversationLog,
  pruneEmbeddingCache,
  pruneRetrievalMetrics,
  pruneSlackMessages,
  pruneWaMessages,
  saveCachedEmbeddingToDb,
  saveWorkingMemorySummary,
  searchConsolidations,
  searchConversationHistory,
  searchMemories,
} from './db.js';
import { cosineSimilarity, embedText } from './embeddings.js';
import { generateContent, parseJsonResponse } from './gemini.js';
import { decayEntities, invalidateKnowledgeCache, searchKnowledgeSemantic } from './knowledge-graph.js';
import { logger } from './logger.js';
import { ingestConversationTurn } from './memory-ingest.js';
import { buildObsidianContext } from './obsidian.js';

/**
 * Build a structured memory context string to prepend to the user's message.
 *
 * Three-layer retrieval:
 *   Layer 1: FTS5 keyword search on summary + raw_text + entities + topics (top 5)
 *   Layer 2: Recent high-importance memories (importance >= 0.5, top 5 by accessed_at)
 *   Layer 3: Relevant consolidation insights
 *
 * Deduplicates across layers. Returns formatted context with structure.
 */
export interface MemoryContextResult {
  contextText: string;
  surfacedMemoryIds: number[];
  surfacedMemorySummaries: Map<number, string>;
}

// Two-tier query embedding cache: in-process LRU for hot queries (0ms),
// backed by a DB table so repeats survive bot restarts (low-ms lookup).
const QUERY_CACHE_MAX = 200;
const QUERY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const queryEmbeddingCache = new Map<string, { embedding: number[]; ts: number }>();

function normalizeQueryForCache(q: string): string {
  return q.toLowerCase().trim().slice(0, 200);
}

function hashQuery(normalized: string): string {
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

async function getCachedQueryEmbedding(query: string): Promise<{ embedding: number[] | undefined; hash: string }> {
  const key = normalizeQueryForCache(query);
  const hash = hashQuery(key);

  if (!GOOGLE_API_KEY) return { embedding: undefined, hash };

  // Tier 1: in-process LRU
  const hit = queryEmbeddingCache.get(key);
  if (hit && Date.now() - hit.ts < QUERY_CACHE_TTL_MS) {
    queryEmbeddingCache.delete(key);
    queryEmbeddingCache.set(key, hit);
    logger.debug({ key: key.slice(0, 40) }, 'Embedding LRU hit');
    return { embedding: hit.embedding, hash };
  }

  // Tier 2: persistent DB cache
  try {
    const fromDb = getCachedEmbeddingFromDb(hash);
    if (fromDb && fromDb.length > 0) {
      queryEmbeddingCache.set(key, { embedding: fromDb, ts: Date.now() });
      logger.debug({ key: key.slice(0, 40) }, 'Embedding DB cache hit');
      return { embedding: fromDb, hash };
    }
  } catch { /* fall through to API */ }

  // Miss: call Gemini, write through to both tiers
  try {
    const embedding = await embedText(query);
    if (embedding.length === 0) return { embedding: undefined, hash };
    queryEmbeddingCache.set(key, { embedding, ts: Date.now() });
    if (queryEmbeddingCache.size > QUERY_CACHE_MAX) {
      const oldest = queryEmbeddingCache.keys().next().value;
      if (oldest !== undefined) queryEmbeddingCache.delete(oldest);
    }
    try { saveCachedEmbeddingToDb(hash, embedding); } catch { /* cache write is best-effort */ }
    return { embedding, hash };
  } catch {
    return { embedding: undefined, hash };
  }
}

// FTS5-first threshold: if keyword search returns >= this many memories,
// skip the embedding call and downstream KG+consolidation vector searches.
// Covers simple/common queries that don't need semantic expansion.
const FTS5_SUFFICIENCY = 3;

interface QueryComplexity {
  level: 'low' | 'medium' | 'high';
  memories: number;
  recent: number;
  consolidations: number;
  kg: number;
}

function computeComplexity(message: string): QueryComplexity {
  const words = message.trim().split(/\s+/).length;
  const hasQuestion = /\?|¿/.test(message);
  const conjunctions = (message.match(/\b(and|y|o|or|también|además|plus)\b/gi) || []).length;

  if (words > 80 || conjunctions > 2) {
    return { level: 'high', memories: 10, recent: 8, consolidations: 4, kg: 8 };
  }
  if (words > 25 || hasQuestion) {
    return { level: 'medium', memories: 5, recent: 5, consolidations: 2, kg: 5 };
  }
  return { level: 'low', memories: 3, recent: 3, consolidations: 1, kg: 3 };
}

export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
  agentId = 'main',
): Promise<MemoryContextResult> {
  const startTime = Date.now();
  const layersUsed = { workingMem: false, fts5: 0, vector: 0, kg: 0, consolidations: 0, conversationHistory: 0 };
  const seen = new Set<number>();
  const summaryMap = new Map<number, string>();
  const memLines: string[] = [];

  const complexity = computeComplexity(userMessage);

  // Working memory: short-lived per-agent session summary. 0ms retrieval,
  // gives the assistant immediate session awareness without re-reading history.
  const workingMem = getWorkingMemory(chatId, agentId);
  layersUsed.workingMem = !!workingMem;

  // Layer 1a: FTS5-first fast path. No embedding call. If enough matches,
  // we skip the Gemini embedding and all vector-dependent layers.
  const ftsMemories = searchMemories(chatId, userMessage, complexity.memories + 2, undefined, agentId);
  layersUsed.fts5 = ftsMemories.length;
  const needsVector = ftsMemories.length < FTS5_SUFFICIENCY;

  // Embed only when FTS5 didn't give us enough results. Cached so repeats are instant.
  let queryEmbedding: number[] | undefined;
  let queryHash = '';
  if (needsVector) {
    const cached = await getCachedQueryEmbedding(userMessage);
    queryEmbedding = cached.embedding;
    queryHash = cached.hash;
  } else {
    queryHash = hashQuery(normalizeQueryForCache(userMessage));
  }

  // Layer 1b: vector search only if FTS5 was sparse. Merge by id and prefer
  // vector ordering when both returned the same memory.
  if (queryEmbedding && queryEmbedding.length > 0) {
    const vectorMemories = searchMemories(chatId, userMessage, complexity.memories, queryEmbedding, agentId);
    layersUsed.vector = vectorMemories.length;
    const mergedIds = new Set<number>();
    for (const mem of vectorMemories) {
      if (mergedIds.has(mem.id)) continue;
      mergedIds.add(mem.id);
      seen.add(mem.id);
      summaryMap.set(mem.id, mem.summary);
      const topics = safeParse(mem.topics);
      const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
      memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
    }
    for (const mem of ftsMemories) {
      if (mergedIds.has(mem.id)) continue;
      mergedIds.add(mem.id);
      seen.add(mem.id);
      summaryMap.set(mem.id, mem.summary);
      const topics = safeParse(mem.topics);
      const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
      memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
    }
  } else {
    for (const mem of ftsMemories.slice(0, complexity.memories)) {
      seen.add(mem.id);
      summaryMap.set(mem.id, mem.summary);
      const topics = safeParse(mem.topics);
      const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
      memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
    }
  }

  // Layer 2: recent high-importance memories (deduplicated)
  const recent = getRecentHighImportanceMemories(chatId, complexity.recent);
  for (const mem of recent) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    summaryMap.set(mem.id, mem.summary);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 3: consolidation insights (vector if embedding available, keyword otherwise)
  const insightLines: string[] = [];

  if (queryEmbedding && queryEmbedding.length > 0) {
    const candidates = getConsolidationsWithEmbeddings(chatId);
    if (candidates.length > 0) {
      const scored = candidates
        .map((c) => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
        .filter((s) => s.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, complexity.consolidations);
      for (const c of scored) {
        insightLines.push(`- ${c.insight}`);
      }
    }
  }

  if (insightLines.length === 0) {
    const consolidations = searchConsolidations(chatId, userMessage, complexity.consolidations);
    if (consolidations.length === 0) {
      const recentInsights = getRecentConsolidations(chatId, complexity.consolidations);
      for (const c of recentInsights) {
        insightLines.push(`- ${c.insight}`);
      }
    } else {
      for (const c of consolidations) {
        insightLines.push(`- ${c.insight}`);
      }
    }
  }
  layersUsed.consolidations = insightLines.length;

  // Layer 6: Knowledge Graph semantic retrieval.
  // Adaptive limits (low=3, medium=5, high=8) keep per-turn context small
  // for simple queries so long resumed sessions don't blow past the model
  // context window, but expand for complex ones that need deeper recall.
  // Only runs when we have a query embedding (FTS5 didn't cover the query).
  const kgLines: string[] = [];
  if (queryEmbedding && queryEmbedding.length > 0) {
    try {
      const kgHits = searchKnowledgeSemantic(chatId, queryEmbedding, complexity.kg, agentId);
      layersUsed.kg = kgHits.length;
      for (const h of kgHits) {
        const own = h.agentId === agentId ? '' : ` (${h.agentId})`;
        kgLines.push(`- ${h.entityName}${own}: ${h.content.slice(0, 180)}`);
      }
    } catch (err) {
      logger.debug({ err }, 'Knowledge graph retrieval skipped');
    }
  }

  if (memLines.length === 0 && insightLines.length === 0 && kgLines.length === 0 && !workingMem && !agentObsidianConfig) {
    return { contextText: '', surfacedMemoryIds: [], surfacedMemorySummaries: new Map() };
  }

  const parts: string[] = [];

  // Working memory goes first so the assistant has session context before
  // consuming the retrieved memories and KG hits.
  if (workingMem) {
    parts.push(`[Working memory — current session focus]\n${workingMem}\n[End working memory]`);
  }

  if (memLines.length > 0 || insightLines.length > 0) {
    const blocks: string[] = ['[Memory context]'];
    if (memLines.length > 0) {
      blocks.push('Relevant memories:');
      blocks.push(...memLines);
    }
    if (insightLines.length > 0) {
      blocks.push('');
      blocks.push('Insights:');
      blocks.push(...insightLines);
    }
    blocks.push('[End memory context]');
    parts.push(blocks.join('\n'));
  }

  if (kgLines.length > 0) {
    parts.push(`[Knowledge graph]\n${kgLines.join('\n')}\n[End knowledge graph]`);
  }

  // Layer 4: Cross-agent activity awareness
  const teamActivity = getOtherAgentActivity(agentId, 24, 10);
  if (teamActivity.length > 0) {
    const activityLines = teamActivity.map((entry) => {
      // Note: created_at is unix seconds, Date.now() is ms, so divide by 1000
      const ago = Math.round((Date.now() / 1000 - entry.created_at) / 60);
      const timeStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
      return `- [${entry.agent_id}] ${timeStr}: ${entry.summary}`;
    });
    parts.push(`[Team activity — what other agents have done recently]\n${activityLines.join('\n')}\n[End team activity]`);
  }

  // Layer 5: Conversation history recall
  // When the user is asking about past conversations, search the conversation_log
  // for matching exchanges. This gives the agent access to the full context that
  // memory extraction may have compressed into a single sentence.
  const recallKeywords = /\bremember\b|\brecall\b|\byesterday\b|\blast time\b|\bwe talked\b|\bwe discussed\b|\bwhat do you know\b|\bdo you know\b|\bwhat did we\b|\bpreviously\b|\bearlier\b|\blast week\b|\bfew days\b/i;
  if (recallKeywords.test(userMessage)) {
    const historyTurns = searchConversationHistory(chatId, userMessage, agentId, 7, 10);
    if (historyTurns.length > 0) {
      const historyLines = historyTurns
        .reverse() // chronological
        .map((t) => {
          const daysAgo = Math.round((Date.now() / 1000 - t.created_at) / 86400);
          const timeStr = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`;
          const role = t.role === 'user' ? 'User' : 'You';
          return `[${timeStr}] ${role}: ${t.content.slice(0, 300)}`;
        });
      parts.push(`[Conversation history recall]\n${historyLines.join('\n')}\n[End conversation history]`);
    }
  }

  const obsidianBlock = buildObsidianContext(agentObsidianConfig);
  if (obsidianBlock) parts.push(obsidianBlock);

  const contextText = parts.join('\n\n');

  // Log one metric per call so we can tune the FTS5 sufficiency threshold
  // and adaptive limits based on real usage rather than guesses.
  try {
    logRetrievalMetric({
      chatId,
      agentId,
      queryHash,
      complexity: complexity.level,
      layersUsed,
      latencyMs: Date.now() - startTime,
      resultsCount: memLines.length + kgLines.length + insightLines.length,
    });
  } catch { /* metrics are best-effort */ }

  return { contextText, surfacedMemoryIds: [...seen], surfacedMemorySummaries: summaryMap };
}

/**
 * Process a conversation turn: log it and fire async memory extraction.
 * Called AFTER Claude responds, with both user message and Claude's response.
 *
 * The conversation log is written synchronously (for /respin support).
 * Memory extraction via Gemini is fire-and-forget (never blocks the response).
 */
export function saveConversationTurn(
  chatId: string,
  userMessage: string,
  claudeResponse: string,
  sessionId?: string,
  agentId = 'main',
): void {
  try {
    // Always log full conversation to conversation_log (for /respin)
    logConversationTurn(chatId, 'user', userMessage, sessionId, agentId);
    logConversationTurn(chatId, 'assistant', claudeResponse, sessionId, agentId);
  } catch (err) {
    logger.error({ err }, 'Failed to log conversation turn');
  }

  // Fire-and-forget: LLM-powered memory extraction via Gemini
  // This runs async and never blocks the user's response
  void ingestConversationTurn(chatId, userMessage, claudeResponse, agentId).catch((err) => {
    logger.error({ err }, 'Memory ingestion fire-and-forget failed');
  });
}

/**
 * Run the daily decay sweep. Call once on startup and every 24h.
 * Also prunes old conversation_log entries to prevent unbounded growth.
 *
 * MESSAGE RETENTION POLICY:
 * WhatsApp and Slack messages are auto-deleted after 3 days.
 * This is a security measure: message bodies contain personal
 * conversations that must not persist on disk indefinitely.
 */
export function runDecaySweep(): void {
  decayMemories();
  // Knowledge graph parallels memory decay: salience drops daily, entities
  // below 0.05 are deleted (cascade cleans obs + rels). Keeps the KG from
  // growing unbounded as entities accumulate from auto-extraction.
  try {
    const kgResult = decayEntities();
    if (kgResult.deleted > 0) {
      invalidateKnowledgeCache();
      logger.info({ decayed: kgResult.decayed, deleted: kgResult.deleted }, 'KG decay applied');
    }
  } catch (err) {
    logger.debug({ err }, 'KG decay skipped');
  }
  pruneConversationLog(500);

  // Cache and metrics hygiene: keep only useful / recent entries.
  try {
    const cachePruned = pruneEmbeddingCache(30, 3);
    const metricsPruned = pruneRetrievalMetrics(30);
    if (cachePruned > 0 || metricsPruned > 0) {
      logger.info({ cachePruned, metricsPruned }, 'Cache/metrics cleanup');
    }
  } catch (err) {
    logger.debug({ err }, 'Cache/metrics cleanup skipped');
  }

  // Enforce 3-day retention on messaging data
  const wa = pruneWaMessages(3);
  const slack = pruneSlackMessages(3);
  if (wa.messages + wa.outbox + wa.map + slack > 0) {
    logger.info(
      { wa_messages: wa.messages, wa_outbox: wa.outbox, wa_map: wa.map, slack },
      'Retention pruning complete',
    );
  }
}

/**
 * Summarize the last ~10 conversation turns and persist as working memory.
 * Fire-and-forget. Silently no-ops if Gemini fails or GOOGLE_API_KEY is missing.
 * Used by the bot trigger every 5 turns so the assistant always has an up-to-date
 * session summary injected without bloating the context.
 */
export async function updateWorkingMemory(chatId: string, agentId: string): Promise<void> {
  if (!GOOGLE_API_KEY) return;
  const recent = getAgentRecentConversation(agentId, chatId, 10);
  if (recent.length < 2) return;

  // getAgentRecentConversation returns DESC, flip to chronological for the prompt
  const chronological = recent.slice().reverse();
  const transcript = chronological
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 400)}`)
    .join('\n');

  const prompt = `Summarize the current conversation focus in 2-3 sentences. Factual and concise. Capture:
- What the user is working on right now
- Any time-sensitive context (location, deadlines, data freshness)
- Key decisions or action items

Do NOT include greetings or filler. No preamble, just the summary.

Conversation:
${transcript}

Summary:`;

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Working memory update timeout')), 10000),
    );
    const summary = (await Promise.race([generateContent(prompt), timeoutPromise])).trim();
    if (summary.length > 0) {
      saveWorkingMemorySummary(chatId, agentId, summary);
    }
  } catch (err) {
    logger.debug({ err }, 'Working memory update failed');
  }
}

/**
 * After an agent response, evaluate which surfaced memories were useful.
 * Fire-and-forget, never blocks the user. Has a 5-second timeout.
 */
export async function evaluateMemoryRelevance(
  surfacedMemoryIds: number[],
  memorySummaries: Map<number, string>,
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  if (surfacedMemoryIds.length === 0 || !GOOGLE_API_KEY) return;

  try {
    // Build a list of memories with their content so Gemini can actually judge
    const memoryList = surfacedMemoryIds
      .map((id) => `  ${id}: "${(memorySummaries.get(id) ?? '').slice(0, 100)}"`)
      .join('\n');

    const prompt = `Given this conversation, which memories were actually relevant and useful for the response? Return ONLY a JSON array of useful memory IDs. If none were useful, return [].

User: ${userMessage.slice(0, 500)}
Response: ${assistantResponse.slice(0, 500)}

Memories that were surfaced:
${memoryList}`;

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Evaluation timeout')), 5000),
    );
    const raw = await Promise.race([generateContent(prompt), timeoutPromise]);
    const usefulIds = parseJsonResponse<number[]>(raw);
    if (!usefulIds || !Array.isArray(usefulIds)) return;

    batchUpdateMemoryRelevance(surfacedMemoryIds, new Set(usefulIds));
  } catch {
    // Non-fatal, never block
  }
}

/** Safely parse a JSON array string, returning [] on failure. */
function safeParse(json: string): string[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
