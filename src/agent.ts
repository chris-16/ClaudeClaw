import fs from 'fs';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { PROJECT_ROOT, agentCwd, AGENT_ID, SAFE_MODE, SAFE_MAX_QUERIES_PER_HOUR, SAFE_MAX_COST_PER_DAY_USD, SAFE_AGENT_TIMEOUT_MS, AGENT_TIMEOUT_MS } from './config.js';
import { getAppSetting, getTodayCostUsd } from './db.js';
import { DailyCostLimitError } from './errors.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// ── Safe Mode: per-hour query rate limiter ───────────────────────────
// Tracks queries per agent per clock-hour. Resets when the hour changes.
const queryCounters = new Map<string, { hour: number; count: number }>();

function checkSafeModeRateLimit(agentId: string): void {
  if (!SAFE_MODE) return;
  const now = new Date();
  const currentHour = now.getFullYear() * 1000000 + now.getMonth() * 10000 + now.getDate() * 100 + now.getHours();
  const entry = queryCounters.get(agentId) ?? { hour: currentHour, count: 0 };
  if (entry.hour !== currentHour) {
    entry.hour = currentHour;
    entry.count = 0;
  }
  entry.count++;
  queryCounters.set(agentId, entry);
  if (entry.count > SAFE_MAX_QUERIES_PER_HOUR) {
    const msg = `[SAFE MODE] Agent "${agentId}" hit rate limit: ${entry.count}/${SAFE_MAX_QUERIES_PER_HOUR} queries this hour. Blocking until next hour.`;
    logger.warn(msg);
    throw new Error(msg);
  }

  // Daily cost enforcement (DB override takes precedence over .env)
  const dbOverride = getAppSetting('SAFE_MAX_COST_PER_DAY_USD');
  const effectiveLimit = dbOverride !== undefined ? parseFloat(dbOverride) : SAFE_MAX_COST_PER_DAY_USD;
  if (effectiveLimit > 0) {
    const todayCost = getTodayCostUsd();
    if (todayCost >= effectiveLimit) {
      logger.warn(`[SAFE MODE] Daily spend $${todayCost.toFixed(2)} hit limit $${effectiveLimit.toFixed(2)}. Blocking queries until tomorrow.`);
      throw new DailyCostLimitError(todayCost, effectiveLimit);
    }
  }
}

// ── MCP server loading ──────────────────────────────────────────────
// The Agent SDK's settingSources loads CLAUDE.md and permissions from
// project/user settings, but does NOT load mcpServers from those files.
// We read them ourselves and pass them via the `mcpServers` option.

interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function loadMcpServers(allowlist?: string[]): Record<string, McpStdioConfig> {
  const merged: Record<string, McpStdioConfig> = {};

  // Load from project settings (.claude/settings.json in cwd)
  const projectSettings = path.join(agentCwd ?? PROJECT_ROOT, '.claude', 'settings.json');
  // Load from user settings (~/.claude/settings.json)
  const userSettings = path.join(
    process.env.HOME ?? '/tmp',
    '.claude',
    'settings.json',
  );

  for (const file of [userSettings, projectSettings]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const servers = raw?.mcpServers;
      if (servers && typeof servers === 'object') {
        for (const [name, config] of Object.entries(servers)) {
          const cfg = config as Record<string, unknown>;
          if (cfg.command && typeof cfg.command === 'string') {
            merged[name] = {
              command: cfg.command,
              ...(cfg.args ? { args: cfg.args as string[] } : {}),
              ...(cfg.env ? { env: cfg.env as Record<string, string> } : {}),
            };
          }
        }
      }
    } catch {
      // File doesn't exist or is invalid — skip
    }
  }

  // If an allowlist is provided, only keep the MCPs in that list
  if (allowlist) {
    const allowed = new Set(allowlist);
    for (const name of Object.keys(merged)) {
      if (!allowed.has(name)) delete merged[name];
    }
  }

  return merged;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
  /** True if the SDK auto-compacted context during this turn */
  didCompact: boolean;
  /** Token count before compaction (if it happened) */
  preCompactTokens: number | null;
  /**
   * The cache_read_input_tokens from the LAST API call in the turn.
   * Unlike the cumulative cacheReadInputTokens, this reflects the actual
   * context window size (cumulative overcounts on multi-step tool-use turns).
   */
  lastCallCacheRead: number;
  /**
   * The input_tokens from the LAST API call in the turn.
   * This is the actual context window size: system prompt + conversation
   * history + tool results for that call. Use this for context warnings.
   */
  lastCallInputTokens: number;
}

/** Progress event emitted during agent execution for Telegram feedback. */
export interface AgentProgressEvent {
  type: 'task_started' | 'task_completed' | 'tool_active';
  description: string;
}

/** Map SDK tool names to human-readable labels. */
const TOOL_LABELS: Record<string, string> = {
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  Bash: 'Running command',
  Grep: 'Searching code',
  Glob: 'Finding files',
  WebSearch: 'Web search',
  WebFetch: 'Fetching page',
  Agent: 'Sub-agent',
  NotebookEdit: 'Editing notebook',
  AskUserQuestion: 'User question',
};

function toolLabel(toolName: string): string {
  if (TOOL_LABELS[toolName]) return TOOL_LABELS[toolName];
  // MCP tools: mcp__server__tool → "server: tool"
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts.length >= 3 ? `${parts[1]}: ${parts.slice(2).join(' ')}` : toolName;
  }
  return toolName;
}

export interface AgentResult {
  text: string | null;
  newSessionId: string | undefined;
  usage: UsageInfo | null;
  aborted?: boolean;
}

/**
 * A minimal AsyncIterable that yields a single user message then closes.
 * This is the format the Claude Agent SDK expects for its `prompt` parameter.
 * The SDK drives the agentic loop internally (tool use, multi-step reasoning)
 * and surfaces a final `result` event when done.
 */
async function* singleTurn(text: string): AsyncGenerator<{
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * Run a single user message through Claude Code and return the result.
 *
 * Uses `resume` to continue the same session across Telegram messages,
 * giving Claude persistent context without re-sending history.
 *
 * Auth: The SDK spawns the `claude` CLI subprocess which reads OAuth auth
 * from ~/.claude/ automatically (the same auth used in the terminal).
 * No explicit token needed if you're already logged in via `claude login`.
 * Optionally override with CLAUDE_CODE_OAUTH_TOKEN in .env.
 *
 * @param message    The user's text (may include transcribed voice prefix)
 * @param sessionId  Claude Code session ID to resume, or undefined for new session
 * @param onTyping   Called every TYPING_REFRESH_MS while waiting — sends typing action to Telegram
 * @param onProgress Called when sub-agents start/complete — sends status updates to Telegram
 */
export async function runAgent(
  message: string,
  sessionId: string | undefined,
  onTyping: () => void,
  onProgress?: (event: AgentProgressEvent) => void,
  model?: string,
  abortController?: AbortController,
  mcpAllowlist?: string[],
): Promise<AgentResult> {
  // ── Safe Mode: rate limit check ──
  checkSafeModeRateLimit(AGENT_ID);

  // In safe mode, enforce shorter timeout via a local AbortController
  if (SAFE_MODE && !abortController) {
    abortController = new AbortController();
    setTimeout(() => abortController!.abort(), SAFE_AGENT_TIMEOUT_MS);
    logger.info({ safeTimeout: SAFE_AGENT_TIMEOUT_MS }, '[SAFE MODE] Enforcing reduced timeout');
  }

  // Read secrets from .env without polluting process.env.
  // CLAUDE_CODE_OAUTH_TOKEN is optional — the subprocess finds auth via ~/.claude/
  // automatically. Only needed if you want to override which account is used.
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

  const sdkEnv: Record<string, string | undefined> = { ...process.env };
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) {
    sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = secrets.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (secrets.ANTHROPIC_API_KEY) {
    sdkEnv.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  }

  let newSessionId: string | undefined;
  let resultText: string | null = null;
  let usage: UsageInfo | null = null;
  let didCompact = false;
  let preCompactTokens: number | null = null;
  let lastCallCacheRead = 0;
  let lastCallInputTokens = 0;
  let modelCallCount = 0;   // ── Safe Mode instrumentation: count API calls within this query
  let toolUseCount = 0;     // ── count tool uses

  // Refresh typing indicator on an interval while Claude works.
  // Telegram's "typing..." action expires after ~5s.
  const typingInterval = setInterval(onTyping, 4000);

  try {
    // Always include both 'project' and 'user' settingSources.
    // Agents with MCP allowlists have their own .claude/settings.json containing
    // only their permitted MCPs, so no extra filtering is needed.
    // 'user' is required for the SDK to load MCP servers correctly.
    const sources: Array<'project' | 'user'> = ['project', 'user'];

    logger.info(
      { sessionId: sessionId ?? 'new', messageLen: message.length, settingSources: sources, mcpAllowlist: mcpAllowlist ?? 'all' },
      'Starting agent query',
    );

    // Load MCP servers from project + user settings.json files.
    // The Agent SDK's settingSources loads CLAUDE.md and permissions but does NOT
    // load mcpServers — we must pass them explicitly via the mcpServers option.
    const mcpServers = loadMcpServers(mcpAllowlist);
    logger.info({ mcpServerCount: Object.keys(mcpServers).length, mcpNames: Object.keys(mcpServers) }, 'Loaded MCP servers');

    for await (const event of query({
      prompt: singleTurn(message),
      options: {
        // cwd = agent directory (if running as agent) or project root.
        // Claude Code loads CLAUDE.md from cwd via settingSources: ['project'].
        cwd: agentCwd ?? PROJECT_ROOT,

        // Resume the previous session for this chat (persistent context)
        resume: sessionId,

        // 'project' loads CLAUDE.md + settings from cwd; 'user' loads ~/.claude/ (skills, MCPs, etc.)
        settingSources: sources,

        // MCP servers loaded from project + user settings.json
        mcpServers,

        // Skip all permission prompts — this is a trusted personal bot on your own machine
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,

        // Pass secrets to the subprocess without polluting our own process.env
        env: sdkEnv,

        // Model override (e.g. 'claude-haiku-4-5', 'claude-sonnet-4-5')
        ...(model ? { model } : {}),

        // Abort support — signals the SDK to kill the subprocess
        ...(abortController ? { abortController } : {}),
      },
    })) {
      const ev = event as Record<string, unknown>;

      if (ev['type'] === 'system' && ev['subtype'] === 'init') {
        newSessionId = ev['session_id'] as string;
        logger.info({ newSessionId }, 'Session initialized');
      }

      // Detect auto-compaction (context window was getting full)
      if (ev['type'] === 'system' && ev['subtype'] === 'compact_boundary') {
        didCompact = true;
        const meta = ev['compact_metadata'] as { trigger: string; pre_tokens: number } | undefined;
        preCompactTokens = meta?.pre_tokens ?? null;
        logger.warn(
          { trigger: meta?.trigger, preCompactTokens },
          'Context window compacted',
        );
      }

      // Track per-call token usage from assistant message events.
      // Each assistant message represents one API call; its usage reflects
      // that single call's context size (not cumulative across the turn).
      if (ev['type'] === 'assistant') {
        modelCallCount++;
        const msgUsage = (ev['message'] as Record<string, unknown>)?.['usage'] as Record<string, number> | undefined;
        const callCacheRead = msgUsage?.['cache_read_input_tokens'] ?? 0;
        const callInputTokens = msgUsage?.['input_tokens'] ?? 0;
        if (callCacheRead > 0) {
          lastCallCacheRead = callCacheRead;
        }
        if (callInputTokens > 0) {
          lastCallInputTokens = callInputTokens;
        }

        // Count tool uses from assistant content blocks
        const content = (ev['message'] as Record<string, unknown>)?.['content'] as Array<{ type: string }> | undefined;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') toolUseCount++;
          }
        }
      }

      // Tool progress events — surface to dashboard (not Telegram to avoid spam)
      if (ev['type'] === 'tool_progress' && onProgress) {
        const name = (ev['tool_name'] as string) ?? 'unknown';
        onProgress({ type: 'tool_active', description: toolLabel(name) });
      }

      // Sub-agent lifecycle events — surface to Telegram for user feedback
      if (ev['type'] === 'system' && ev['subtype'] === 'task_started' && onProgress) {
        const desc = (ev['description'] as string) ?? 'Sub-agent started';
        onProgress({ type: 'task_started', description: desc });
      }
      if (ev['type'] === 'system' && ev['subtype'] === 'task_notification' && onProgress) {
        const summary = (ev['summary'] as string) ?? 'Sub-agent finished';
        const status = (ev['status'] as string) ?? 'completed';
        onProgress({
          type: 'task_completed',
          description: status === 'failed' ? `Failed: ${summary}` : summary,
        });
      }

      if (ev['type'] === 'result') {
        resultText = (ev['result'] as string | null | undefined) ?? null;

        // Extract usage info from result event
        const evUsage = ev['usage'] as Record<string, number> | undefined;
        if (evUsage) {
          usage = {
            inputTokens: evUsage['input_tokens'] ?? 0,
            outputTokens: evUsage['output_tokens'] ?? 0,
            cacheReadInputTokens: evUsage['cache_read_input_tokens'] ?? 0,
            totalCostUsd: (ev['total_cost_usd'] as number) ?? 0,
            didCompact,
            preCompactTokens,
            lastCallCacheRead,
            lastCallInputTokens,
          };
          logger.info(
            {
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadInputTokens,
              lastCallCacheRead: usage.lastCallCacheRead,
              lastCallInputTokens: usage.lastCallInputTokens,
              costUsd: usage.totalCostUsd,
              didCompact,
            },
            'Turn usage',
          );
        }

        logger.info(
          { hasResult: !!resultText, subtype: ev['subtype'] },
          'Agent result received',
        );
      }
    }
  } catch (err) {
    if (abortController?.signal.aborted) {
      logger.info('Agent query aborted by user');
      return { text: null, newSessionId, usage, aborted: true };
    }
    throw err;
  } finally {
    clearInterval(typingInterval);
    // ── Per-query instrumentation log ──
    logger.info(
      { agentId: AGENT_ID, sessionType: sessionId ? 'resumed' : 'fresh', modelCalls: modelCallCount, toolUses: toolUseCount, cacheRead: lastCallCacheRead, inputTokens: lastCallInputTokens, costUsd: usage?.totalCostUsd ?? 0 },
      'Agent query completed',
    );
  }

  return { text: resultText, newSessionId, usage };
}
