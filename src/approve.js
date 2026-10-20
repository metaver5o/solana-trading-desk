// APPROVE — the human-in-the-loop CLI. This is the gate the LLC/Grok stories
// deliberately bypassed with "Always Allow". Here it's the whole point.
//
//   node src/approve.js                 # list pending proposals in full
//   node src/approve.js <id> [id...]    # approve specific proposals
//   node src/approve.js --all           # approve all pending
//   node src/approve.js --reject <id>   # reject
//
// Approving does NOT execute — it only marks intent. Run src/execute.js after.

import { pending, all, setStatus } from './proposals.js';

const args = process.argv.slice(2);

function show(p) {
  const m = p.metrics || {};
  console.log(`\n[${p.id}]  ${p.symbol}   score ${p.score}   size ${p.sizeSol} SOL   slippage ${p.slippageBps}bps`);
  console.log(`   ${p.thesis}`);
  console.log(`   parts: ${Object.entries(p.scoreParts || {}).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`   liq $${int(m.liquidityUsd)} · fdv $${int(m.fdvUsd)} · vol/h $${int(m.volH1Usd)} · ${m.chg1h?.toFixed(0)}%/1h`);
  console.log(`   exits: TP ${p.exits?.tpBps}bps / SL ${p.exits?.slBps}bps`);
  console.log(`   mint: ${p.mint}`);
  if (p.url) console.log(`   chart: ${p.url}`);
}

if (args.length === 0) {
  const list = pending();
  console.log(`\n${list.length} pending proposal(s):`);
  list.forEach(show);
  if (list.length) {
    console.log(`\nApprove with:  node src/approve.js ${list.map((p) => p.id).join(' ')}`);
    console.log(`Or all:        node src/approve.js --all\n`);
  } else {
    console.log('\nRun the desk first:  node src/desk.js\n');
  }
} else if (args[0] === '--reject') {
  const n = setStatus(args.slice(1), 'rejected', { rejectedAt: new Date().toISOString() });
  console.log(`Rejected ${n} proposal(s).`);
} else {
  const ids = args[0] === '--all' ? ['--all'] : args;
  const n = setStatus(ids, 'approved', { approvedAt: new Date().toISOString() });
  console.log(`✓ Approved ${n} proposal(s).`);
  const appr = all().filter((p) => p.status === 'approved');
  console.log(`  ${appr.length} total awaiting execution. Run:  node src/execute.js`);
}

const int = (n) => Math.round(n || 0).toLocaleString('en-US');
