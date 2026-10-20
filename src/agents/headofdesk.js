// HEAD OF DESK — the coordinator. Runs one full cycle: scan → analyze → size →
// enqueue as proposals. Escalates ONLY what clears risk, exactly like the "head
// of desk sends the owner only the trades that need approval" pattern — minus
// the theater. Returns a summary for the console; the durable output is the
// proposal queue on disk.

import { scan } from './scanner.js';
import { analyze } from './setup.js';
import { size } from './risk.js';
import { enqueue, countOpen, deployedSol } from '../proposals.js';

export async function runCycle(nowMs) {
  const { scanned, passed, rejected } = await scan();
  const scored = analyze(passed);
  const proposals = size(scored, { openPositions: countOpen(), deployedSol: deployedSol() });
  const added = enqueue(proposals, nowMs);

  return {
    scanned,
    passedGates: passed.length,
    rejectedGates: rejected.length,
    topScored: scored.slice(0, 8),
    proposed: proposals,
    added,
  };
}
