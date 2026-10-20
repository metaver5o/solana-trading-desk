// PAPER — the forward-test runner. This is the honest path to "make it profit":
// it trades the signal on paper, applies real friction, and reports whether a
// higher score actually earns a higher net return. No wallet, no risk.
//
//   node src/paper.js            # one round: open new signals + mark + report
//   node src/paper.js mark       # just re-price open positions (run often)
//   node src/paper.js report     # print the scorecard, no new data
//   node src/paper.js --loop 15  # open+mark+report every 15 min (leave running)
//
// The verdict lives in the "expectancy by score band" table. If it climbs with
// score AND the top band is positive, the signal has an edge worth funding.
// If it's flat or negative, you just avoided a bleak — for free.

import { scan } from './agents/scanner.js';
import { analyze } from './agents/setup.js';
import { size } from './agents/risk.js';
import { enrich } from './data/dexscreener.js';
import { openPositions, mark, all } from './paper/ledger.js';
import { CONFIG } from './config.js';

async function openNew(nowMs) {
  const { passed } = await scan();
  const scored = analyze(passed);
  // For measurement we open ALL sized signals (the human gate is what we're
  // trying to inform, so we don't pre-filter it here).
  const proposals = size(scored, { openPositions: 0, deployedSol: 0 });
  return openPositions(proposals, nowMs);
}

async function markOpen(nowMs) {
  const open = all().filter((p) => p.status === 'open');
  if (!open.length) return { closed: 0, stillOpen: 0 };
  const rows = await enrich([...new Set(open.map((p) => p.mint))]);
  const priceMap = new Map(rows.map((r) => [r.mint, r.priceUsd]));
  return mark(priceMap, nowMs);
}

function report() {
  const pos = all();
  const closed = pos.filter((p) => p.status !== 'open');
  const open = pos.filter((p) => p.status === 'open');

  console.log(`\n════ PAPER SCORECARD ════`);
  console.log(`positions: ${pos.length}  ·  closed: ${closed.length}  ·  open: ${open.length}`);
  console.log(`friction: ${(CONFIG.paperFrictionBps / 100).toFixed(1)}% round-trip  ·  TP ${CONFIG.tpBps / 100}%  ·  SL ${CONFIG.slBps / 100}% of entry\n`);

  if (!closed.length) {
    console.log('No closed positions yet. Keep the loop running:  node src/paper.js --loop 15\n');
    if (open.length) previewOpen(open);
    return;
  }

  const wins = closed.filter((p) => p.netRet > 0);
  const losses = closed.filter((p) => p.netRet <= 0);
  const winRate = (100 * wins.length) / closed.length;
  const expPct = mean(closed.map((p) => p.netRet));
  const totalPnl = closed.reduce((s, p) => s + (p.pnlSol || 0), 0);
  const byReason = tally(closed.map((p) => p.status));

  console.log(`OVERALL (net of friction)`);
  console.log(`  win rate     ${winRate.toFixed(1)}%   (${wins.length}W / ${losses.length}L)`);
  console.log(`  expectancy   ${sign(expPct)}%  per trade`);
  console.log(`  avg win      ${sign(mean(wins.map((p) => p.netRet)) || 0)}%   avg loss  ${sign(mean(losses.map((p) => p.netRet)) || 0)}%`);
  console.log(`  paper P&L    ${sign4(totalPnl)} SOL  across ${closed.length} closed`);
  console.log(`  exits        ${Object.entries(byReason).map(([k, v]) => `${k}:${v}`).join('  ')}`);

  console.log(`\nEXPECTANCY BY SCORE BAND  ← the question that matters`);
  const bands = [[85, 101], [75, 85], [65, 75], [55, 65]];
  console.log(`  band     n    win%   expectancy`);
  for (const [lo, hi] of bands) {
    const b = closed.filter((p) => p.score >= lo && p.score < hi);
    if (!b.length) { console.log(`  ${lo}-${hi - 1}    0     —      —`); continue; }
    const wr = (100 * b.filter((p) => p.netRet > 0).length) / b.length;
    console.log(`  ${lo}-${hi - 1}   ${String(b.length).padStart(2)}    ${wr.toFixed(0).padStart(3)}%   ${sign(mean(b.map((p) => p.netRet)))}%`);
  }
  const top = closed.filter((p) => p.score >= 75);
  const bot = closed.filter((p) => p.score < 75);
  console.log(`\nVERDICT`);
  if (top.length >= 5 && bot.length >= 5) {
    const dt = mean(top.map((p) => p.netRet)), db = mean(bot.map((p) => p.netRet));
    const edge = dt > 0 && dt > db;
    console.log(`  high-score (75+) expectancy ${sign(dt)}%  vs  low-score ${sign(db)}%`);
    console.log(`  ${edge ? '🟢 signal shows an edge — worth a small funded trial with tight caps' : '🔴 no edge yet — do NOT fund; tune setup.js weights or gather more samples'}`);
  } else {
    console.log(`  Not enough closed samples yet (${closed.length}). Aim for 30+ before trusting this.`);
  }
  if (open.length) previewOpen(open);
  console.log('');
}

function previewOpen(open) {
  console.log(`\nOPEN (unrealized)`);
  for (const p of open.slice(0, 10)) {
    console.log(`  ${String(p.score).padStart(3)}  ${p.symbol.padEnd(10).slice(0, 10)}  ${sign(p.retPct)}%   MFE ${sign(p.mfePct)}% / MAE ${sign(p.maePct)}%   (${p.marks} marks)`);
  }
}

// ---- helpers ----
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const sign = (n) => (n >= 0 ? '+' : '') + n.toFixed(1);
const sign4 = (n) => (n >= 0 ? '+' : '') + n.toFixed(4);
const tally = (a) => a.reduce((m, k) => ((m[k] = (m[k] || 0) + 1), m), {});

// ---- CLI ----
const cmd = process.argv[2];
const loopIdx = process.argv.indexOf('--loop');

async function round(nowMs, { open = true } = {}) {
  if (open) {
    const o = await openNew(nowMs);
    const { closed, stillOpen } = await markOpen(nowMs);
    console.log(`opened ${o} · closed ${closed} · open ${stillOpen}`);
  } else {
    const { closed, stillOpen } = await markOpen(nowMs);
    console.log(`closed ${closed} · open ${stillOpen}`);
  }
}

if (cmd === 'report') {
  report();
} else if (cmd === 'mark') {
  await round(Date.now(), { open: false });
  report();
} else if (loopIdx !== -1) {
  const mins = Number(process.argv[loopIdx + 1]) || 15;
  console.log(`Paper forward-test looping every ${mins} min. Ctrl-C to stop.`);
  await round(Date.now()); report();
  setInterval(async () => { try { await round(Date.now()); report(); } catch (e) { console.error('round error:', e.message); } }, mins * 60000);
} else {
  await round(Date.now()); report();
}
