/**
 * End-to-end smoke: simulate a memory-ingest with entities and topics,
 * verify they land in kg_entities / kg_observations with the right agent_id.
 */

import { initDatabase, getDbInstance } from '../src/db.js';
import { ingestConversationTurn } from '../src/memory-ingest.js';

const CHAT_ID = 'kg-sync-test';
const AGENT_ID = 'dratlas';

async function run() {
  initDatabase();
  const db = getDbInstance();

  // Clean previous runs for this test chat so repeated runs are idempotent
  db.prepare("DELETE FROM memories WHERE chat_id = ?").run(CHAT_ID);
  db.prepare("DELETE FROM kg_observations WHERE entity_id IN (SELECT id FROM kg_entities WHERE chat_id = ?)").run(CHAT_ID);
  db.prepare("DELETE FROM kg_entities WHERE chat_id = ?").run(CHAT_ID);

  const userMsg = "Today's leg workout was 4x8 squats at 140kg, felt strong. Recovery from last week's rib injury is progressing well, no sharp pain on rotation anymore.";
  const assistantMsg = "Solid work. Noting the squat progress and rib recovery trend for future programming.";

  console.log('Ingesting...');
  const saved = await ingestConversationTurn(CHAT_ID, userMsg, assistantMsg, AGENT_ID);
  console.log(`ingested: ${saved}`);

  const memRow = db.prepare("SELECT entities, topics FROM memories WHERE chat_id = ?").get(CHAT_ID) as { entities: string; topics: string } | undefined;
  console.log(`memory entities: ${memRow?.entities}`);
  console.log(`memory topics:   ${memRow?.topics}`);

  const entities = db.prepare("SELECT name, entity_type, importance, agent_id FROM kg_entities WHERE chat_id = ?").all(CHAT_ID);
  console.log(`\nKG entities created: ${entities.length}`);
  for (const e of entities) console.log(`  ${JSON.stringify(e)}`);

  const obs = db.prepare(`
    SELECT e.name, o.content, o.agent_id
    FROM kg_observations o JOIN kg_entities e ON o.entity_id = e.id
    WHERE e.chat_id = ?
  `).all(CHAT_ID);
  console.log(`\nKG observations: ${obs.length}`);
  for (const o of obs) console.log(`  ${JSON.stringify(o)}`);

  console.log('\nDone.');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
