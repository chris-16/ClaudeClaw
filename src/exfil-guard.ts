/**
 * Exfiltration Guard — redacts sensitive values from agent responses
 * before they're sent to Telegram (or any output channel).
 *
 * Two layers:
 * 1. Exact-match: checks if any protected env var value appears in the text
 * 2. Pattern-match: catches common API key formats even if not in .env
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// Env vars whose values should never appear in outgoing messages
const PROTECTED_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'DB_ENCRYPTION_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'ELEVENLABS_API_KEY',
  'SLACK_USER_TOKEN',
  'NOTION_API_KEY',
  'VAPI_API_KEY',
  'GRADIUM_API_KEY',
  'DASHBOARD_TOKEN',
  'SECURITY_PIN_HASH',
  'EMERGENCY_KILL_PHRASE',
  'WHOOP_CLIENT_SECRET',
  'HEVY_API_KEY',
  // Agent bot tokens
  'AXIOM_BOT_TOKEN',
  'DIRECTOR_BOT_TOKEN',
  'DRATLAS_BOT_TOKEN',
];

// Common API key patterns (catches keys not in our .env)
const KEY_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /sk-ant-api\d{2}-[A-Za-z0-9_-]{80,}/, label: 'ANTHROPIC_KEY' },
  { pattern: /sk-[A-Za-z0-9]{32,}/, label: 'OPENAI_KEY' },
  { pattern: /xoxb-[0-9]+-[A-Za-z0-9]+/, label: 'SLACK_TOKEN' },
  { pattern: /xoxp-[0-9]+-[A-Za-z0-9]+/, label: 'SLACK_TOKEN' },
  { pattern: /gsk_[A-Za-z0-9]{20,}/, label: 'GROQ_KEY' },
  { pattern: /ntn_[A-Za-z0-9]{40,}/, label: 'NOTION_KEY' },
  { pattern: /secret_[A-Za-z0-9]{40,}/, label: 'NOTION_SECRET' },
  { pattern: /AIzaSy[A-Za-z0-9_-]{33}/, label: 'GOOGLE_KEY' },
  { pattern: /[0-9]+:AA[A-Za-z0-9_-]{33,}/, label: 'TELEGRAM_TOKEN' },
];

// Cache of env var values to check against (loaded once)
let protectedValues: Array<{ value: string; name: string }> | null = null;

function loadProtectedValues(): Array<{ value: string; name: string }> {
  if (protectedValues) return protectedValues;

  const env = readEnvFile(PROTECTED_VARS);
  protectedValues = [];

  for (const varName of PROTECTED_VARS) {
    const value = process.env[varName] || env[varName as keyof typeof env];
    // Only protect values that are long enough to be meaningful (avoid false positives)
    if (value && value.length >= 8) {
      protectedValues.push({ value, name: varName });
    }
  }

  return protectedValues;
}

/**
 * Scan text for sensitive values and redact them.
 * Returns the cleaned text. If nothing was redacted, returns the original string.
 */
export function redactSensitiveValues(text: string): string {
  if (!text) return text;

  let result = text;
  let redacted = false;

  // Layer 1: exact env var value matches
  for (const { value, name } of loadProtectedValues()) {
    if (result.includes(value)) {
      result = result.split(value).join(`[REDACTED:${name}]`);
      redacted = true;
    }
  }

  // Layer 2: pattern matches for common key formats
  for (const { pattern, label } of KEY_PATTERNS) {
    if (pattern.test(result)) {
      result = result.replace(new RegExp(pattern.source, pattern.flags + 'g'), `[REDACTED:${label}]`);
      redacted = true;
    }
  }

  if (redacted) {
    logger.warn('Exfil guard: redacted sensitive values from response');
  }

  return result;
}
