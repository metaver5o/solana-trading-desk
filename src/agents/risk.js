// RISK MANAGER — the most important, least glamorous agent. Takes scored
// candidates and decides IF and HOW MUCH. Enforces portfolio-level limits the
// per-trade execution guards can't see: max concurrent positions, total capital
// deployed, and a minimum score to bother. Sizing scales with conviction but is
// hard-capped at MAX_BUY_SOL regardless of what the score says.

import { CONFIG } from '../config.js';

const MIN_SCORE = 55; // below this, no position — no exceptions

export function size(scored, { openPositions = 0, deployedSol = 0 } = {}) {
  const slotsLeft = Math.max(0, CONFIG.maxPositions - openPositions);
  let budgetLeft = Math.max(0, CONFIG.maxDeployedSol - deployedSol);

  const proposals = [];
  for (const t of scored) {
    if (proposals.length >= slotsLeft) break;
    if (t.score < MIN_SCORE) continue;

    // Conviction sizing: linear from MIN_SCORE..100 → 40%..100% of max buy.
    const conviction = (t.score - MIN_SCORE) / (100 - MIN_SCORE); // 0..1
    let sizeSol = CONFIG.maxBuySol * (0.4 + 0.6 * conviction);
    sizeSol = Math.min(sizeSol, CONFIG.maxBuySol, budgetLeft);
    if (sizeSol < 0.005) continue; // dust — not worth fees

    budgetLeft -= sizeSol;
    proposals.push({
      mint: t.mint,
      symbol: t.symbol,
      score: t.score,
      scoreParts: t.scoreParts,
      thesis: t.thesis,
      sizeSol: round(sizeSol, 4),
      slippageBps: CONFIG.defaultSlippageBps,
      exits: { tpBps: CONFIG.tpBps, slBps: CONFIG.slBps },
      metrics: {
        priceUsd: t.priceUsd, liquidityUsd: t.liquidityUsd, fdvUsd: t.fdvUsd,
        volH1Usd: t.volH1Usd, chg1h: t.chg1h, ageMinutes: t.ageMinutes,
      },
      url: t.url,
    });
  }
  return proposals;
}

const round = (n, d) => Number(n.toFixed(d));
