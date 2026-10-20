// Central config + safety limits. Loaded from environment (.env style).
// Nothing here has side effects — pure values other modules import.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');

// Tiny .env loader so we don't add a dependency just for this.
(function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, rawV] = m;
    if (process.env[k] !== undefined) continue; // real env wins
    process.env[k] = rawV.replace(/^["']|["']$/g, '');
  }
})();

const num = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const sol = (n) => Math.round(n * LAMPORTS_PER_SOL);

export const CONFIG = {
  rpcUrl: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  dryRun: process.env.DRY_RUN !== 'false', // safe-by-default

  // Sizing / portfolio (SOL)
  maxBuySol: num('MAX_BUY_SOL', 0.1),
  bankrollSol: num('BANKROLL_SOL', 1.0),
  maxDeployedSol: num('MAX_DEPLOYED_SOL', 0.5),
  maxPositions: num('MAX_POSITIONS', 5),
  maxDailyLossSol: num('MAX_DAILY_LOSS_SOL', 0.25),
  defaultSlippageBps: num('DEFAULT_SLIPPAGE_BPS', 1500),

  // Signal filters
  minLiquidityUsd: num('MIN_LIQUIDITY_USD', 25000),
  maxFdvUsd: num('MAX_FDV_USD', 15_000_000),
  minAgeMinutes: num('MIN_AGE_MINUTES', 15),
  maxAgeHours: num('MAX_AGE_HOURS', 72),
  minVolH1Usd: num('MIN_VOL_H1_USD', 20000),

  // Exit orders (bps vs entry mcap, per TradeRouter semantics)
  tpBps: num('TP_BPS', 20000),
  slBps: num('SL_BPS', 6000),

  // Paper / forward-test realism knobs
  paperFrictionBps: num('PAPER_FRICTION_BPS', 500), // round-trip slippage+fees, subtracted from every result
  paperExpiryHours: num('PAPER_EXPIRY_HOURS', 24),  // close open paper positions at mark after this

  serverPubkey: process.env.TRADEROUTER_SERVER_PUBKEY || 'EXX3nRzfDUvbjZSmxFzHDdiSYeGVP1EGr77iziFZ4Jd4',
  requireServerSig: process.env.TRADEROUTER_REQUIRE_SERVER_SIGNATURE !== 'false',
};

export const PROPOSALS_FILE = path.join(DATA_DIR, 'proposals.json');
export const LOG_FILE = path.join(DATA_DIR, 'desk.log');

export function ensureData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
