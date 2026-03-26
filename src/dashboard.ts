import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { Api, RawApi } from 'grammy';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';

import {
  ALLOWED_CHAT_ID,
  CONTEXT_LIMIT,
  DASHBOARD_ALLOWED_IPS,
  DASHBOARD_DAILY_BUDGET_USD,
  DASHBOARD_MONTHLY_BUDGET_USD,
  DASHBOARD_OTP_ENABLED,
  DASHBOARD_PORT,
  DASHBOARD_SESSION_TTL_HOURS,
  DASHBOARD_TOKEN,
  PROJECT_ROOT,
  SAFE_MAX_COST_PER_DAY_USD,
  SLACK_USER_TOKEN,
  STORE_DIR,
  WHATSAPP_ENABLED,
  agentDefaultModel,
} from './config.js';
import {
  deleteScheduledTask,
  getAllScheduledTasks,
  getActivityLog,
  getAgentRecentConversation,
  getAgentTokenStats,
  getConversationPage,
  getDashboardCostTimeline,
  getDashboardConsolidations,
  getDashboardLowSalienceMemories,
  getDashboardMemoriesList,
  getDashboardMemoryStats,
  getDashboardMemoryTimeline,
  getDashboardRecentTokenUsage,
  getDashboardTokenStats,
  getDashboardTopAccessedMemories,
  getAgentCostBreakdown,
  getHiveMindEntries,
  getSession,
  getSessionTokenUsage,
  getAppSetting,
  getAppSettingMeta,
  getTodayCostUsd,
  getTopCostlyQueries,
  logActivity,
  pauseScheduledTask,
  resumeScheduledTask,
  setAppSetting,
} from './db.js';
import { listAgentIds, loadAgentConfig } from './agent-config.js';
import { listSkills, toggleSkill } from './skills-manager.js';
import { processMessageFromDashboard } from './bot.js';
import { logger } from './logger.js';
import {
  ChatEvent,
  abortActiveQuery,
  chatEvents,
  getBotInfo,
  getIsProcessing,
  getTelegramConnected,
} from './state.js';

// ── Session Management ──────────────────────────────────────────────────

interface Session { createdAt: number; expiresAt: number }
const sessions = new Map<string, Session>();
const SESSION_COOKIE = 'cc_session';

function generateSessionId(): string { return crypto.randomBytes(32).toString('hex'); }

function createSession(): string {
  const id = generateSessionId();
  const now = Date.now();
  sessions.set(id, { createdAt: now, expiresAt: now + DASHBOARD_SESSION_TTL_HOURS * 3_600_000 });
  return id;
}

function validateSession(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (Date.now() > s.expiresAt) { sessions.delete(id); return false; }
  return true;
}

function sessionFromCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}

// ── Rate Limiting ──────────────────────────────────────────────────────

interface RateRecord { count: number; blockedUntil?: number }
const loginAttempts = new Map<string, RateRecord>();
const MAX_ATTEMPTS = 5;
const BLOCK_MS = 30 * 60 * 1000;

function checkRate(ip: string): { ok: boolean; minutesLeft?: number } {
  const r = loginAttempts.get(ip);
  if (!r) return { ok: true };
  if (r.blockedUntil && Date.now() < r.blockedUntil)
    return { ok: false, minutesLeft: Math.ceil((r.blockedUntil - Date.now()) / 60000) };
  return { ok: true };
}

function recordFail(ip: string): void {
  const r = loginAttempts.get(ip) || { count: 0 };
  r.count++;
  if (r.count >= MAX_ATTEMPTS) {
    r.blockedUntil = Date.now() + BLOCK_MS;
    r.count = 0;
    logger.warn({ ip }, 'Dashboard login temporarily blocked');
  }
  loginAttempts.set(ip, r);
}

// ── IP Helpers ─────────────────────────────────────────────────────────────

function getClientIP(req: { header: (name: string) => string | undefined }): string {
  return req.header('x-forwarded-for')?.split(',')[0].trim()
    ?? req.header('x-real-ip')
    ?? '127.0.0.1';
}

function isLocalIP(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
    || ip.startsWith('192.168.')
    || ip.startsWith('10.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function isIPAllowed(ip: string): boolean {
  if (!DASHBOARD_ALLOWED_IPS) return true;
  const allowed = DASHBOARD_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.some((entry) => {
    // CIDR-lite: match by prefix up to the mask boundary
    if (entry.includes('/')) {
      const [base, bits] = entry.split('/');
      const mask = parseInt(bits, 10);
      // Convert to numeric and compare masked bits
      const toNum = (a: string) => a.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0);
      const ipNum = toNum(ip);
      const baseNum = toNum(base);
      const maskNum = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
      return (ipNum & maskNum) === (baseNum & maskNum);
    }
    return ip === entry || ip.startsWith(entry);
  });
}

// ── OTP State ────────────────────────────────────────────────────────────

interface PendingOTP { code: string; ip: string; expiresAt: number; attempts: number }
const pendingOTPs = new Map<string, PendingOTP>();
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_MAX_ATTEMPTS = 3;

function generateOTP(): string {
  return Math.floor(100_000 + Math.random() * 900_000).toString();
}

function generateChallenge(): string {
  return crypto.randomBytes(20).toString('hex');
}

// ── Static File Helpers ──────────────────────────────────────────────────

const DASHBOARD_DIR = path.join(PROJECT_ROOT, 'dashboard');
const ALLOWED_STATIC = new Set(['app.js', 'style.css']);

function readDashFile(name: string): string | null {
  try { return fs.readFileSync(path.join(DASHBOARD_DIR, name), 'utf-8'); } catch { return null; }
}

function getMonthlyCost(chatId: string): number {
  return getDashboardCostTimeline(chatId, 30).reduce((s, d) => s + d.cost, 0);
}

export function startDashboard(botApi?: Api<RawApi>): void {
  if (!DASHBOARD_TOKEN) {
    logger.info('DASHBOARD_TOKEN not set, dashboard disabled');
    return;
  }

  const app = new Hono();

  // Security headers
  app.use('*', async (c, next) => {
    c.header('X-Frame-Options', 'DENY');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    await next();
  });

  app.onError((err, c) => {
    logger.error({ err: err.message }, 'Dashboard error');
    return c.json({ error: 'Internal server error' }, 500);
  });

  // ── PWA / static assets (no auth required) ───────────────────────

  app.get('/manifest.json', (c) => {
    const content = readDashFile('manifest.json');
    if (!content) return c.notFound();
    return new Response(content, { headers: { 'Content-Type': 'application/json' } });
  });

  app.get('/sw.js', (c) => {
    const content = readDashFile('sw.js');
    if (!content) return c.notFound();
    return new Response(content, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Service-Worker-Allowed': '/' },
    });
  });

  app.get('/icon.svg', (c) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#4f46e5"/><text y="75" x="10" font-size="70">🤖</text></svg>`;
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } });
  });

  app.get('/static/:file', (c) => {
    const file = c.req.param('file');
    if (!ALLOWED_STATIC.has(file)) return c.notFound();
    const content = readDashFile(file);
    if (!content) return c.notFound();
    const type = file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8';
    return new Response(content, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache, no-store, must-revalidate' } });
  });

  // ── IP Allowlist middleware (applied before auth, skips PWA assets) ──

  if (DASHBOARD_ALLOWED_IPS) {
    // Block non-allowlisted IPs on all routes except bare PWA assets
    app.use('*', async (c, next) => {
      const p = c.req.path;
      // Allow PWA/static assets without IP check
      if (p === '/manifest.json' || p === '/sw.js' || p === '/icon.svg' || p.startsWith('/static/')) {
        await next();
        return;
      }
      const ip = getClientIP(c.req);
      if (!isIPAllowed(ip)) {
        logger.warn({ ip, path: p }, 'Dashboard blocked: IP not in allowlist');
        return c.json({ error: 'Access denied' }, 403);
      }
      await next();
    });
  }

  // ── Auth routes ───────────────────────────────────────────────────

  app.get('/login', (c) => {
    const sid = sessionFromCookie(c.req.header('cookie'));
    if (sid && validateSession(sid)) return c.redirect('/');
    const content = readDashFile('login.html');
    if (!content) return c.text('Login page missing', 500);
    return c.html(content);
  });

  app.post('/auth/login', async (c) => {
    const ip = getClientIP(c.req);
    const rate = checkRate(ip);
    if (!rate.ok) return c.json({ error: `Too many attempts. Try again in ${rate.minutesLeft} min.` }, 429);

    const body = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
    const submittedToken = 'token' in body ? body.token?.trim() : undefined;
    if (!submittedToken || submittedToken !== DASHBOARD_TOKEN) {
      recordFail(ip);
      return c.json({ error: 'Invalid token' }, 401);
    }
    loginAttempts.delete(ip);

    // OTP: remote logins require Telegram verification when enabled
    if (DASHBOARD_OTP_ENABLED && !isLocalIP(ip) && botApi && ALLOWED_CHAT_ID) {
      const code = generateOTP();
      const challenge = generateChallenge();
      pendingOTPs.set(challenge, { code, ip, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });
      try {
        await botApi.sendMessage(
          ALLOWED_CHAT_ID,
          `🔐 *Dashboard login from* \`${ip}\`\n\nVerification code: *${code}*\n\nExpires in 5 minutes. Do not share this code.`,
          { parse_mode: 'Markdown' },
        );
      } catch (err) {
        logger.error({ err }, 'Failed to send OTP via Telegram');
        pendingOTPs.delete(challenge);
        return c.json({ error: 'Failed to send verification code via Telegram' }, 500);
      }
      logger.info({ ip }, 'OTP sent for dashboard login');
      return c.json({ ok: false, pending: true, challenge });
    }

    // Direct session (local IP or OTP disabled)
    const sessionId = createSession();
    logActivity('dashboard_login', `Dashboard login from ${ip}`);
    c.header('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DASHBOARD_SESSION_TTL_HOURS * 3600}`);
    return c.json({ ok: true });
  });

  // OTP verification (second factor for remote logins)
  app.post('/auth/verify', async (c) => {
    const ip = getClientIP(c.req);
    const body = await c.req.json<{ challenge?: string; code?: string }>().catch(() => ({}));
    const challenge = 'challenge' in body ? body.challenge?.trim() : undefined;
    const code = 'code' in body ? body.code?.trim() : undefined;

    if (!challenge || !code) return c.json({ error: 'Missing challenge or code' }, 400);

    const pending = pendingOTPs.get(challenge);
    if (!pending) return c.json({ error: 'Invalid or expired request' }, 401);
    if (Date.now() > pending.expiresAt) { pendingOTPs.delete(challenge); return c.json({ error: 'Code expired' }, 401); }
    if (pending.ip !== ip) return c.json({ error: 'IP mismatch' }, 401);

    pending.attempts++;
    if (pending.attempts > OTP_MAX_ATTEMPTS) {
      pendingOTPs.delete(challenge);
      return c.json({ error: 'Too many failed attempts' }, 429);
    }
    if (code !== pending.code) return c.json({ error: 'Invalid code' }, 401);

    pendingOTPs.delete(challenge);
    const sessionId = createSession();
    logActivity('dashboard_login', `Dashboard login via OTP from ${ip}`);
    c.header('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DASHBOARD_SESSION_TTL_HOURS * 3600}`);
    return c.json({ ok: true });
  });

  app.post('/auth/logout', (c) => {
    const sid = sessionFromCookie(c.req.header('cookie'));
    if (sid) sessions.delete(sid);
    c.header('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return c.json({ ok: true });
  });

  // ── Auth middleware for all remaining routes ─────────────────────

  app.use('*', async (c, next) => {
    const sid = sessionFromCookie(c.req.header('cookie'));
    if (sid && validateSession(sid)) { await next(); return; }
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Unauthorized' }, 401);
    return c.redirect('/login');
  });

  // Main dashboard
  app.get('/', (c) => {
    const content = readDashFile('index.html');
    if (!content) return c.text('Dashboard files not found. Check dashboard/ directory.', 500);
    return c.html(content);
  });

  // ── Tasks ─────────────────────────────────────────────────────────────────

  app.get('/api/tasks', (c) => c.json({ tasks: getAllScheduledTasks() }));
  app.delete('/api/tasks/:id', (c) => { deleteScheduledTask(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/tasks/:id/pause', (c) => { pauseScheduledTask(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/tasks/:id/resume', (c) => { resumeScheduledTask(c.req.param('id')); return c.json({ ok: true }); });

  // ── Memories ───────────────────────────────────────────────────────────

  app.get('/api/memories', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    return c.json({
      stats: getDashboardMemoryStats(chatId),
      fading: getDashboardLowSalienceMemories(chatId, 10),
      topAccessed: getDashboardTopAccessedMemories(chatId, 5),
      timeline: getDashboardMemoryTimeline(chatId, 30),
      consolidations: getDashboardConsolidations(chatId, 5),
    });
  });

  app.get('/api/memories/list', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const sortBy = (c.req.query('sort') || 'importance') as 'importance' | 'salience' | 'recent';
    return c.json(getDashboardMemoriesList(chatId, limit, offset, sortBy));
  });

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/api/health', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    const sessionId = getSession(chatId);
    let contextPct = 0, turns = 0, compactions = 0, sessionAge = '-';
    if (sessionId) {
      const summary = getSessionTokenUsage(sessionId);
      if (summary) {
        turns = summary.turns;
        compactions = summary.compactions;
        const ctx = (summary.lastContextTokens || 0) + (summary.lastCacheRead || 0);
        contextPct = ctx > 0 ? Math.round((ctx / CONTEXT_LIMIT) * 100) : 0;
        const ageSec = Math.floor(Date.now() / 1000) - summary.firstTurnAt;
        sessionAge = ageSec < 3600 ? Math.floor(ageSec / 60) + 'm'
          : ageSec < 86400 ? Math.floor(ageSec / 3600) + 'h'
          : Math.floor(ageSec / 86400) + 'd';
      }
    }
    return c.json({
      contextPct, turns, compactions, sessionAge,
      model: agentDefaultModel || 'claude-opus-4-6',
      telegramConnected: getTelegramConnected(),
      waConnected: WHATSAPP_ENABLED,
      slackConnected: !!SLACK_USER_TOKEN,
    });
  });

  // ── Tokens / Cost ──────────────────────────────────────────────────

  app.get('/api/tokens', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    return c.json({
      stats: getDashboardTokenStats(chatId),
      costTimeline: getDashboardCostTimeline(chatId, 30),
      recentUsage: getDashboardRecentTokenUsage(chatId, 20),
    });
  });

  // ── Budget ──────────────────────────────────────────────────────────────

  app.get('/api/budget', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    const stats = getDashboardTokenStats(chatId);
    const monthlySpent = getMonthlyCost(chatId);
    const daily = DASHBOARD_DAILY_BUDGET_USD > 0
      ? { spent: stats.todayCost, limit: DASHBOARD_DAILY_BUDGET_USD, pct: Math.round((stats.todayCost / DASHBOARD_DAILY_BUDGET_USD) * 100) }
      : null;
    const monthly = DASHBOARD_MONTHLY_BUDGET_USD > 0
      ? { spent: monthlySpent, limit: DASHBOARD_MONTHLY_BUDGET_USD, pct: Math.round((monthlySpent / DASHBOARD_MONTHLY_BUDGET_USD) * 100) }
      : null;
    return c.json({ daily, monthly });
  });

  // ── Cost Control ─────────────────────────────────────────────────────

  app.get('/api/cost-control', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    const dbMeta = getAppSettingMeta('SAFE_MAX_COST_PER_DAY_USD');
    const envLimit = SAFE_MAX_COST_PER_DAY_USD;
    const effectiveLimit = dbMeta !== undefined ? parseFloat(dbMeta.value) : envLimit;
    const todaySpend = getTodayCostUsd();
    const pct = effectiveLimit > 0 ? Math.round((todaySpend / effectiveLimit) * 100) : 0;
    return c.json({
      limit: effectiveLimit,
      source: dbMeta !== null ? 'dashboard' : 'env',
      envDefault: envLimit,
      todaySpend,
      pct,
      updatedAt: dbMeta?.updated_at ?? null,
    });
  });

  app.post('/api/cost-control', async (c) => {
    const body = await c.req.json<{ limit?: number }>().catch(() => ({}));
    const limit = 'limit' in body ? body.limit : undefined;
    if (limit === undefined || typeof limit !== 'number' || limit < 0 || limit > 1000) {
      return c.json({ error: 'Invalid limit. Must be a number between 0 and 1000.' }, 400);
    }
    setAppSetting('SAFE_MAX_COST_PER_DAY_USD', limit.toString());
    logActivity('cost_limit_updated', `Daily cost limit set to $${limit.toFixed(2)} from dashboard`);
    logger.info({ newLimit: limit }, 'Daily cost limit updated from dashboard');
    return c.json({ ok: true, limit });
  });

  // ── Info ────────────────────────────────────────────────────────────────

  app.get('/api/info', (c) => {
    const info = getBotInfo();
    return c.json({
      botName: info.name || 'ClaudeClaw',
      botUsername: info.username || '',
      pid: process.pid,
      defaultChatId: ALLOWED_CHAT_ID || '',
    });
  });

  // ── Agents ──────────────────────────────────────────────────────────────

  app.get('/api/agents', (c) => {
    const agents = listAgentIds().map((id) => {
      try {
        const config = loadAgentConfig(id);
        const pidFile = path.join(STORE_DIR, `agent-${id}.pid`);
        let running = false;
        if (fs.existsSync(pidFile)) {
          try { process.kill(parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10), 0); running = true; } catch { /* dead */ }
        }
        const stats = getAgentTokenStats(id);
        return { id, name: config.name, description: config.description, model: config.model ?? 'claude-opus-4-6', running, todayTurns: stats.todayTurns, todayCost: stats.todayCost };
      } catch { return { id, name: id, description: '', model: 'unknown', running: false, todayTurns: 0, todayCost: 0 }; }
    });
    const mainPid = path.join(STORE_DIR, 'claudeclaw.pid');
    let mainRunning = false;
    if (fs.existsSync(mainPid)) {
      try { process.kill(parseInt(fs.readFileSync(mainPid, 'utf-8').trim(), 10), 0); mainRunning = true; } catch { /* dead */ }
    }
    const mainStats = getAgentTokenStats('main');
    return c.json({ agents: [{ id: 'main', name: 'Main', description: 'Primary ClaudeClaw bot', model: 'claude-opus-4-6', running: mainRunning, todayTurns: mainStats.todayTurns, todayCost: mainStats.todayCost }, ...agents] });
  });

  app.get('/api/agents/:id/conversation', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    const limit = parseInt(c.req.query('limit') || '4', 10);
    return c.json({ turns: getAgentRecentConversation(c.req.param('id'), chatId, limit) });
  });

  app.get('/api/agents/:id/tasks', (c) => c.json({ tasks: getAllScheduledTasks(c.req.param('id')) }));
  app.get('/api/agents/:id/tokens', (c) => c.json(getAgentTokenStats(c.req.param('id'))));

  // ── Cost breakdown ────────────────────────────────────────────────────
  app.get('/api/cost-breakdown', (c) => {
    return c.json({
      today: getAgentCostBreakdown(1),
      week: getAgentCostBreakdown(7),
      outliers: getTopCostlyQueries(10, 7),
    });
  });

  // ── Hive Mind ──────────────────────────────────────────────────────────

  app.get('/api/hive-mind', (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    return c.json({ entries: getHiveMindEntries(limit, c.req.query('agent') || undefined) });
  });

  // ── MCP Status ────────────────────────────────────────────────────────

  app.get('/api/mcp-status', async (c) => {
    const mcps = [
      {
        id: 'coach',
        name: 'Coach MCP',
        type: 'remote' as const,
        url: 'https://mac-mini-de-chris.tail8b8656.ts.net/mcp',
        description: 'WHOOP, Hevy, Apple Health',
      },
      {
        id: 'notion',
        name: 'Notion',
        type: 'remote' as const,
        url: 'https://mcp.notion.com/mcp',
        description: 'Workspace, pages, databases',
      },
      {
        id: 'ynab',
        name: 'YNAB',
        type: 'local' as const,
        script: '/Users/chris/ynab-mcp/start-ynab-mcp.sh',
        entry: '/Users/chris/ynab-mcp/server.mjs',
        description: 'Budget, transactions, spending',
      },
      {
        id: 'caldav',
        name: 'CalDAV',
        type: 'local' as const,
        script: path.join(PROJECT_ROOT, 'scripts/start-caldav-mcp.sh'),
        entry: path.join(PROJECT_ROOT, 'caldav-mcp/dist/index.js'),
        description: 'Yandex Calendar events',
      },
    ];

    const results = await Promise.all(mcps.map(async (mcp) => {
      const base = { id: mcp.id, name: mcp.name, description: mcp.description, type: mcp.type };
      try {
        if (mcp.type === 'remote') {
          const controller = new AbortController();
          const start = Date.now();
          const timeout = setTimeout(() => controller.abort(), 8000);
          // Use GET -- remote MCP servers respond to any HTTP method; we just want reachability
          const res = await fetch(mcp.url, {
            method: 'GET',
            signal: controller.signal,
          }).catch(() => null);
          clearTimeout(timeout);
          const latencyMs = Date.now() - start;
          if (!res) return { ...base, status: 'down', latencyMs, error: 'Connection timeout' };
          // Any HTTP response (even 4xx/5xx) means the server is reachable and running
          return { ...base, status: 'up', latencyMs, httpStatus: res.status };
        } else {
          // Local: check script + entry exist
          const scriptExists = fs.existsSync(mcp.script);
          const entryExists = fs.existsSync(mcp.entry);
          if (!scriptExists) return { ...base, status: 'down', error: `Script missing: ${mcp.script}` };
          if (!entryExists) return { ...base, status: 'down', error: `Entry missing: ${mcp.entry}` };
          // Try a quick MCP handshake via stdio
          const { execFile } = await import('child_process');
          const result = await new Promise<{ status: string; latencyMs: number; error?: string }>((resolve) => {
            const start = Date.now();
            const proc = execFile(mcp.script, [], { timeout: 10000, env: { ...process.env } });
            let output = '';
            let settled = false;
            const done = (status: string, error?: string) => {
              if (settled) return;
              settled = true;
              proc.kill();
              resolve({ status, latencyMs: Date.now() - start, error });
            };
            proc.stdout?.on('data', (d: Buffer) => {
              output += d.toString();
              // If we get any JSON-RPC response, it's alive
              if (output.includes('"jsonrpc"')) done('up');
            });
            proc.stderr?.on('data', () => {}); // ignore stderr
            proc.on('error', (e) => done('down', e.message));
            proc.on('close', (code) => {
              if (!settled) {
                const isUp = code === 0 || output.includes('"jsonrpc"');
                done(isUp ? 'up' : 'down', isUp ? undefined : `Exit code: ${code}`);
              }
            });
            // Send MCP initialize request
            const initMsg = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'health-check', version: '1.0' } } });
            proc.stdin?.write(`Content-Length: ${Buffer.byteLength(initMsg)}\r\n\r\n${initMsg}`);
            proc.stdin?.end();
            setTimeout(() => done('timeout', 'No response within 10s'), 10000);
          });
          return { ...base, ...result };
        }
      } catch (e: any) {
        return { ...base, status: 'down', error: e.message || 'Unknown error' };
      }
    }));

    return c.json({ mcps: results, checkedAt: Math.floor(Date.now() / 1000) });
  });

  // ── Skills ──────────────────────────────────────────────────────────────

  app.get('/api/skills', (c) => c.json({ skills: listSkills() }));

  app.post('/api/skills/:name/toggle', (c) => {
    const name = c.req.param('name');
    const result = toggleSkill(name);
    if (!result.ok) return c.json({ error: result.error }, 404);
    logActivity('skill_toggled', `Skill "${name}" ${result.enabled ? 'enabled' : 'disabled'}`);
    return c.json({ ok: true, enabled: result.enabled });
  });

  // ── Activity ───────────────────────────────────────────────────────────

  app.get('/api/activity', (c) => {
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    return c.json({ entries: getActivityLog(limit, offset, c.req.query('type') || undefined) });
  });

  // ── Chat ────────────────────────────────────────────────────────────────

  app.get('/api/chat/stream', (c) =>
    streamSSE(c, async (stream) => {
      const state = getIsProcessing();
      await stream.writeSSE({ event: 'processing', data: JSON.stringify({ processing: state.processing, chatId: state.chatId }) });
      const handler = async (event: ChatEvent) => {
        try { await stream.writeSSE({ event: event.type, data: JSON.stringify(event) }); } catch { /* disconnected */ }
      };
      chatEvents.on('chat', handler);
      const ping = setInterval(async () => {
        try { await stream.writeSSE({ event: 'ping', data: '' }); } catch { clearInterval(ping); }
      }, 30_000);
      try { await new Promise<void>((_, rej) => { stream.onAbort(() => rej(new Error('abort'))); }); }
      catch { /* expected */ } finally { clearInterval(ping); chatEvents.off('chat', handler); }
    }),
  );

  app.get('/api/chat/history', (c) => {
    const chatId = c.req.query('chatId') || ALLOWED_CHAT_ID || '';
    if (!chatId) return c.json({ error: 'chatId required' }, 400);
    const limit = parseInt(c.req.query('limit') || '40', 10);
    const beforeId = c.req.query('beforeId');
    return c.json({ turns: getConversationPage(chatId, limit, beforeId ? parseInt(beforeId, 10) : undefined) });
  });

  app.post('/api/chat/send', async (c) => {
    if (!botApi) return c.json({ error: 'Bot API not available' }, 503);
    const body = await c.req.json<{ message?: string }>();
    const message = body?.message?.trim();
    if (!message) return c.json({ error: 'message required' }, 400);
    void processMessageFromDashboard(botApi, message);
    return c.json({ ok: true });
  });

  app.post('/api/chat/abort', (c) => {
    const { chatId } = getIsProcessing();
    if (!chatId) return c.json({ ok: false, reason: 'not_processing' });
    return c.json({ ok: abortActiveQuery(chatId) });
  });

  serve({ fetch: app.fetch, port: DASHBOARD_PORT }, () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard server running');
  });
}
