import { agentObsidianConfig, GEMINI_MEMORY_ENABLED, GOOGLE_API_KEY, WORKING_MEMORY_MAX_CHARS } from './config.js';
import {
  decayMemories,
  getRecentConsolidations,
  getRecentHighImportanceMemories,
  getWorkingMemory,
  logConversationTurn,
  pruneConversationLog,
  pruneSlackMessages,
  pruneWaMessages,
  searchConsolidations,
  searchMemories,
  setWorkingMemory,
  touchMemory,
} from './db.js';
import { embedText } from './embeddings.js';
import { generateContent } from './gemini.js';
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
export async function buildMemoryContext(
  chatId: string,
  userMessage: string,
): Promise<string> {
  const seen = new Set<number>();
  const memLines: string[] = [];

  // Embed the query for vector search (async, adds ~200ms but gives semantic results)
  let queryEmbedding: number[] | undefined;
  if (GEMINI_MEMORY_ENABLED && GOOGLE_API_KEY) {
    try {
      queryEmbedding = await embedText(userMessage);
    } catch {
      // Embedding failure is non-fatal; falls back to keyword search
    }
  }

  // Layer 1: semantic search (embedding) with FTS5/LIKE fallback
  const searched = searchMemories(chatId, userMessage, 5, queryEmbedding);
  for (const mem of searched) {
    seen.add(mem.id);
    touchMemory(mem.id);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 2: recent high-importance memories (deduplicated)
  const recent = getRecentHighImportanceMemories(chatId, 5);
  for (const mem of recent) {
    if (seen.has(mem.id)) continue;
    seen.add(mem.id);
    touchMemory(mem.id);
    const topics = safeParse(mem.topics);
    const topicStr = topics.length > 0 ? ` (${topics.join(', ')})` : '';
    memLines.push(`- [${mem.importance.toFixed(1)}] ${mem.summary}${topicStr}`);
  }

  // Layer 3: consolidation insights
  const insightLines: string[] = [];
  const consolidations = searchConsolidations(chatId, userMessage, 2);
  if (consolidations.length === 0) {
    // Fall back to most recent consolidations
    const recentInsights = getRecentConsolidations(chatId, 2);
    for (const c of recentInsights) {
      insightLines.push(`- ${c.insight}`);
    }
  } else {
    for (const c of consolidations) {
      insightLines.push(`- ${c.insight}`);
    }
  }

  if (memLines.length === 0 && insightLines.length === 0 && !agentObsidianConfig) {
    return '';
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

  // Hint: the MCP memory server provides deeper knowledge graph access
  parts.push('[Memory tools available: use search_memory and open_nodes MCP tools to recall detailed information from your knowledge graph]');

  // Hint: knowledge base tools for technical documentation
  parts.push('[Knowledge Base available: use kb_search tool to look up technical documentation from crawled sources]');

  const obsidianBlock = buildObsidianContext(agentObsidianConfig);
  if (obsidianBlock) parts.push(obsidianBlock);

  return parts.join('\n\n');
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
  // Only runs when GEMINI_MEMORY_ENABLED=true (disabled by default to save costs)
  if (GEMINI_MEMORY_ENABLED) {
    void ingestConversationTurn(chatId, userMessage, claudeResponse).catch((err) => {
      logger.error({ err }, 'Memory ingestion fire-and-forget failed');
    });

    // Fire-and-forget: update working memory summary via Gemini
    void updateWorkingMemory(chatId, userMessage, claudeResponse, agentId).catch((err) => {
      logger.warn({ err }, 'Working memory update fire-and-forget failed');
    });
  }
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

/** Safely parse a JSON array string, returning [] on failure. */
function safeParse(json: string): string[] {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
