// Proposal queue — the approval boundary. The desk WRITES proposals here;
// nothing executes until a human flips one to "approved". Plain JSON on disk so
// you can inspect or hand-edit it. Statuses: pending → approved → executed,
// or pending → rejected, or → expired.

import fs from 'node:fs';
import { PROPOSALS_FILE, ensureData } from './config.js';

function load() {
  ensureData();
  if (!fs.existsSync(PROPOSALS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(PROPOSALS_FILE, 'utf8')); }
  catch { return []; }
}
function save(list) {
  ensureData();
  fs.writeFileSync(PROPOSALS_FILE, JSON.stringify(list, null, 2));
}

let _seq = 0;
function id(now) {
  _seq += 1;
  return `${now.toString(36)}-${_seq.toString(36)}`;
}

export function all() { return load(); }
export function pending() { return load().filter((p) => p.status === 'pending'); }
export function approved() { return load().filter((p) => p.status === 'approved'); }

// Add freshly-generated proposals. De-dupes against still-pending mints so a
// re-scan doesn't stack duplicates for the same token.
export function enqueue(items, nowMs) {
  const list = load();
  const openMints = new Set(list.filter((p) => ['pending', 'approved', 'executed'].includes(p.status)).map((p) => p.mint));
  let added = 0;
  for (const it of items) {
    if (openMints.has(it.mint)) continue;
    list.push({ id: id(nowMs), status: 'pending', createdAt: new Date(nowMs).toISOString(), ...it });
    openMints.add(it.mint);
    added += 1;
  }
  save(list);
  return added;
}

export function setStatus(ids, status, extra = {}) {
  const list = load();
  const want = new Set(ids);
  let n = 0;
  for (const p of list) {
    if (want.has(p.id) || (ids[0] === '--all' && p.status === 'pending')) {
      p.status = status; Object.assign(p, extra); n += 1;
    }
  }
  save(list);
  return n;
}

export function countOpen() {
  return load().filter((p) => ['approved', 'executed'].includes(p.status)).length;
}
export function deployedSol() {
  return load().filter((p) => ['approved', 'executed'].includes(p.status)).reduce((s, p) => s + (p.sizeSol || 0), 0);
}
