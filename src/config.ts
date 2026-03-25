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
  'DASHBOARD_SESSION_TTL_HOURS',
  'DASHBOARD_DAILY_BUDGET_USD',
  'DASHBOARD_MONTHLY_BUDGET_USD',
  'DASHBOARD_ALLOWED_IPS',
  'DASHBOARD_OTP_ENABLED',
  'CLAUDECLAW_CONFIG',
  'DB_ENCRYPTION_KEY',
  'GOOGLE_API_KEY',
  'SAFE_MODE',
  'SAFE_MAX_QUERIES_PER_HOUR',
  'SAFE_MAX_COST_PER_DAY_USD',
  'SAFE_AGENT_TIMEOUT_MS',
  'SAFE_DISABLE_SCHEDULED_TASKS',
  'SAFE_DISABLE_DELEGATION',
  'AGENT_TIMEOUT_MS',
  'FORCE_FRESH_SESSION',
  'WORKING_MEMORY_MAX_CHARS',
  'ALERT_QUERY_COST_USD',
  'ALERT_DAILY_COST_USD',
  'ALERT_CACHE_READ_TOKENS',
  'GEMINI_MEMORY_ENABLED',
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
// Prevents runaway commands (e.g. recursive `find /`) from blocking the bot indefinitely.
// Default: 5 minutes. Override via AGENT_TIMEOUT_MS in .env.
export const AGENT_TIMEOUT_MS = parseInt(
  process.env.AGENT_TIMEOUT_MS || envConfig.AGENT_TIMEOUT_MS || '300000',
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
// Comma-separated IP addresses/prefixes allowed to access the dashboard.
// Example: "127.0.0.1,192.168.1.0" — leave empty to allow all IPs.
export const DASHBOARD_ALLOWED_IPS =
  process.env.DASHBOARD_ALLOWED_IPS || envConfig.DASHBOARD_ALLOWED_IPS || '';
// When true, remote logins require a one-time code sent via Telegram (2FA).
export const DASHBOARD_OTP_ENABLED =
  (process.env.DASHBOARD_OTP_ENABLED || envConfig.DASHBOARD_OTP_ENABLED || '').toLowerCase() === 'true';

// Database encryption key
export const DB_ENCRYPTION_KEY =
  process.env.DB_ENCRYPTION_KEY || envConfig.DB_ENCRYPTION_KEY || '';

// Google API key for Gemini (video analysis, and optionally memory features)
export const GOOGLE_API_KEY =
  process.env.GOOGLE_API_KEY || envConfig.GOOGLE_API_KEY || '';

// Enable Gemini-powered memory features (ingest, consolidation, embeddings).
// When false (default), GOOGLE_API_KEY is still available for video analysis
// but background memory calls to Gemini are disabled to save costs.
export const GEMINI_MEMORY_ENABLED =
  (process.env.GEMINI_MEMORY_ENABLED || envConfig.GEMINI_MEMORY_ENABLED || '').toLowerCase() === 'true';

// ── Safe Mode: cost containment ──────────────────────────────────────
// Set SAFE_MODE=true in .env to enable hard limits on Claude API usage.
// All limits are configurable via .env and only enforced when SAFE_MODE is on.
export const SAFE_MODE =
  (process.env.SAFE_MODE || envConfig.SAFE_MODE || '').toLowerCase() === 'true';

// Max queries (runAgent calls) per agent per hour. Resets on the hour.
export const SAFE_MAX_QUERIES_PER_HOUR = parseInt(
  process.env.SAFE_MAX_QUERIES_PER_HOUR || envConfig.SAFE_MAX_QUERIES_PER_HOUR || '20', 10,
);

// Max total cost (USD) per agent per day. Checked via token_usage table.
export const SAFE_MAX_COST_PER_DAY_USD = parseFloat(
  process.env.SAFE_MAX_COST_PER_DAY_USD || envConfig.SAFE_MAX_COST_PER_DAY_USD || '5.00',
);

// Timeout for agent queries in safe mode (ms). Overrides AGENT_TIMEOUT_MS.
export const SAFE_AGENT_TIMEOUT_MS = parseInt(
  process.env.SAFE_AGENT_TIMEOUT_MS || envConfig.SAFE_AGENT_TIMEOUT_MS || '45000', 10,
);

// Disable scheduled tasks in safe mode (they run unattended and burn credits)
export const SAFE_DISABLE_SCHEDULED_TASKS =
  (process.env.SAFE_DISABLE_SCHEDULED_TASKS || envConfig.SAFE_DISABLE_SCHEDULED_TASKS || 'true').toLowerCase() === 'true';

// Disable agent delegation in safe mode (prevents cascading multi-agent costs)
export const SAFE_DISABLE_DELEGATION =
  (process.env.SAFE_DISABLE_DELEGATION || envConfig.SAFE_DISABLE_DELEGATION || 'true').toLowerCase() === 'true';

// ── Session control ──────────────────────────────────────────────────
// Force fresh sessions: never resume a previous session. Eliminates cache_read
// costs (~80% of per-query spend). Working memory provides context continuity.
export const FORCE_FRESH_SESSION =
  (process.env.FORCE_FRESH_SESSION || envConfig.FORCE_FRESH_SESSION || '').toLowerCase() === 'true';

// ── Working Memory ───────────────────────────────────────────────────
// Max chars for working memory summary injected into each fresh query.
// Keeps context continuity without resuming expensive sessions.
export const WORKING_MEMORY_MAX_CHARS = parseInt(
  process.env.WORKING_MEMORY_MAX_CHARS || envConfig.WORKING_MEMORY_MAX_CHARS || '2000', 10,
);

// ── Cost Alerts ──────────────────────────────────────────────────────
// Telegram alerts when cost thresholds are exceeded. Set to 0 to disable.
export const ALERT_QUERY_COST_USD = parseFloat(
  process.env.ALERT_QUERY_COST_USD || envConfig.ALERT_QUERY_COST_USD || '1.00',
);
export const ALERT_DAILY_COST_USD = parseFloat(
  process.env.ALERT_DAILY_COST_USD || envConfig.ALERT_DAILY_COST_USD || '5.00',
);
export const ALERT_CACHE_READ_TOKENS = parseInt(
  process.env.ALERT_CACHE_READ_TOKENS || envConfig.ALERT_CACHE_READ_TOKENS || '50000', 10,
);
