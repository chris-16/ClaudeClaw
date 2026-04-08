/**
 * GlassClaw Bridge — Ray-Ban Meta glasses → Claude Code SDK
 *
 * Adds /api/glasses/* endpoints and a /v1/chat/completions compat layer
 * to the ClaudeClaw dashboard. Reuses runAgent() for Claude inference,
 * the existing session table for persistence, and the cost tracking pipeline.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import crypto from 'crypto';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';

import { runAgent, type AgentContent } from './agent.js';
import { AGENT_ID, AGENT_TIMEOUT_MS, agentDefaultModel } from './config.js';
import { getSession, setSession, saveTokenUsage } from './db.js';
import { analyzeVideo } from './gemini.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

// ── Config ──────────────────────────────────────────────────────────

/** Read GLASSES_TOKEN from env (set in .env, not process.env) */
const glassesEnv = readEnvFile(['GLASSES_TOKEN']);
const GLASSES_TOKEN = process.env.GLASSES_TOKEN || glassesEnv.GLASSES_TOKEN || '';

// ── Active requests (for cancellation) ──────────────────────────────

const activeAborts = new Map<string, AbortController>();

function glassesSessionKey(deviceId: string): string {
  return `glasses:${deviceId}`;
}

// ── Auth middleware ──────────────────────────────────────────────────

function checkGlassesAuth(authHeader: string | undefined): boolean {
  if (!GLASSES_TOKEN) return true; // dev mode: no token = open
  if (!authHeader) return false;
  return authHeader === `Bearer ${GLASSES_TOKEN}`;
}

// ── Vision helpers ─────────────────────────────────────────────────

/** Known video MIME types that should be routed to Gemini instead of Claude. */
const VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg']);

type ImageMedia = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

interface ExtractedMedia {
  text: string;
  images: Array<{ base64: string; mediaType: ImageMedia }>;
  video: { base64: string; mimeType: string } | null;
}

/**
 * Parse a data: URI → { base64, mimeType }.
 * Returns null for non-data URIs or unparseable values.
 */
function parseDataUri(url: string): { base64: string; mimeType: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

/**
 * Extract text, images, and video from OpenAI-format message content.
 * Handles both string content and array content with text/image_url parts.
 */
function extractMediaFromOpenAI(content: unknown): ExtractedMedia {
  const result: ExtractedMedia = { text: '', images: [], video: null };

  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  if (!Array.isArray(content)) {
    result.text = String(content ?? '');
    return result;
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      textParts.push(part.text);
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const parsed = parseDataUri(part.image_url.url);
      if (!parsed) continue;
      if (VIDEO_MIMES.has(parsed.mimeType)) {
        result.video = parsed;
      } else {
        result.images.push({
          base64: parsed.base64,
          mediaType: parsed.mimeType as ImageMedia,
        });
      }
    }
  }

  result.text = textParts.join('\n');
  return result;
}

/**
 * Build Anthropic ContentBlockParam[] from text + images.
 */
function buildMultimodalContent(
  text: string,
  images: Array<{ base64: string; mediaType: ImageMedia }>,
): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  for (const img of images) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }
  blocks.push({ type: 'text', text });
  return blocks;
}

/**
 * Process extracted media into AgentContent ready for runAgent().
 * Images → multimodal content blocks. Video → Gemini analysis prepended to text.
 */
async function resolveMedia(media: ExtractedMedia): Promise<AgentContent> {
  let text = media.text;

  // Route video through Gemini
  if (media.video) {
    try {
      const analysis = await analyzeVideo(
        media.video.base64,
        media.video.mimeType,
        `Analyze this video. The user asks: "${text}". Provide a detailed description of what you see and hear.`,
      );
      text = `[Video analysis via Gemini]:\n${analysis}\n\nUser question: ${text}`;
    } catch (err) {
      logger.error({ err }, 'Gemini video analysis failed');
      text = `[Video was sent but analysis failed: ${err instanceof Error ? err.message : 'unknown error'}]\n\n${text}`;
    }
  }

  // Build multimodal content if there are images
  if (media.images.length > 0) {
    return buildMultimodalContent(text, media.images);
  }

  return text;
}

// ── Glasses-native SSE routes (/api/glasses/*) ──────────────────────

export const glassesRoutes = new Hono();

glassesRoutes.use('*', async (c, next) => {
  if (!checkGlassesAuth(c.req.header('Authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

glassesRoutes.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'glassclaw', timestamp: Date.now() });
});

/**
 * POST /api/glasses/query
 * Main endpoint — accepts a voice query, returns SSE stream with events:
 * accepted, tool_status, partial, final, done, cancelled, error
 */
glassesRoutes.post('/query', (c) => {
  return streamSSE(c, async (stream) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'Invalid JSON', retryable: false }) });
      return;
    }

    const { text, device_id, image_base64, image_media_type, video_base64, video_media_type } = body as {
      text?: string; device_id?: string;
      image_base64?: string; image_media_type?: string;
      video_base64?: string; video_media_type?: string;
    };

    if (!text || !device_id) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'text and device_id required', retryable: false }) });
      return;
    }

    const requestId = crypto.randomUUID();
    const chatId = glassesSessionKey(device_id);
    const sessionId = getSession(chatId, AGENT_ID);

    // Cancel previous request for this device
    const prevAbort = activeAborts.get(device_id);
    if (prevAbort) {
      prevAbort.abort();
      activeAborts.delete(device_id);
    }

    const abortCtrl = new AbortController();
    activeAborts.set(device_id, abortCtrl);

    await stream.writeSSE({
      event: 'accepted',
      data: JSON.stringify({ request_id: requestId, session_id: sessionId ?? 'new' }),
    });

    // Build content — supports image and video from native glasses endpoint
    const media: ExtractedMedia = { text, images: [], video: null };
    if (image_base64) {
      media.images.push({
        base64: image_base64,
        mediaType: (image_media_type as ImageMedia) || 'image/jpeg',
      });
    }
    if (video_base64) {
      media.video = { base64: video_base64, mimeType: video_media_type || 'video/mp4' };
    }
    const agentContent = await resolveMedia(media);

    const timeout = setTimeout(() => {
      logger.warn({ device_id, requestId }, 'Glasses query timed out');
      abortCtrl.abort();
    }, AGENT_TIMEOUT_MS);

    try {
      const result = await runAgent(
        agentContent,
        sessionId,
        () => {},
        async (event) => {
          try {
            if (event.type === 'tool_active') {
              await stream.writeSSE({
                event: 'tool_status',
                data: JSON.stringify({ tool: event.description, status: 'running' }),
              });
            } else if (event.type === 'task_completed') {
              await stream.writeSSE({
                event: 'tool_status',
                data: JSON.stringify({ tool: event.description, status: 'completed' }),
              });
            }
          } catch { /* stream closed */ }
        },
        agentDefaultModel,
        abortCtrl,
      );

      clearTimeout(timeout);
      activeAborts.delete(device_id);

      if (result.newSessionId) {
        setSession(chatId, result.newSessionId, AGENT_ID);
      }

      if (result.usage) {
        try {
          saveTokenUsage(
            chatId, result.newSessionId ?? sessionId,
            result.usage.inputTokens, result.usage.outputTokens,
            result.usage.lastCallCacheRead, result.usage.lastCallInputTokens,
            result.usage.totalCostUsd, result.usage.didCompact, AGENT_ID,
          );
        } catch (dbErr) {
          logger.error({ err: dbErr }, 'Failed to save glasses token usage');
        }
      }

      if (result.aborted) {
        await stream.writeSSE({
          event: 'cancelled',
          data: JSON.stringify({ request_id: requestId, reason: 'aborted' }),
        });
      } else {
        const finalText = result.text?.trim() || '';
        const activeSession = result.newSessionId ?? sessionId ?? 'unknown';
        await stream.writeSSE({
          event: 'final',
          data: JSON.stringify({ text: finalText, session_id: activeSession }),
        });
        await stream.writeSSE({ event: 'done', data: '{}' });
      }
    } catch (err: unknown) {
      clearTimeout(timeout);
      activeAborts.delete(device_id);
      const errMsg = err instanceof Error ? err.message : 'Internal error';
      logger.error({ err: errMsg, device_id }, 'Glasses query error');
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ message: errMsg, retryable: true }),
      });
    }
  });
});

/**
 * POST /api/glasses/cancel
 */
glassesRoutes.post('/cancel', async (c) => {
  const body = await c.req.json<{ device_id?: string }>();
  const { device_id } = body;
  if (!device_id) return c.json({ error: 'device_id required' }, 400);

  const abortCtrl = activeAborts.get(device_id);
  if (!abortCtrl) return c.json({ error: 'no active request' }, 404);

  abortCtrl.abort();
  activeAborts.delete(device_id);
  return c.json({ cancelled: true });
});

// ── OpenAI-compatible compat layer (/v1/chat/completions) ───────────
// Lets Ray-Ban Meta / OpenGlasses connect via standard OpenAI format.

export const compatRoutes = new Hono();

compatRoutes.use('*', async (c, next) => {
  if (!checkGlassesAuth(c.req.header('Authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

/** GET /v1/models — minimal model list for client compatibility */
compatRoutes.get('/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      {
        id: agentDefaultModel || 'claude-opus-4-6',
        object: 'model',
        owned_by: 'anthropic',
      },
    ],
  });
});

compatRoutes.post('/chat/completions', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const messages = (body.messages as Array<{ role: string; content: unknown }>) || [];
  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMsg) {
    return c.json({ error: 'No user message' }, 400);
  }

  // Log incoming request structure for debugging vision support
  logger.info({
    model: body.model,
    messageCount: messages.length,
    lastMsgContentType: typeof lastUserMsg.content,
    lastMsgIsArray: Array.isArray(lastUserMsg.content),
    lastMsgParts: Array.isArray(lastUserMsg.content)
      ? (lastUserMsg.content as Array<{ type: string }>).map((p) => p.type)
      : undefined,
    headers: {
      'x-device-id': c.req.header('X-Device-Id'),
      'x-openclaw-session-key': c.req.header('x-openclaw-session-key'),
    },
  }, 'Compat /chat/completions request');

  // Extract text, images, and video from OpenAI vision format
  const media = extractMediaFromOpenAI(lastUserMsg.content);
  if (!media.text.trim() && media.images.length === 0 && !media.video) {
    return c.json({ error: 'No content in user message' }, 400);
  }

  // Resolve media into AgentContent (images → multimodal, video → Gemini)
  const agentContent = await resolveMedia(media);

  const deviceId = c.req.header('x-openclaw-session-key')
    || c.req.header('X-Device-Id')
    || 'openglasses-default';
  const chatId = glassesSessionKey(deviceId);
  const sessionId = getSession(chatId, AGENT_ID);

  // Cancel previous
  const prevAbort = activeAborts.get(deviceId);
  if (prevAbort) {
    prevAbort.abort();
    activeAborts.delete(deviceId);
  }

  const abortCtrl = new AbortController();
  activeAborts.set(deviceId, abortCtrl);
  const timeout = setTimeout(() => abortCtrl.abort(), AGENT_TIMEOUT_MS);
  const completionId = `chatcmpl-${crypto.randomUUID().slice(0, 8)}`;

  // ── Non-streaming mode (Ray-Ban Meta default) ──
  if (!body.stream) {
    try {
      const result = await runAgent(
        agentContent, sessionId, () => {},
        undefined, agentDefaultModel, abortCtrl,
      );

      clearTimeout(timeout);
      activeAborts.delete(deviceId);

      if (result.newSessionId) {
        setSession(chatId, result.newSessionId, AGENT_ID);
      }
      if (result.usage) {
        try {
          saveTokenUsage(
            chatId, result.newSessionId ?? sessionId,
            result.usage.inputTokens, result.usage.outputTokens,
            result.usage.lastCallCacheRead, result.usage.lastCallInputTokens,
            result.usage.totalCostUsd, result.usage.didCompact, AGENT_ID,
          );
        } catch (dbErr) {
          logger.error({ err: dbErr }, 'Failed to save compat token usage');
        }
      }

      const finalText = result.text?.trim() || '';
      return c.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: agentDefaultModel || 'claude-opus-4-6',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: finalText },
          finish_reason: result.aborted ? 'length' : 'stop',
        }],
      });
    } catch (err: unknown) {
      clearTimeout(timeout);
      activeAborts.delete(deviceId);
      const errMsg = err instanceof Error ? err.message : 'Internal error';
      logger.error({ err: errMsg }, 'Compat non-stream error');
      return c.json({ error: { message: errMsg, type: 'server_error' } }, 500);
    }
  }

  // ── Streaming mode ──
  return streamSSE(c, async (stream) => {
    let lastStreamedLength = 0;

    try {
      const result = await runAgent(
        agentContent, sessionId, () => {},
        undefined, agentDefaultModel, abortCtrl,
      );

      clearTimeout(timeout);
      activeAborts.delete(deviceId);

      if (result.newSessionId) {
        setSession(chatId, result.newSessionId, AGENT_ID);
      }
      if (result.usage) {
        try {
          saveTokenUsage(
            chatId, result.newSessionId ?? sessionId,
            result.usage.inputTokens, result.usage.outputTokens,
            result.usage.lastCallCacheRead, result.usage.lastCallInputTokens,
            result.usage.totalCostUsd, result.usage.didCompact, AGENT_ID,
          );
        } catch (dbErr) {
          logger.error({ err: dbErr }, 'Failed to save compat stream token usage');
        }
      }

      // Send the full response as a single chunk (Claude Agent SDK
      // doesn't support token-level streaming — it returns the complete result)
      const finalText = result.text?.trim() || '';
      await stream.writeSSE({
        data: JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: finalText }, finish_reason: 'stop' }],
        }),
      });
      await stream.writeSSE({ data: '[DONE]' });
    } catch (err: unknown) {
      clearTimeout(timeout);
      activeAborts.delete(deviceId);
      const errMsg = err instanceof Error ? err.message : 'Internal error';
      logger.error({ err: errMsg }, 'Compat stream error');
      await stream.writeSSE({
        data: JSON.stringify({ error: { message: errMsg, type: 'server_error' } }),
      });
    }
  });
});
