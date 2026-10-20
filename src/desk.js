// DESK — entry point that runs the propose cycle. Read-only: it touches no
// wallet and sends no transactions. It scans the market, ranks setups, applies
// risk sizing, and writes proposals to the queue for you to approve.
//
//   node src/desk.js            # one cycle
//   node src/desk.js --loop 15  # re-scan every 15 minutes
//
// Nothing here can lose money. The worst it can do is suggest a bad trade —
// which you then decline.

import { runCycle } from './agents/headofdesk.js';
import { CONFIG } from './config.js';

function table(rows) {
  if (!rows.length) return '  (none)';
  const line = (r) =>
    `  ${String(r.score).padStart(3)}  ${r.symbol.padEnd(10).slice(0, 10)}  ${(r.sizeSol.toFixed(3) + ' SOL').padStart(9)}  ${r.thesis}`;
  return rows.map(line).join('\n');
}

async function cycle() {
  const started = Date.now();
  const res = await runCycle(started);
  console.log(`\n════ DESK CYCLE @ ${new Date(started).toISOString()} ════`);
  console.log(`scanned ${res.scanned} · passed gates ${res.passedGates} · rejected ${res.rejectedGates}`);
  console.log(`\nTop scored candidates:`);
  console.log(table(res.topScored.map((t) => ({ score: t.score, symbol: t.symbol, sizeSol: 0, thesis: t.thesis }))
    .map((r, i) => ({ ...r, sizeSol: res.proposed[i]?.sizeSol || 0 }))));
  console.log(`\n📋 New proposals queued: ${res.added}`);
  if (res.proposed.length) {
    console.log(`\nProposals (need your approval):`);
    console.log(table(res.proposed));
    console.log(`\n→ Review:   node src/approve.js`);
    console.log(`→ Approve:  node src/approve.js <id> [id...]   (or --all)`);
    console.log(`→ Execute:  node src/execute.js                (DRY_RUN=${CONFIG.dryRun})`);
  }
  console.log('');
}

const loopArg = process.argv.indexOf('--loop');
if (loopArg !== -1) {
  const mins = Number(process.argv[loopArg + 1]) || 15;
  console.log(`Desk running in loop mode every ${mins} min. Ctrl-C to stop.`);
  await cycle();
  setInterval(() => cycle().catch((e) => console.error('cycle error:', e.message)), mins * 60000);
} else {
  await cycle();
}
