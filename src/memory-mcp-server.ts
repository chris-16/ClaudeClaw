#!/usr/bin/env node
/**
 * Memory MCP Server for ClaudeClaw
 *
 * Exposes 11 tools over stdio (MCP protocol):
 *   9 standard Memory MCP tools (create_entities, create_relations, add_observations,
 *     delete_entities, delete_observations, delete_relations, read_graph, search_nodes, open_nodes)
 *   2 custom tools (search_memory, get_insights)
 *   2 Notion-sync tools (mark_synced_to_notion, get_unsynced_entities)
 *
 * Runs as a separate process spawned by Claude Code per tool call.
 * Shares the bot's SQLite DB (WAL mode + busy_timeout handles concurrency).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  openStandaloneDb,
  createEntity,
  createRelation,
  addObservations,
  deleteEntity,
  deleteObservations,
  deleteRelation,
  readGraph,
  searchNodes,
  searchNodesSemantic,
  openNodes,
  getInsights,
  markSyncedToNotion,
  getUnsyncedEntities,
} from './knowledge-graph.js';

// ── Resolve project root and load .env ──────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Minimal .env reader: the MCP server is spawned without the bot's config
// pipeline, so we pull the couple of env vars we need directly. Keeps the
// server self-contained and avoids importing the heavier config.ts path.
function loadEnvVar(key: string): string {
  const envPath = path.join(PROJECT_ROOT, '.env');
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      if (k !== key) continue;
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch { /* no .env, that's OK for delete-only usage */ }
  return '';
}

const googleApiKey = loadEnvVar('GOOGLE_API_KEY');
if (googleApiKey) {
  process.env.GOOGLE_API_KEY = googleApiKey;
}
const defaultChatId = loadEnvVar('ALLOWED_CHAT_ID');

// ── Initialize DB ────────────────────────────────────────────────────

const dbPath = path.join(PROJECT_ROOT, 'store', 'claudeclaw.db');
openStandaloneDb(dbPath);

// ── MCP Server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: 'claudeclaw-memory',
  version: '1.0.0',
});

function resolveChatId(chatId: string | undefined): string {
  return chatId || defaultChatId || 'default';
}

// ── Tool: create_entities ────────────────────────────────────────────

server.tool(
  'create_entities',
  'Create multiple new entities in the knowledge graph',
  {
    entities: z.array(
      z.object({
        name: z.string().describe('Entity name'),
        entityType: z.string().describe('Entity type (person, project, concept, preference, etc.)'),
        observations: z.array(z.string()).describe('Observations about this entity'),
        importance: z.number().min(0).max(1).optional().describe('Importance 0-1 (default 0.5)'),
      }),
    ).describe('Entities to create'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ entities, chatId }) => {
    const cid = resolveChatId(chatId);
    const created: Array<{ name: string; type: string; id: number }> = [];
    for (const e of entities) {
      const entity = createEntity(cid, e.name, e.entityType, e.importance ?? 0.5, e.observations);
      created.push({ name: entity.name, type: entity.entity_type, id: entity.id });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ created }, null, 2) }] };
  },
);

// ── Tool: create_relations ───────────────────────────────────────────

server.tool(
  'create_relations',
  'Create relations between entities in the knowledge graph',
  {
    relations: z.array(
      z.object({
        from: z.string().describe('Source entity name'),
        to: z.string().describe('Target entity name'),
        relationType: z.string().describe('Type of relation (e.g., "works_at", "knows", "uses")'),
      }),
    ).describe('Relations to create'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ relations, chatId }) => {
    const cid = resolveChatId(chatId);
    const created: Array<{ from: string; to: string; type: string }> = [];
    for (const r of relations) {
      const rel = createRelation(cid, r.from, r.to, r.relationType);
      if (rel) created.push({ from: r.from, to: r.to, type: r.relationType });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ created }, null, 2) }] };
  },
);

// ── Tool: add_observations ───────────────────────────────────────────

server.tool(
  'add_observations',
  'Add observations to existing entities in the knowledge graph',
  {
    observations: z.array(
      z.object({
        entityName: z.string().describe('Name of the entity to add observations to'),
        contents: z.array(z.string()).describe('Observation strings to add'),
      }),
    ).describe('Observations to add per entity'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ observations, chatId }) => {
    const cid = resolveChatId(chatId);
    const results: Array<{ entity: string; added?: number; error?: string }> = [];
    for (const o of observations) {
      const nodes = openNodes(cid, [o.entityName]);
      if (nodes.length === 0) {
        results.push({ entity: o.entityName, error: 'Entity not found' });
        continue;
      }
      // createEntity is idempotent (ON CONFLICT DO UPDATE) — use it to get the id
      const entity = createEntity(cid, o.entityName, nodes[0].entityType, nodes[0].importance);
      const added = addObservations(entity.id, o.contents);
      results.push({ entity: o.entityName, added: added.length });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
  },
);

// ── Tool: delete_entities ────────────────────────────────────────────

server.tool(
  'delete_entities',
  'Delete entities and their observations/relations from the knowledge graph',
  {
    entityNames: z.array(z.string()).describe('Names of entities to delete'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ entityNames, chatId }) => {
    const cid = resolveChatId(chatId);
    const deleted: string[] = [];
    for (const name of entityNames) {
      if (deleteEntity(cid, name)) deleted.push(name);
    }
    return { content: [{ type: 'text', text: JSON.stringify({ deleted }, null, 2) }] };
  },
);

// ── Tool: delete_observations ────────────────────────────────────────

server.tool(
  'delete_observations',
  'Delete specific observations from entities',
  {
    deletions: z.array(
      z.object({
        entityName: z.string().describe('Entity name'),
        observations: z.array(z.string()).describe('Exact observation texts to delete'),
      }),
    ).describe('Observations to delete per entity'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ deletions, chatId }) => {
    const cid = resolveChatId(chatId);
    const results: Array<{ entity: string; deleted: number }> = [];
    for (const d of deletions) {
      const count = deleteObservations(d.entityName, cid, d.observations);
      results.push({ entity: d.entityName, deleted: count });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
  },
);

// ── Tool: delete_relations ───────────────────────────────────────────

server.tool(
  'delete_relations',
  'Delete relations between entities',
  {
    relations: z.array(
      z.object({
        from: z.string().describe('Source entity name'),
        to: z.string().describe('Target entity name'),
        relationType: z.string().describe('Relation type to delete'),
      }),
    ).describe('Relations to delete'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ relations, chatId }) => {
    const cid = resolveChatId(chatId);
    const deleted: Array<{ from: string; to: string; type: string }> = [];
    for (const r of relations) {
      if (deleteRelation(cid, r.from, r.to, r.relationType)) {
        deleted.push({ from: r.from, to: r.to, type: r.relationType });
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ deleted }, null, 2) }] };
  },
);

// ── Tool: read_graph ─────────────────────────────────────────────────

server.tool(
  'read_graph',
  'Read the entire knowledge graph (all entities, observations, and relations)',
  {
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ chatId }) => {
    const cid = resolveChatId(chatId);
    const graph = readGraph(cid);
    return { content: [{ type: 'text', text: JSON.stringify(graph, null, 2) }] };
  },
);

// ── Tool: search_nodes ───────────────────────────────────────────────

server.tool(
  'search_nodes',
  'Search for entities by name or content (keyword-based FTS5 search)',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().describe('Max results (default 10)'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ query, limit, chatId }) => {
    const cid = resolveChatId(chatId);
    const results = searchNodes(cid, query, limit ?? 10);
    return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
  },
);

// ── Tool: open_nodes ─────────────────────────────────────────────────

server.tool(
  'open_nodes',
  'Open specific entities by name to see their full observations',
  {
    names: z.array(z.string()).describe('Entity names to open'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ names, chatId }) => {
    const cid = resolveChatId(chatId);
    const results = openNodes(cid, names);
    return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
  },
);

// ── Tool: search_memory (custom) ─────────────────────────────────────

server.tool(
  'search_memory',
  'Semantic search across the knowledge graph using embeddings. Falls back to keyword search if embeddings unavailable.',
  {
    query: z.string().describe('Natural language search query'),
    limit: z.number().optional().describe('Max results (default 10)'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ query, limit, chatId }) => {
    const cid = resolveChatId(chatId);
    const results = await searchNodesSemantic(cid, query, limit ?? 10);
    return { content: [{ type: 'text', text: JSON.stringify({ results }, null, 2) }] };
  },
);

// ── Tool: get_insights (custom) ──────────────────────────────────────

server.tool(
  'get_insights',
  'Get high-level insights about the knowledge graph: entity count, top entities, types, recent activity',
  {
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ chatId }) => {
    const cid = resolveChatId(chatId);
    const insights = getInsights(cid);
    return { content: [{ type: 'text', text: JSON.stringify(insights, null, 2) }] };
  },
);

// ── Tool: mark_synced_to_notion ───────────────────────────────────────

server.tool(
  'mark_synced_to_notion',
  'Mark an entity as synced to Notion with its page ID. Call this after creating/updating a Notion page for an entity.',
  {
    entityName: z.string().describe('Name of the entity that was synced'),
    notionPageId: z.string().describe('Notion page ID where this entity was saved'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ entityName, notionPageId, chatId }) => {
    const cid = resolveChatId(chatId);
    const success = markSyncedToNotion(cid, entityName, notionPageId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ entityName, notionPageId, synced: success }),
      }],
    };
  },
);

// ── Tool: get_unsynced_entities ──────────────────────────────────────

server.tool(
  'get_unsynced_entities',
  'Get important entities that need syncing to Notion (not yet synced, or modified since last sync). Use this to find entities worth persisting to Notion as structured knowledge.',
  {
    minImportance: z.number().min(0).max(1).optional().describe('Minimum importance threshold (default 0.7)'),
    limit: z.number().optional().describe('Max results (default 20)'),
    chatId: z.string().optional().describe('Chat scope (defaults to ALLOWED_CHAT_ID)'),
  },
  async ({ minImportance, limit, chatId }) => {
    const cid = resolveChatId(chatId);
    const entities = getUnsyncedEntities(cid, minImportance ?? 0.7, limit ?? 20);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: entities.length,
          entities: entities.map((e) => ({
            name: e.name,
            entityType: e.entityType,
            importance: e.importance,
            observations: e.observations,
            notionPageId: e.notion_page_id,
          })),
        }, null, 2),
      }],
    };
  },
);

// ── Start ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Memory MCP server fatal error: ${err}\n`);
  process.exit(1);
});
