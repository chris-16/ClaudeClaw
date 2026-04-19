/**
 * Benchmark memory retrieval latency + verify Layer 6 KG returns results.
 * Uses the real chat_id so we get real data + real KG hits.
 */

import { buildMemoryContext } from '../src/memory.js';
import { initDatabase } from '../src/db.js';

const CHAT_ID = '1869580094';
const AGENT_ID = 'main';

const queries = [
  '¿qué sabes sobre mi salud?',
  '¿cómo va ClaudeClaw?',
  'SuperComparador',
  'recordame los gastos recientes',
  '¿qué hablamos del value betting bot?',
];

async function run() {
  initDatabase();

  console.log('=== ClaudeClaw memory benchmark (Etapa 1) ===\n');

  for (const q of queries) {
    // Run twice to measure cold vs warm cache
    const latencies: number[] = [];
    let lastCtx = '';
    for (let i = 0; i < 2; i++) {
      const start = performance.now();
      const ctx = await buildMemoryContext(CHAT_ID, q, AGENT_ID);
      latencies.push(performance.now() - start);
      lastCtx = ctx.contextText;
    }

    const kgBlock = lastCtx.split('[Knowledge graph]')[1]?.split('[End knowledge graph]')[0] ?? '';
    const hasKg = kgBlock.length > 0;
    const kgLineCount = (kgBlock.match(/^- /gm) || []).length;
    const memLineCount = (lastCtx.match(/^- \[\d\.\d\]/gm) || []).length;

    console.log(`Q: "${q}"`);
    console.log(`   cold=${latencies[0].toFixed(0)}ms  warm=${latencies[1].toFixed(0)}ms  speedup=${(latencies[0] / latencies[1]).toFixed(1)}x`);
    console.log(`   mem=${memLineCount} kg=${kgLineCount} (KG block: ${hasKg ? 'yes' : 'NO'})`);
    console.log();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
