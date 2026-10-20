// PAPER LEDGER — forward-test bookkeeping. Records a paper position per signal
// at signal-time price, tracks the price path on every mark, and closes on the
// SAME TP/SL/expiry rules the live executor would use — minus friction, so the
// numbers are honest. This is how we learn whether the score means anything.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, CONFIG, ensureData } from '../config.js';

const FILE = path.join(DATA_DIR, 'paper.json');
const TP_MULT = CONFIG.tpBps / 10000;      // e.g. 2.0
const SL_MULT = CONFIG.slBps / 10000;      // e.g. 0.6
const FRICTION = CONFIG.paperFrictionBps / 10000; // e.g. 0.05

function load() {
  ensureData();
  if (!fs.existsSync(FILE)) return { positions: [] };
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { positions: [] }; }
}
function save(db) { ensureData(); fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); }

export function openPositions(proposals, nowMs) {
  const db = load();
  const held = new Set(db.positions.filter((p) => p.status === 'open').map((p) => p.mint));
  let opened = 0;
  for (const pr of proposals) {
    if (held.has(pr.mint)) continue;
    if (!(pr.metrics?.priceUsd > 0)) continue; // need a real entry price
    db.positions.push({
      id: `${nowMs.toString(36)}-${pr.mint.slice(0, 4)}`,
      mint: pr.mint, symbol: pr.symbol, score: pr.score, scoreParts: pr.scoreParts,
      sizeSol: pr.sizeSol, entryUsd: pr.metrics.priceUsd, entryAt: nowMs,
      tpMult: TP_MULT, slMult: SL_MULT, expiryHours: CONFIG.paperExpiryHours,
      status: 'open', retPct: 0, mfePct: 0, maePct: 0, lastUsd: pr.metrics.priceUsd, marks: 0,
    });
    held.add(pr.mint); opened += 1;
  }
  save(db);
  return opened;
}

// priceMap: Map<mint, priceUsd>. Marks every open position and closes those
// that hit TP, SL, or expiry. Returns { closed, stillOpen }.
export function mark(priceMap, nowMs) {
  const db = load();
  let closed = 0, stillOpen = 0;
  for (const p of db.positions) {
    if (p.status !== 'open') continue;
    const cur = priceMap.get(p.mint);
    const ageH = (nowMs - p.entryAt) / 3_600_000;

    if (cur > 0) {
      p.lastUsd = cur; p.marks += 1;
      const mult = cur / p.entryUsd;
      p.retPct = round((mult - 1) * 100);
      p.mfePct = round(Math.max(p.mfePct, (mult - 1) * 100));
      p.maePct = round(Math.min(p.maePct, (mult - 1) * 100));
      if (mult >= p.tpMult) { close(p, 'tp', p.tpMult, nowMs); closed++; continue; }
      if (mult <= p.slMult) { close(p, 'sl', p.slMult, nowMs); closed++; continue; }
    }
    if (ageH >= p.expiryHours) {
      const exitMult = cur > 0 ? cur / p.entryUsd : (p.lastUsd / p.entryUsd);
      close(p, 'expired', exitMult, nowMs); closed++; continue;
    }
    stillOpen++;
  }
  save(db);
  return { closed, stillOpen };
}

function close(p, reason, exitMult, nowMs) {
  p.status = reason;
  p.exitAt = nowMs;
  p.grossRet = round((exitMult - 1) * 100);
  p.netRet = round(((exitMult - 1) - FRICTION) * 100); // friction applied once, round-trip
  p.pnlSol = round4(p.sizeSol * ((exitMult - 1) - FRICTION));
}

export function all() { return load().positions; }

const round = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
