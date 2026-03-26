import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'TELEGRAM_BOT_TOKEN',
  'ALLOWED_CHAT_ID',
  'GROQ_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'WHATSAPP_ENABLED',
  'SLACK_USER_TOKEN',
  'CONTEXT_LIMIT',
  'DASHBOARD_PORT',
  'DASHBOARD_TOKEN',
  'DASHBOARD_URL',
  'CLAUDECLAW_CONFIG',
  'DB_ENCRYPTION_KEY',
  'GOOGLE_API_KEY',
  'AGENT_TIMEOUT_MS',
  'SECURITY_PIN_HASH',
  'IDLE_LOCK_MINUTES',
  'EMERGENCY_KILL_PHRASE',
  'DASHBOARD_SESSION_TTL_HOURS',
  'DASHBOARD_DAILY_BUDGET_USD',
  'DASHBOARD_MONTHLY_BUDGET_USD',
  'DASHBOARD_ALLOWED_IPS',
  'DASHBOARD_OTP_ENABLED',
  'SAFE_MODE',
  'SAFE_MAX_QUERIES_PER_HOUR',
  'SAFE_MAX_COST_PER_DAY_USD',
  'SAFE_AGENT_TIMEOUT_MS',
  'SAFE_DISABLE_SCHEDULED_TASKS',
  'SAFE_DISABLE_DELEGATION',
  'FORCE_FRESH_SESSION',
  'WORKING_MEMORY_MAX_CHARS',
  'ALERT_QUERY_COST_USD',
  'ALERT_DAILY_COST_USD',
  'ALERT_CACHE_READ_TOKENS',
]);

// ── Multi-agent support ──────────────────────────────────────────────
// These are mutable and overridden by index.ts when --agent is passed.
export let AGENT_ID = 'main';
export let activeBotToken =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
export let agentCwd: string | undefined; // undefined = use PROJECT_ROOT
export let agentDefaultModel: string | undefined; // from agent.yaml
export let agentObsidianConfig: { vault: string; folders: string[]; readOnly?: string[] } | undefined;
export let agentSystemPrompt: string | undefined; // loaded from agents/{id}/CLAUDE.md
export let agentMcpAllowlist: string[] | undefined; // from agent.yaml mcp_servers

export function setAgentOverrides(opts: {
  agentId: string;
  botToken: string;
  cwd: string;
  model?: string;
  obsidian?: { vault: string; folders: string[]; readOnly?: string[] };
  systemPrompt?: string;
  mcpServers?: string[];
}): void {
  AGENT_ID = opts.agentId;
  activeBotToken = opts.botToken;
  agentCwd = opts.cwd;
  agentDefaultModel = opts.model;
  agentObsidianConfig = opts.obsidian;
  agentSystemPrompt = opts.systemPrompt;
  agentMcpAllowlist = opts.mcpServers;
}

export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';

// Only respond to this Telegram chat ID. Set this after getting your ID via /chatid.
export const ALLOWED_CHAT_ID =
  process.env.ALLOWED_CHAT_ID || envConfig.ALLOWED_CHAT_ID || '';

export const WHATSAPP_ENABLED =
  (process.env.WHATSAPP_ENABLED || envConfig.WHATSAPP_ENABLED || '').toLowerCase() === 'true';

export const SLACK_USER_TOKEN =
  process.env.SLACK_USER_TOKEN || envConfig.SLACK_USER_TOKEN || '';

// Voice — read via readEnvFile, not process.env
export const GROQ_API_KEY = envConfig.GROQ_API_KEY ?? '';
export const ELEVENLABS_API_KEY = envConfig.ELEVENLABS_API_KEY ?? '';
export const ELEVENLABS_VOICE_ID = envConfig.ELEVENLABS_VOICE_ID ?? '';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// PROJECT_ROOT is the claudeclaw/ directory — where CLAUDE.md lives.
// The SDK uses this as cwd, which causes Claude Code to load our CLAUDE.md
// and all global skills from ~/.claude/skills/ via settingSources.
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');

// ── External config directory ────────────────────────────────────────
// Personal config files (CLAUDE.md, agent.yaml, agent CLAUDE.md) can live
// outside the repo in CLAUDECLAW_CONFIG (default ~/.claudeclaw) so they
// never get committed. The repo ships only .example template files.

/** Expand ~/... to an absolute path. */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

const rawConfigDir =
  process.env.CLAUDECLAW_CONFIG || envConfig.CLAUDECLAW_CONFIG || '~/.claudeclaw';

/**
 * Absolute path to the external config directory.
 * Defaults to ~/.claudeclaw. Set CLAUDECLAW_CONFIG in .env or environment to override.
 */
export const CLAUDECLAW_CONFIG = expandHome(rawConfigDir);

// Telegram limits
export const MAX_MESSAGE_LENGTH = 4096;

// How often to refresh the typing indicator while Claude is thinking (ms).
// Telegram's typing action expires after ~5s, so 4s keeps it continuous.
export const TYPING_REFRESH_MS = 4000;

// Maximum time (ms) an agent query can run before being auto-aborted.
// Safety net for truly stuck commands (e.g. recursive `find /`).
// Default: 15 minutes. Use /stop in Telegram to manually kill a running query.
// Previously 5 min, which caused mid-execution timeouts on bulk API work
// (posting YouTube comments, sending multiple messages) leading to duplicate posts.
export const AGENT_TIMEOUT_MS = parseInt(
  process.env.AGENT_TIMEOUT_MS || envConfig.AGENT_TIMEOUT_MS || '900000',
  10,
);

// Context window limit for the model. Opus 4.6 (1M context) = 1,000,000.
// Override via CONTEXT_LIMIT in .env if using a different model variant.
export const CONTEXT_LIMIT = parseInt(
  process.env.CONTEXT_LIMIT || envConfig.CONTEXT_LIMIT || '1000000',
  10,
);

// Dashboard — web UI for monitoring ClaudeClaw state
export const DASHBOARD_PORT = parseInt(
  process.env.DASHBOARD_PORT || envConfig.DASHBOARD_PORT || '3141',
  10,
);
export const DASHBOARD_TOKEN =
  process.env.DASHBOARD_TOKEN || envConfig.DASHBOARD_TOKEN || '';
export const DASHBOARD_URL =
  process.env.DASHBOARD_URL || envConfig.DASHBOARD_URL || '';
export const DASHBOARD_SESSION_TTL_HOURS = parseInt(
  process.env.DASHBOARD_SESSION_TTL_HOURS || envConfig.DASHBOARD_SESSION_TTL_HOURS || '24',
  10,
);
export const DASHBOARD_DAILY_BUDGET_USD = parseFloat(
  process.env.DASHBOARD_DAILY_BUDGET_USD || envConfig.DASHBOARD_DAILY_BUDGET_USD || '0',
);
export const DASHBOARD_MONTHLY_BUDGET_USD = parseFloat(
  process.env.DASHBOARD_MONTHLY_BUDGET_USD || envConfig.DASHBOARD_MONTHLY_BUDGET_USD || '0',
);
export const DASHBOARD_ALLOWED_IPS =
  process.env.DASHBOARD_ALLOWED_IPS || envConfig.DASHBOARD_ALLOWED_IPS || '';
export const DASHBOARD_OTP_ENABLED =
  (process.env.DASHBOARD_OTP_ENABLED || envConfig.DASHBOARD_OTP_ENABLED || '').toLowerCase() === 'true';

// Database encryption key (SQLCipher). Required for encrypted database access.
export const DB_ENCRYPTION_KEY =
  process.env.DB_ENCRYPTION_KEY || envConfig.DB_ENCRYPTION_KEY || '';

// Google API key for Gemini (memory extraction + consolidation)
export const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || envConfig.GOOGLE_API_KEY || '';

// Streaming strategy for progressive Telegram updates.
// 'global-throttle' (default): edits a placeholder message with streamed text,
//   rate-limited to ~24 edits/min per chat to respect Telegram limits.
// 'single-agent-only': streaming disabled when multiple agents are active on same chat.
// 'off': no streaming, wait for full response.
export type StreamStrategy = 'global-throttle' | 'single-agent-only' | 'off';
export const STREAM_STRATEGY: StreamStrategy =
  (process.env.STREAM_STRATEGY || 'off') as StreamStrategy;

// ── Security ─────────────────────────────────────────────────────────
// PIN lock: SHA-256 hash of your PIN. Generate: node -e "console.log(require('crypto').createHash('sha256').update('YOUR_PIN').digest('hex'))"
export const SECURITY_PIN_HASH =
  process.env.SECURITY_PIN_HASH || envConfig.SECURITY_PIN_HASH || '';

// Auto-lock after N minutes of inactivity. 0 = disabled. Only active when PIN is set.
export const IDLE_LOCK_MINUTES = parseInt(
  process.env.IDLE_LOCK_MINUTES || envConfig.IDLE_LOCK_MINUTES || '0',
  10,
);

// Emergency kill phrase. Sending this to any bot immediately stops all agents and exits.
export const EMERGENCY_KILL_PHRASE =
  process.env.EMERGENCY_KILL_PHRASE || envConfig.EMERGENCY_KILL_PHRASE || '';

// ── Safe Mode: cost containment ──────────────────────────────────────
export const SAFE_MODE =
  (process.env.SAFE_MODE || envConfig.SAFE_MODE || '').toLowerCase() === 'true';
export const SAFE_MAX_QUERIES_PER_HOUR = parseInt(
  process.env.SAFE_MAX_QUERIES_PER_HOUR || envConfig.SAFE_MAX_QUERIES_PER_HOUR || '20', 10,
);
export const SAFE_MAX_COST_PER_DAY_USD = parseFloat(
  process.env.SAFE_MAX_COST_PER_DAY_USD || envConfig.SAFE_MAX_COST_PER_DAY_USD || '5.00',
);
export const SAFE_AGENT_TIMEOUT_MS = parseInt(
  process.env.SAFE_AGENT_TIMEOUT_MS || envConfig.SAFE_AGENT_TIMEOUT_MS || '45000', 10,
);
export const SAFE_DISABLE_SCHEDULED_TASKS =
  (process.env.SAFE_DISABLE_SCHEDULED_TASKS || envConfig.SAFE_DISABLE_SCHEDULED_TASKS || 'true').toLowerCase() === 'true';
export const SAFE_DISABLE_DELEGATION =
  (process.env.SAFE_DISABLE_DELEGATION || envConfig.SAFE_DISABLE_DELEGATION || 'true').toLowerCase() === 'true';

// ── Session control ──────────────────────────────────────────────────
export const FORCE_FRESH_SESSION =
  (process.env.FORCE_FRESH_SESSION || envConfig.FORCE_FRESH_SESSION || '').toLowerCase() === 'true';

// ── Working Memory ───────────────────────────────────────────────────
export const WORKING_MEMORY_MAX_CHARS = parseInt(
  process.env.WORKING_MEMORY_MAX_CHARS || envConfig.WORKING_MEMORY_MAX_CHARS || '2000', 10,
);

// ── Cost Alerts ──────────────────────────────────────────────────────
export const ALERT_QUERY_COST_USD = parseFloat(
  process.env.ALERT_QUERY_COST_USD || envConfig.ALERT_QUERY_COST_USD || '1.00',
);
export const ALERT_DAILY_COST_USD = parseFloat(
  process.env.ALERT_DAILY_COST_USD || envConfig.ALERT_DAILY_COST_USD || '5.00',
);
export const ALERT_CACHE_READ_TOKENS = parseInt(
  process.env.ALERT_CACHE_READ_TOKENS || envConfig.ALERT_CACHE_READ_TOKENS || '50000', 10,
);
