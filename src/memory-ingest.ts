import { generateContent, parseJsonResponse } from './gemini.js';
import { embedText } from './embeddings.js';
import { saveStructuredMemory, saveMemoryEmbedding } from './db.js';
import {
  createEntity,
  createRelation,
  saveEntityEmbedding,
  saveObservationEmbedding,
  addObservations,
} from './knowledge-graph.js';
import { logger } from './logger.js';

// Callback for notifying when a high-importance memory is created.
// Set by bot.ts to send a Telegram notification suggesting /pin.
let onHighImportanceMemory: ((memoryId: number, summary: string, importance: number) => void) | null = null;

export function setHighImportanceCallback(cb: (memoryId: number, summary: string, importance: number) => void): void {
  onHighImportanceMemory = cb;
}

// ── Legacy flat extraction (still feeds the memories table) ──────────

interface ExtractionResult {
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
}

// ── Knowledge graph extraction ───────────────────────────────────────

interface KGExtractionEntity {
  name: string;
  entityType: string;
  observations: string[];
  importance?: number;
}

interface KGExtractionRelation {
  from: string;
  to: string;
  relationType: string;
}

interface KGExtractionResult {
  skip?: boolean;
  summary: string;
  importance: number;
  entities: KGExtractionEntity[];
  relations: KGExtractionRelation[];
  topics: string[];
}

const EXTRACTION_PROMPT = `You are a memory extraction agent for a knowledge graph. Given a conversation exchange between a user and their AI assistant, decide if it contains information worth remembering long-term.

SKIP (return {"skip": true}) if:
- The message is just an acknowledgment (ok, yes, no, got it, thanks, send it, do it)
- It's a command with no lasting context (/chatid, /help, checkpoint, convolife, etc)
- It's ephemeral task execution (send this email, check my calendar, read this message, draft a response)
- The content is only relevant to this exact moment
- It's a greeting or small talk with no substance
- It's a one-off action request like "shorten that", "generate 3 ideas", "look up X", "draft a reply" -- these are tasks, not memories
- It's a correction of a typo or minor instruction adjustment
- It's asking for information or a status check ("how much did we make", "what's trending", "what time is it")

EXTRACT if the exchange contains:
- User preferences, habits, or personal facts
- Decisions or policies (how to handle X going forward)
- Important relationships or contacts and how the user relates to them
- Project context that will matter in future sessions
- Corrections to the assistant's behavior (feedback on approach)
- Business rules or workflows
- Recurring patterns or routines
- Technical preferences or architectural decisions
- Emotional context about relationships or situations

If extracting, return JSON with entities and relations for a knowledge graph:
{
  "skip": false,
  "summary": "1-2 sentence summary of what to remember",
  "importance": 0.0-1.0,
  "entities": [
    {
      "name": "Entity Name",
      "entityType": "person|project|concept|preference|tool|place|organization|other",
      "observations": ["Specific fact or observation about this entity"],
      "importance": 0.0-1.0
    }
  ],
  "relations": [
    {
      "from": "Entity A",
      "to": "Entity B",
      "relationType": "works_at|knows|uses|prefers|manages|owns|related_to|etc"
    }
  ],
  "topics": ["topic1", "topic2"]
}

Entity naming rules:
- Use canonical names (e.g., "React" not "ReactJS", "Chris" not "the user")
- Capitalize proper nouns
- Be consistent: always use the same name for the same entity

Importance guide:
- 0.8-1.0: Core identity, strong preferences, critical business rules, relationship dynamics
- 0.5-0.7: Useful context, project details, moderate preferences, workflow patterns
- 0.2-0.4: Nice to know, minor details, one-off context that might be relevant later

User message: {USER_MESSAGE}
Assistant response: {ASSISTANT_RESPONSE}`;

/**
 * Analyze a conversation turn and extract structured memory if warranted.
 * Writes to BOTH the legacy memories table AND the new knowledge graph.
 * Called async (fire-and-forget) after the assistant responds.
 * Returns true if a memory was saved, false if skipped.
 */
export async function ingestConversationTurn(
  chatId: string,
  userMessage: string,
  assistantResponse: string,
  agentId = 'main',
): Promise<boolean> {
  // Hard filter: skip very short messages and commands
  if (userMessage.length <= 15 || userMessage.startsWith('/')) return false;

  try {
    const prompt = EXTRACTION_PROMPT
      .replace('{USER_MESSAGE}', userMessage.slice(0, 2000))
      .replace('{ASSISTANT_RESPONSE}', assistantResponse.slice(0, 2000));

    const raw = await generateContent(prompt);
    const result = parseJsonResponse<KGExtractionResult>(raw);

    if (!result || result.skip) return false;

    // Validate required fields
    if (!result.summary || typeof result.importance !== 'number') {
      logger.warn({ result }, 'Gemini extraction missing required fields');
      return false;
    }

    // Hard filter: don't save low importance (0.3 threshold kills borderline noise)
    if (result.importance < 0.3) return false;

    // Clamp importance to valid range
    const importance = Math.max(0, Math.min(1, result.importance));

    // ── Legacy: save to memories table (for backward compat) ────────
    const entityNames = (result.entities ?? []).map((e) => e.name);
    const memoryId = saveStructuredMemory(
      chatId,
      userMessage,
      result.summary,
      entityNames,
      result.topics ?? [],
      importance,
      'conversation',
    );

    // Generate embedding for legacy memory
    try {
      const embeddingText = `${result.summary} ${entityNames.join(' ')} ${(result.topics ?? []).join(' ')}`;
      const embedding = await embedText(embeddingText);
      if (embedding.length > 0) {
        saveMemoryEmbedding(memoryId, embedding);
      }
    } catch (embErr) {
      logger.warn({ err: embErr, memoryId }, 'Failed to generate embedding for memory');
    }

    // Notify on high-importance memories so the user can /pin them
    if (importance >= 0.8 && onHighImportanceMemory) {
      try { onHighImportanceMemory(memoryId, result.summary, importance); } catch { /* non-fatal */ }
    }

    // ── Knowledge Graph: create entities + relations ────────────────
    if (result.entities && result.entities.length > 0) {
      for (const e of result.entities) {
        try {
          const entity = createEntity(
            chatId,
            e.name,
            e.entityType || 'unknown',
            e.importance ?? importance,
            e.observations ?? [],
          );

          // Generate embedding for entity
          try {
            const entityText = `${e.name} ${e.entityType} ${(e.observations ?? []).join(' ')}`;
            const embedding = await embedText(entityText);
            if (embedding.length > 0) {
              saveEntityEmbedding(entity.id, embedding);

              // Also embed individual observations
              const obs = entity.id;
              // We already added observations in createEntity, but we need their IDs for embedding
              // The observations were added via addObservations which returns them
            }
          } catch {
            // Embedding failure is non-fatal
          }
        } catch (entityErr) {
          logger.warn({ err: entityErr, entity: e.name }, 'Failed to create KG entity');
        }
      }

      // Create relations
      if (result.relations && result.relations.length > 0) {
        for (const r of result.relations) {
          try {
            createRelation(chatId, r.from, r.to, r.relationType);
          } catch (relErr) {
            logger.warn({ err: relErr, from: r.from, to: r.to }, 'Failed to create KG relation');
          }
        }
      }

      logger.info(
        {
          chatId,
          importance,
          entities: result.entities.length,
          relations: result.relations?.length ?? 0,
          summary: result.summary.slice(0, 80),
        },
        'Memory ingested (KG + legacy)',
      );
    } else {
      logger.info(
        { chatId, importance, topics: result.topics, summary: result.summary.slice(0, 80) },
        'Memory ingested (legacy only)',
      );
    }

    return true;
  } catch (err) {
    // Gemini failure should never block the bot
    logger.error({ err }, 'Memory ingestion failed (Gemini)');
    return false;
  }
}
