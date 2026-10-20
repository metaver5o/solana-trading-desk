// SCANNER — pulls the candidate universe and applies hard liquidity/age/volume
// gates. Its only job: turn "everything on Solana" into a short list that isn't
// obviously a rug or dead. It ranks nothing; that's the setup agent's job.

import { discoverCandidates, enrich } from '../data/dexscreener.js';
import { CONFIG } from '../config.js';

export async function scan() {
  const mints = await discoverCandidates();
  const enriched = await enrich(mints);

  const passed = [];
  const rejected = [];
  for (const t of enriched) {
    const reason = gate(t);
    if (reason) rejected.push({ ...t, reason });
    else passed.push(t);
  }
  return { scanned: enriched.length, passed, rejected };
}

function gate(t) {
  if (t.liquidityUsd < CONFIG.minLiquidityUsd) return `liquidity $${fmt(t.liquidityUsd)} < $${fmt(CONFIG.minLiquidityUsd)}`;
  if (t.fdvUsd > CONFIG.maxFdvUsd) return `fdv $${fmt(t.fdvUsd)} > $${fmt(CONFIG.maxFdvUsd)}`;
  if (t.volH1Usd < CONFIG.minVolH1Usd) return `vol/h1 $${fmt(t.volH1Usd)} < $${fmt(CONFIG.minVolH1Usd)}`;
  if (t.ageMinutes != null) {
    if (t.ageMinutes < CONFIG.minAgeMinutes) return `age ${t.ageMinutes}m < ${CONFIG.minAgeMinutes}m`;
    if (t.ageMinutes > CONFIG.maxAgeHours * 60) return `age ${(t.ageMinutes / 60).toFixed(0)}h > ${CONFIG.maxAgeHours}h`;
  }
  return null;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
