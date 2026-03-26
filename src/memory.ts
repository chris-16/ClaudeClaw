import { agentObsidianConfig, GOOGLE_API_KEY, WORKING_MEMORY_MAX_CHARS } from './config.js';
import {
  batchUpdateMemoryRelevance,
  decayMemories,
  getConsolidationsWithEmbeddings,
  getOtherAgentActivity,
  getRecentConsolidations,
  getRecentHighImportanceMemories,
  getWorkingMemory,
  logConversationTurn,
  pruneConversationLog,
  pruneSlackMessages,
  pruneWaMessages,
  searchConsolidations,
  searchConversationHistory,
  searchMemories,
  setWorkingMemory,
} from './db.js';
import { cosineSimilarity, embedText } from './embeddings.js';
import { generateContent, parseJsonResponse } from './gemini.js';
import { decayEntities } from './knowledge-graph.js';
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

export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
  agentId = 'main',
): Promise<MemoryContextResult> {
  const seen = new Set<number>();
  const summaryMap = new Map<number, string>();
  const memLines: string[] = [];

  // Embed the query for vector search (async, adds ~200ms but gives semantic results)
  let queryEmbedding: number[] | undefined;
  if (GOOGLE_API_KEY) {
    try {
      queryEmbedding = await embedText(userMessage);
    } catch {
      // Embedding failure is non-fatal; falls back to keyword search
    }
  }

  // Layer 1: semantic search (embedding) with FTS5/LIKE fallback
  // NOTE: We do NOT touch memories here. The feedback loop (evaluateMemoryRelevance)
  // is the only thing that should boost salience/accessed_at. Touching at retrieval
  // creates a positive feedback loop where noise stays fresh forever.
  const searched = searchMemories(chatId, userMessage, 5, queryEmbedding);
  for (const mem of searched) {
    seen.add(mem.id);
    summaryMap.set(mem.id, mem.summary);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 2: recent high-importance memories (deduplicated)
  const recent = getRecentHighImportanceMemories(chatId, 5);
  for (const mem of recent) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    summaryMap.set(mem.id, mem.summary);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 3: consolidation insights (semantic search with LIKE fallback)
  const insightLines: string[] = [];

  if (queryEmbedding && queryEmbedding.length > 0) {
    const candidates = getConsolidationsWithEmbeddings(chatId);
    if (candidates.length > 0) {
      const scored = candidates
        .map((c) => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
        .filter((s) => s.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      for (const c of scored) {
        insightLines.push(`- ${c.insight}`);
      }
    }
  }

  if (insightLines.length === 0) {
    const consolidations = searchConsolidations(chatId, userMessage, 2);
    if (consolidations.length === 0) {
      const recentInsights = getRecentConsolidations(chatId, 2);
      for (const c of recentInsights) {
        insightLines.push(`- ${c.insight}`);
      }
    } else {
      for (const c of consolidations) {
        insightLines.push(`- ${c.insight}`);
      }
    }
  }

  if (memLines.length === 0 && insightLines.length === 0 && !agentObsidianConfig) {
    return { contextText: '', surfacedMemoryIds: [], surfacedMemorySummaries: new Map() };
  }

  const parts: string[] = [];

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

  // Layer 4: Cross-agent activity awareness
  const teamActivity = getOtherAgentActivity(agentId, 24, 10);
  if (teamActivity.length > 0) {
    const activityLines = teamActivity.map((entry) => {
      const ago = Math.round((Date.now() / 1000 - entry.created_at) / 60);
      const timeStr = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
      return `- [${entry.agent_id}] ${timeStr}: ${entry.summary}`;
    });
    parts.push(`[Team activity — what other agents have done recently]\n${activityLines.join('\n')}\n[End team activity]`);
  }

  // Layer 5: Conversation history recall
  const recallKeywords = /\bremember\b|\brecall\b|\byesterday\b|\blast time\b|\bwe talked\b|\bwe discussed\b|\bwhat do you know\b|\bdo you know\b|\bwhat did we\b|\bpreviously\b|\bearlier\b|\blast week\b|\bfew days\b/i;
  if (recallKeywords.test(userMessage)) {
    const historyTurns = searchConversationHistory(chatId, userMessage, agentId, 7, 10);
    if (historyTurns.length > 0) {
      const historyLines = historyTurns
        .reverse()
        .map((t) => {
          const daysAgo = Math.round((Date.now() / 1000 - t.created_at) / 86400);
          const timeStr = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`;
          const role = t.role === 'user' ? 'User' : 'You';
          return `[${timeStr}] ${role}: ${t.content.slice(0, 300)}`;
        });
      parts.push(`[Conversation history recall]\n${historyLines.join('\n')}\n[End conversation history]`);
    }
  }

  // Hint: the MCP memory server provides deeper knowledge graph access
  parts.push('[Memory tools available: use search_memory and open_nodes MCP tools to recall detailed information from your knowledge graph]');

  // Hint: knowledge base tools for technical documentation
  parts.push('[Knowledge Base available: use kb_search tool to look up technical documentation from crawled sources]');

  const obsidianBlock = buildObsidianContext(agentObsidianConfig);
  if (obsidianBlock) parts.push(obsidianBlock);

  return { contextText: parts.join('\n\n'), surfacedMemoryIds: [...seen], surfacedMemorySummaries: summaryMap };
}

/**
 * Return the current working memory for injection into the prompt.
 * Returns empty string if no working memory exists.
 */
export function getWorkingMemoryContext(chatId: string, agentId = 'main'): string {
  const summary = getWorkingMemory(chatId, agentId);
  if (!summary) return '';
  return `[Working memory — recent context]\n${summary}\n[End working memory]`;
}

/**
 * Update working memory with a summary of the latest turn.
 * Uses Gemini (cheap) to merge the previous summary with the new turn.
 * Fire-and-forget: never blocks the response.
 */
async function updateWorkingMemory(
  chatId: string,
  userMessage: string,
  claudeResponse: string,
  agentId = 'main',
): Promise<void> {
  if (!GOOGLE_API_KEY) return;

  const prev = getWorkingMemory(chatId, agentId);
  const prompt = `You maintain a working memory summary for an AI assistant conversation.

PREVIOUS SUMMARY:
${prev || '(empty — first turn)'}

LATEST TURN:
User: ${userMessage.slice(0, 500)}
Assistant: ${claudeResponse.slice(0, 1000)}

Write an updated summary that captures the KEY context needed for the next turn.
Include: what was discussed, decisions made, pending items, important facts.
Drop: greetings, pleasantries, resolved items, redundant details.
Max ${Math.floor(WORKING_MEMORY_MAX_CHARS / 4)} words. Use bullet points. Be terse.`;

  try {
    const result = await generateContent(prompt);
    const summary = result.slice(0, WORKING_MEMORY_MAX_CHARS);
    setWorkingMemory(chatId, summary, agentId);
    logger.info({ chatId, agentId, summaryLen: summary.length }, 'Working memory updated');
  } catch (err) {
    logger.warn({ err }, 'Working memory update failed (non-fatal)');
  }
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

  // Fire-and-forget: update working memory summary via Gemini
  void updateWorkingMemory(chatId, userMessage, claudeResponse, agentId).catch((err) => {
    logger.warn({ err }, 'Working memory update fire-and-forget failed');
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
  // Also decay knowledge graph entities
  try {
    const kgResult = decayEntities();
    if (kgResult.deleted > 0) {
      logger.info({ kgDecayed: kgResult.decayed, kgDeleted: kgResult.deleted }, 'KG entity decay complete');
    }
  } catch (err) {
    logger.warn({ err }, 'KG entity decay failed (non-fatal)');
  }
  pruneConversationLog(500);

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
