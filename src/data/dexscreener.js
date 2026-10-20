// Free, no-key Solana market data via Dexscreener.
// Used by the scanner for candidate discovery and by the setup agent for
// per-token metrics. Rate limit is ~300 req/min; we stay well under it.
//
// This is a STARTER data source, not a proven alpha feed. It tells you what is
// trending and liquid — it does not tell you what will go up. Treat every
// metric as a filter, never as a prediction.

const BASE = 'https://api.dexscreener.com';
const SOL = 'solana';

async function get(url, timeoutMs = 10000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`dexscreener ${res.status} for ${url}`);
  return res.json();
}

// Boosted + trending token mints as discovery candidates (Solana only).
export async function discoverCandidates() {
  const mints = new Set();
  for (const path of ['/token-boosts/latest/v1', '/token-boosts/top/v1', '/token-profiles/latest/v1']) {
    try {
      const rows = await get(`${BASE}${path}`);
      for (const r of Array.isArray(rows) ? rows : []) {
        if (r.chainId === SOL && r.tokenAddress) mints.add(r.tokenAddress);
      }
    } catch (e) {
      // one endpoint failing shouldn't kill discovery
      console.error(`discover: ${path} failed — ${e.message}`);
    }
  }
  return [...mints];
}

// Enrich mints with pair data. Returns one normalized row per token,
// picking that token's deepest-liquidity Solana pair.
export async function enrich(mints) {
  const out = [];
  // Dexscreener tokens endpoint accepts up to 30 comma-separated addresses.
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    let data;
    try {
      data = await get(`${BASE}/latest/dex/tokens/${batch.join(',')}`);
    } catch (e) {
      console.error(`enrich batch failed — ${e.message}`);
      continue;
    }
    const byToken = new Map();
    for (const pair of data.pairs || []) {
      if (pair.chainId !== SOL) continue;
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      const prev = byToken.get(mint);
      const liq = pair.liquidity?.usd || 0;
      if (!prev || liq > (prev.liquidity?.usd || 0)) byToken.set(mint, pair);
    }
    for (const [mint, p] of byToken) out.push(normalize(mint, p));
  }
  return out;
}

function normalize(mint, p) {
  const ageMs = p.pairCreatedAt ? Date.now() - p.pairCreatedAt : null;
  return {
    mint,
    symbol: p.baseToken?.symbol || '???',
    name: p.baseToken?.name || '',
    priceUsd: Number(p.priceUsd) || 0,
    liquidityUsd: p.liquidity?.usd || 0,
    fdvUsd: p.fdv || p.marketCap || 0,
    marketCapUsd: p.marketCap || p.fdv || 0,
    volH1Usd: p.volume?.h1 || 0,
    volH24Usd: p.volume?.h24 || 0,
    chg5m: p.priceChange?.m5 ?? 0,
    chg1h: p.priceChange?.h1 ?? 0,
    chg6h: p.priceChange?.h6 ?? 0,
    chg24h: p.priceChange?.h24 ?? 0,
    buysH1: p.txns?.h1?.buys || 0,
    sellsH1: p.txns?.h1?.sells || 0,
    ageMinutes: ageMs != null ? Math.round(ageMs / 60000) : null,
    dexId: p.dexId || '',
    url: p.url || '',
  };
}
