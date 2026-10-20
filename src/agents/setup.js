// SETUP ANALYST — scores each candidate 0..100 on a transparent momentum +
// liquidity-quality + flow heuristic. Every sub-score is explainable so a human
// can sanity-check the reasoning before approving. This is NOT a proven edge —
// it's a starting rubric. Tune the weights, or replace scoreOne() with your own
// model, without touching the rest of the desk.

const W = { momentum: 0.40, flow: 0.25, liquidityQuality: 0.20, freshness: 0.15 };

export function analyze(candidates) {
  return candidates
    .map((t) => {
      const parts = scoreOne(t);
      const score = Math.round(
        parts.momentum * W.momentum +
        parts.flow * W.flow +
        parts.liquidityQuality * W.liquidityQuality +
        parts.freshness * W.freshness
      );
      return { ...t, score, scoreParts: parts, thesis: thesis(t, parts) };
    })
    .sort((a, b) => b.score - a.score);
}

function scoreOne(t) {
  // Momentum: reward positive 1h/6h trend, penalize a blow-off 5m spike that
  // usually mean-reverts. Clamp so a single insane print can't dominate.
  const momentum = clamp(
    50 + 1.2 * clamp(t.chg1h, -50, 50) + 0.6 * clamp(t.chg6h, -50, 50) - 0.4 * clamp(t.chg5m, -50, 150)
  );

  // Flow: buy/sell imbalance over the last hour. 50 = balanced.
  const total = t.buysH1 + t.sellsH1;
  const flow = total > 0 ? clamp(50 + 50 * ((t.buysH1 - t.sellsH1) / total)) : 30;

  // Liquidity quality: deeper pools + healthy volume/liquidity turnover, but
  // absurd turnover (vol >> liquidity) is a wash-trading / exit-risk smell.
  const turnover = t.liquidityUsd > 0 ? t.volH1Usd / t.liquidityUsd : 0;
  const depth = clamp(20 * Math.log10(Math.max(t.liquidityUsd, 1) / 1000)); // ~$100k → ~40
  const turnScore = turnover <= 0 ? 0 : turnover < 3 ? 100 * (turnover / 3) : Math.max(0, 100 - 25 * (turnover - 3));
  const liquidityQuality = clamp(0.6 * depth + 0.4 * turnScore);

  // Freshness: prefer the young-but-not-newborn window.
  let freshness = 50;
  if (t.ageMinutes != null) {
    const h = t.ageMinutes / 60;
    freshness = h < 1 ? 40 : h < 6 ? 90 : h < 24 ? 70 : h < 48 ? 45 : 25;
  }

  return { momentum: r(momentum), flow: r(flow), liquidityQuality: r(liquidityQuality), freshness: r(freshness) };
}

function thesis(t, p) {
  const bits = [];
  bits.push(`${t.chg1h >= 0 ? '+' : ''}${t.chg1h.toFixed(0)}%/1h`);
  bits.push(`${t.buysH1}/${t.sellsH1} buys/sells`);
  bits.push(`$${short(t.liquidityUsd)} liq`);
  bits.push(`$${short(t.volH1Usd)} vol/h`);
  if (t.ageMinutes != null) bits.push(`${t.ageMinutes < 90 ? t.ageMinutes + 'm' : (t.ageMinutes / 60).toFixed(0) + 'h'} old`);
  const weak = Object.entries(p).sort((a, b) => a[1] - b[1])[0];
  return `${bits.join(' · ')} — weakest: ${weak[0]} (${weak[1]})`;
}

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const r = (n) => Math.round(n);
const short = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(Math.round(n)));
