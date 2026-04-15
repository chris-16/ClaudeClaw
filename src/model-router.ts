/**
 * Smart Model Routing — automatically selects the cheapest model that can
 * handle the user's message. Manual overrides via /model take precedence.
 *
 * Tiers:
 *   Haiku  — short simple messages (greetings, yes/no, quick lookups)
 *   Sonnet — default for most work (code, analysis, moderate complexity)
 *   Opus   — explicit multi-step, long code reviews, deep analysis
 */

import { logger } from './logger.js';

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

const MODEL_IDS: Record<ModelTier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-5',
  opus: 'claude-opus-4-6',
};

// Patterns that signal complex work (upgrade to Opus)
const OPUS_PATTERNS = [
  /\b(refactor|refactoriza|architect|redesign|migrate)\b/i,
  /\b(review|audit)\s+(the\s+)?(code|codebase|PR|pull\s*request|security)/i,
  /\b(multi[- ]?step|step[- ]by[- ]step|plan\s+and\s+(implement|execute))\b/i,
  /\b(compare\s+and\s+contrast|trade[- ]?offs?|pros?\s+(?:and|y)\s+cons?|compara)\b/i,
  /\b(debug|diagnose|investigate|diagnostica|investiga)\b.*\b(issue|bug|error|failure|crash|problema|falla)/i,
  /\b(analiza\s+a?\s*fondo|analisis\s+detallado|revision\s+completa)\b/i,
];

// Patterns that signal simple work (downgrade to Haiku)
const HAIKU_PATTERNS = [
  /^(si|no|ok|dale|listo|bueno|gracias|thanks|yes|nope|got it|cool|nice)\s*[.!?]*$/i,
  /^(hola|hey|hi|hello|que tal|como estas|buenos dias|buenas)\s*[.!?]*$/i,
  /^(que hora es|what time|date)\s*[.!?]*$/i,
];

// Content signals that push toward Sonnet/Opus
const CODE_BLOCK_RE = /```[\s\S]{50,}```/;
const LONG_MESSAGE_THRESHOLD = 500; // chars
const SHORT_MESSAGE_THRESHOLD = 80;  // chars

export interface RoutingDecision {
  tier: ModelTier;
  modelId: string;
  reason: string;
}

/**
 * Classify a user message and return the recommended model tier.
 * Does NOT check for manual overrides — the caller should do that.
 */
export function routeMessage(message: string): RoutingDecision {
  const stripped = stripContextInjections(message);
  const len = stripped.length;

  // Check Opus patterns first (explicit complex work)
  for (const pattern of OPUS_PATTERNS) {
    if (pattern.test(stripped)) {
      return { tier: 'opus', modelId: MODEL_IDS.opus, reason: `opus pattern: ${pattern.source.slice(0, 40)}` };
    }
  }

  // Large code blocks or very long messages -> Sonnet minimum
  if (CODE_BLOCK_RE.test(stripped) || len > 2000) {
    return { tier: 'sonnet', modelId: MODEL_IDS.sonnet, reason: 'code block or long message' };
  }

  // Short simple messages -> Haiku
  if (len <= SHORT_MESSAGE_THRESHOLD) {
    for (const pattern of HAIKU_PATTERNS) {
      if (pattern.test(stripped)) {
        return { tier: 'haiku', modelId: MODEL_IDS.haiku, reason: `haiku pattern: ${pattern.source.slice(0, 40)}` };
      }
    }
    // Short but not matching a known simple pattern? Check if it's a question
    if (/^[^.]{1,60}\?$/.test(stripped.trim())) {
      return { tier: 'haiku', modelId: MODEL_IDS.haiku, reason: 'short question' };
    }
  }

  // Default: Sonnet
  return { tier: 'sonnet', modelId: MODEL_IDS.sonnet, reason: 'default' };
}

/**
 * Strip memory context, agent role, and task context injections
 * so the classifier only sees the user's actual message.
 */
function stripContextInjections(message: string): string {
  return message
    .replace(/\[Agent role[^\]]*\][\s\S]*?\[End agent role\]/g, '')
    .replace(/\[Memory context[^\]]*\][\s\S]*?\[End memory context\]/g, '')
    .replace(/\[Recent scheduled task context[^\]]*\][\s\S]*?\[End task context\]/g, '')
    .replace(/\[Conversation history recall[^\]]*\][\s\S]*?\[End conversation recall\]/g, '')
    .trim();
}

/**
 * Check if the routed model should be overridden by budget constraints.
 * When budget is at 95%+, forces Haiku regardless of routing.
 */
export function applyBudgetOverride(decision: RoutingDecision, budgetPct: number): RoutingDecision {
  if (budgetPct >= 95 && decision.tier !== 'haiku') {
    logger.info({ originalTier: decision.tier, budgetPct }, 'Budget override: forcing Haiku');
    return { tier: 'haiku', modelId: MODEL_IDS.haiku, reason: `budget override (${budgetPct}% spent)` };
  }
  return decision;
}
