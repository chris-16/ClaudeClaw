/**
 * Smoke test: verify working memory retrieval + injection end-to-end.
 */

import { initDatabase, getWorkingMemory, saveWorkingMemorySummary } from '../src/db.js';
import { buildMemoryContext, updateWorkingMemory } from '../src/memory.js';

const CHAT_ID = '1869580094';

async function run() {
  initDatabase();

  console.log('=== Reading existing working_memory rows ===');
  for (const agent of ['main', 'axiom', 'comms', 'director', 'dratlas']) {
    const wm = getWorkingMemory(CHAT_ID, agent);
    const preview = wm ? wm.slice(0, 80).replace(/\s+/g, ' ') : '(none)';
    console.log(`${agent.padEnd(10)} ${wm ? `${wm.length}ch` : '---'}  ${preview}`);
  }

  console.log('\n=== Writing fresh summary for agent "main" ===');
  const testSummary = `TEST: Chris is testing the working memory system at ${new Date().toISOString()}. Focus: verify read/write round-trip.`;
  saveWorkingMemorySummary(CHAT_ID, 'main', testSummary);
  const reread = getWorkingMemory(CHAT_ID, 'main');
  console.log(`reread ok: ${reread === testSummary}`);

  console.log('\n=== buildMemoryContext injects working memory ===');
  const ctx = await buildMemoryContext(CHAT_ID, 'hola, qué pasa?', 'main');
  const includesWM = ctx.contextText.includes('[Working memory');
  const includesTest = ctx.contextText.includes('TEST: Chris is testing');
  console.log(`contains [Working memory] block: ${includesWM}`);
  console.log(`contains fresh summary: ${includesTest}`);
  console.log(`contextText length: ${ctx.contextText.length}ch`);

  console.log('\n=== updateWorkingMemory (Gemini) for agent "main" ===');
  const before = getWorkingMemory(CHAT_ID, 'main');
  const t0 = Date.now();
  await updateWorkingMemory(CHAT_ID, 'main');
  const after = getWorkingMemory(CHAT_ID, 'main');
  console.log(`took ${Date.now() - t0}ms`);
  console.log(`changed: ${before !== after}`);
  if (after && after !== before) {
    console.log(`new summary: ${after.slice(0, 200)}...`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
