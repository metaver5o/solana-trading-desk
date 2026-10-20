// TradeRouter execution client — adapted from the skill's reference client.
// The ONLY module that submits transactions. All safety guards live here:
// DRY_RUN gate, per-buy cap, slippage bounds, daily-loss kill switch,
// unsellable-token cooldown, and server-signature verification on fills.

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import WebSocket from 'ws';
import Ajv from 'ajv';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { CONFIG, sol } from '../config.js';

const API = 'https://api.traderouter.ai';
const WS_URL = 'wss://api.traderouter.ai/ws';
const connection = new Connection(CONFIG.rpcUrl, 'confirmed');

const DRY_RUN = CONFIG.dryRun;
const SERVER_PUBKEY_BYTES = bs58.decode(CONFIG.serverPubkey);
const SERVER_PUBKEY_NEXT_BYTES = process.env.TRADEROUTER_SERVER_PUBKEY_NEXT
  ? bs58.decode(process.env.TRADEROUTER_SERVER_PUBKEY_NEXT)
  : null;
const REQUIRE_SERVER_SIGNATURE = CONFIG.requireServerSig;

// ---------- Safety ----------
export const SAFETY = {
  MAX_BUY_LAMPORTS: sol(CONFIG.maxBuySol),
  MAX_SLIPPAGE_BPS: 2500,
  MIN_SLIPPAGE_BPS: 100,
  MIN_VALUE_NATIVE: 0,
  UNSWAPPABLE_COOLDOWN_MS: 15 * 60 * 1000,
  MAX_DAILY_LOSS_LAMPORTS: sol(CONFIG.maxDailyLossSol),
  DENYLIST: new Map(),
  dailyLoss: 0,
};
export let KILL_SWITCH = false;
export function tripKillSwitch(reason) {
  KILL_SWITCH = true;
  log({ step: 'kill_switch', reason });
}

function isTokenOnCooldown(mint) {
  const t = SAFETY.DENYLIST.get(mint);
  if (!t) return false;
  if (Date.now() >= t) { SAFETY.DENYLIST.delete(mint); return false; }
  return true;
}
function markUnswappable(mint, err) {
  const retryAfter = Date.now() + SAFETY.UNSWAPPABLE_COOLDOWN_MS;
  SAFETY.DENYLIST.set(mint, retryAfter);
  log({ step: 'safety_blocked', token: mint, reason: 'cooldown_set', retry_after_ms: retryAfter, source_error: err });
}
function enforceSafety(action, mint, amount, slippage) {
  if (KILL_SWITCH) throw new Error('KILL_SWITCH active — execution halted');
  if (isTokenOnCooldown(mint)) throw new Error(`${mint} on cooldown`);
  if (slippage > SAFETY.MAX_SLIPPAGE_BPS) throw new Error(`slippage ${slippage} > max ${SAFETY.MAX_SLIPPAGE_BPS}`);
  if (slippage < SAFETY.MIN_SLIPPAGE_BPS) throw new Error(`slippage ${slippage} < min ${SAFETY.MIN_SLIPPAGE_BPS}`);
  if (action === 'buy' && amount > SAFETY.MAX_BUY_LAMPORTS) throw new Error(`amount ${amount} > max ${SAFETY.MAX_BUY_LAMPORTS}`);
  if (SAFETY.dailyLoss > SAFETY.MAX_DAILY_LOSS_LAMPORTS) { tripKillSwitch('daily_loss'); throw new Error('daily loss limit reached'); }
}

// ---------- Logging ----------
export function log(fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), wallet: _wallet?.publicKey?.toBase58() || 'n/a', ...fields }));
}

// ---------- Wallet ----------
let _wallet = null;
export function getWallet() {
  if (!_wallet) {
    if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY not set');
    try { _wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY)); }
    catch (e) { throw new Error(`Invalid PRIVATE_KEY: ${e.message}`); }
  }
  return _wallet;
}
export function hasWallet() { return !!process.env.PRIVATE_KEY; }

// ---------- Schemas ----------
const ajv = new Ajv({ allErrors: true, strict: false });
const validateSwap = ajv.compile({
  type: 'object', required: ['wallet_address', 'token_address', 'action'],
  properties: {
    wallet_address: { type: 'string', minLength: 32, maxLength: 44 },
    token_address: { type: 'string', minLength: 32, maxLength: 44 },
    action: { type: 'string', enum: ['buy', 'sell'] },
    amount: { type: 'integer', minimum: 1 },
    holdings_percentage: { type: 'integer', minimum: 1, maximum: 10000 },
    slippage: { type: 'integer', minimum: 100, maximum: 2500 },
  },
  if: { properties: { action: { const: 'buy' } } },
  then: { required: ['amount'], not: { required: ['holdings_percentage'] } },
  else: { required: ['holdings_percentage'], not: { required: ['amount'] } },
});
const validateOrderFilled = ajv.compile({
  type: 'object', required: ['type', 'order_id', 'order_type', 'status'],
  properties: {
    type: { const: 'order_filled' },
    order_id: { type: 'string' },
    order_type: { type: 'string', enum: ['sell', 'buy', 'trailing_sell', 'trailing_buy'] },
    status: { type: 'string', enum: ['success'] },
    already_dispatched: { type: 'boolean' },
    data: { type: 'object', properties: { swap_tx: { type: 'string', minLength: 100 } } },
  },
});
function assertSchema(fn, payload, label) {
  if (fn(payload)) return;
  throw new Error(`${label} invalid: ${ajv.errorsText(fn.errors || [], { separator: '; ' })}`);
}

// ---------- Server signature verification ----------
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canonicalize(v[k]);
    return o;
  }
  return v;
}
function canonicalJson(obj) {
  return JSON.stringify(canonicalize(obj)).replace(/[^\x00-\x7F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function verifyFillSignature(msg) {
  const sig = msg.server_signature;
  if (!sig) return !REQUIRE_SERVER_SIGNATURE;
  const KEYS = ['order_id', 'order_type', 'status', 'token_address', 'entry_mcap', 'triggered_mcap', 'filled_mcap', 'target_mcap', 'triggered_at', 'filled_at', 'data'];
  const payload = {};
  for (const k of KEYS) if (msg[k] !== undefined && msg[k] !== null) payload[k] = msg[k];
  const digest = createHash('sha256').update(Buffer.from(canonicalJson(payload), 'utf-8')).digest();
  const sigBytes = bs58.decode(sig);
  for (const key of [SERVER_PUBKEY_BYTES, SERVER_PUBKEY_NEXT_BYTES].filter(Boolean)) {
    try { if (nacl.sign.detached.verify(digest, sigBytes, key)) return true; } catch { /* next */ }
  }
  return false;
}

// ---------- REST ----------
export async function getMcap(mints) {
  const res = await fetch(`${API}/mcap?tokens=${mints.join(',')}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`mcap ${res.status}`);
  return res.json();
}

export async function getHoldings() {
  const res = await fetch(`${API}/holdings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet_address: getWallet().publicKey.toBase58() }),
    signal: AbortSignal.timeout(100000),
  });
  const json = await res.json();
  return (json.data || []).filter((t) => t.valueNative > SAFETY.MIN_VALUE_NATIVE);
}

export async function buildSwap({ mint, action, amountLamports, holdingsPct, slippage = CONFIG.defaultSlippageBps }) {
  enforceSafety(action, mint, amountLamports, slippage);
  const body = { wallet_address: getWallet().publicKey.toBase58(), token_address: mint, action, slippage };
  if (action === 'buy') body.amount = amountLamports;
  if (action === 'sell') body.holdings_percentage = holdingsPct;
  assertSchema(validateSwap, body, 'swap request');
  log({ step: 'swap_request', token: mint, action, amount: amountLamports || holdingsPct, slippage });
  const res = await fetch(`${API}/swap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (json.status !== 'success') {
    if (json.error?.includes('Error running simulation')) markUnswappable(mint, json.error);
    throw new Error(json.error || 'swap failed');
  }
  log({ step: 'swap_response', token: mint, pool_type: json.data.pool_type, amount_in: json.data.amount_in });
  return json.data;
}

export function signVersionedTx(swapTxBase58) {
  const tx = VersionedTransaction.deserialize(bs58.decode(swapTxBase58));
  tx.sign([getWallet()]);
  return Buffer.from(tx.serialize()).toString('base64');
}

export async function submitTx(signedTxBase64, { token, action } = {}) {
  if (KILL_SWITCH) throw new Error('KILL_SWITCH active');
  if (DRY_RUN) { log({ step: 'dry_run_skip', token, action, message: 'DRY_RUN=true, not submitting' }); return { signature: null, dry_run: true }; }

  const isBuy = action === 'buy' || action === 'trailing_buy';
  let balanceBefore = isBuy ? await connection.getBalance(getWallet().publicKey) : null;
  try {
    const res = await fetch(`${API}/protect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signed_tx_base64: signedTxBase64 }),
      signal: AbortSignal.timeout(30000),
    });
    if (res.status === 503) return await rpcFallback(signedTxBase64, { action, balanceBefore });
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `protect HTTP ${res.status}`);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.error || 'protect failed');
    if (isBuy && json.sol_balance_pre != null && json.sol_balance_post != null) SAFETY.dailyLoss += json.sol_balance_pre - json.sol_balance_post;
    log({ step: 'protect_success', token, signature: json.signature });
    return json;
  } catch (err) {
    if (err.name === 'TimeoutError') {
      const check = await checkTxLanded(signedTxBase64);
      if (check.status === 'failed') throw new Error(`tx ${check.sig} failed on-chain`);
      if (check.landed) {
        if (isBuy && balanceBefore != null) SAFETY.dailyLoss += balanceBefore - await connection.getBalance(getWallet().publicKey);
        log({ step: 'protect_timeout_landed', signature: check.sig, status: check.status });
        return { signature: check.sig, status: check.status, via: 'timeout_recovery' };
      }
      return await rpcFallback(signedTxBase64, { action, balanceBefore });
    }
    throw err;
  }
}

async function rpcFallback(signedTxBase64, { action, balanceBefore } = {}) {
  const sig = await connection.sendRawTransaction(Buffer.from(signedTxBase64, 'base64'), { skipPreflight: false });
  await connection.confirmTransaction(sig, 'confirmed');
  if ((action === 'buy' || action === 'trailing_buy') && balanceBefore != null) {
    SAFETY.dailyLoss += balanceBefore - await connection.getBalance(getWallet().publicKey);
  }
  log({ step: 'rpc_fallback_success', signature: sig });
  return { signature: sig, via: 'rpc_fallback' };
}

async function checkTxLanded(signedBase64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64'));
  const sig = bs58.encode(tx.signatures[0]);
  const r = (await connection.getSignatureStatuses([sig])).value[0];
  if (!r) return { landed: false, sig, status: 'not_found' };
  if (r.err) return { landed: true, sig, status: 'failed', err: r.err };
  return { landed: true, sig, status: r.confirmationStatus || 'unknown' };
}

// Convenience: full instant-buy path used by the executor.
export async function marketBuy(mint, amountLamports, slippage) {
  const swap = await buildSwap({ mint, action: 'buy', amountLamports, slippage });
  const signed = signVersionedTx(swap.swap_tx);
  return submitTx(signed, { token: mint, action: 'buy' });
}

// ---------- WebSocket (for TP/SL exit orders) ----------
export function connectWs(onOrderFilled) {
  const client = { ws: null, registered: false, pending: [] };
  function connect() {
    const ws = new WebSocket(WS_URL);
    client.ws = ws; client.registered = false;
    ws.on('open', () => log({ step: 'ws_connected' }));
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'challenge') {
        const sig = bs58.encode(nacl.sign.detached(Buffer.from(msg.nonce, 'utf-8'), getWallet().secretKey));
        ws.send(JSON.stringify({ action: 'register', wallet_address: getWallet().publicKey.toBase58(), signature: sig }));
      }
      if (msg.type === 'registered') {
        if (!msg.authenticated) return log({ step: 'ws_error', error: 'authenticated:false' });
        client.registered = true; log({ step: 'ws_registered' });
        while (client.pending.length) ws.send(JSON.stringify(client.pending.shift()));
      }
      if (msg.type === 'order_created') log({ step: 'order_placed', order_id: msg.order_id, token: msg.token_address, action: msg.order_type, target_mcap: msg.target_mcap });
      if (msg.type === 'order_filled' && onOrderFilled) await onOrderFilled(msg);
      if (msg.type === 'error') log({ step: 'ws_error', error: msg.message });
    });
    ws.on('close', () => { client.registered = false; log({ step: 'ws_disconnected' }); setTimeout(connect, 3000); });
    ws.on('error', (e) => log({ step: 'ws_error', error: e.message }));
  }
  connect();
  return {
    send: (payload) => {
      if (KILL_SWITCH) return log({ step: 'safety_blocked', action: payload.action, reason: 'KILL_SWITCH' });
      const readOnly = ['register', 'list_orders', 'check_order'];
      if (DRY_RUN && !readOnly.includes(payload.action)) return log({ step: 'dry_run_skip', action: payload.action, token: payload.token_address });
      if ((payload.action === 'buy' || payload.action === 'trailing_buy') && (typeof payload.amount !== 'number' || payload.amount > SAFETY.MAX_BUY_LAMPORTS))
        return log({ step: 'safety_blocked', action: payload.action, reason: 'amount>MAX_BUY_LAMPORTS' });
      if (!client.registered) { client.pending.push(payload); return log({ step: 'ws_queued', action: payload.action }); }
      client.ws.send(JSON.stringify(payload));
    },
    close: () => client.ws?.close(),
  };
}

export async function handleOrderFilled(msg) {
  try { assertSchema(validateOrderFilled, msg, 'order_filled'); }
  catch (e) { return log({ step: 'order_fill_error', order_id: msg.order_id || 'unknown', error: e.message }); }
  const { order_id, order_type, triggered_mcap, filled_mcap, token_address } = msg;
  log({ step: 'order_filled', order_id, order_type, token: token_address, triggered_mcap, filled_mcap });
  if (msg.already_dispatched) return log({ step: 'order_fill_skipped', order_id, reason: 'already_dispatched' });
  if (!verifyFillSignature(msg)) return log({ step: 'order_fill_skipped', order_id, reason: 'sig_verify_failed' });
  const swap_tx = msg.data?.swap_tx;
  if (!swap_tx) return log({ step: 'order_fill_error', order_id, error: 'missing swap_tx' });
  if (filled_mcap != null && filled_mcap > 0 && triggered_mcap != null && triggered_mcap / filled_mcap < 0.85)
    return log({ step: 'order_fill_skipped', order_id, reason: 'stale' });
  const result = await submitTx(signVersionedTx(swap_tx), { token: token_address, action: order_type });
  log({ step: 'order_fill_submitted', order_id, signature: result.signature });
}

// ---------- Preflight ----------
export async function preflight() {
  const checks = [];
  checks.push({ name: 'PRIVATE_KEY loaded', pass: hasWallet() });
  try { checks.push({ name: 'Wallet loads', pass: true, info: getWallet().publicKey.toBase58() }); }
  catch (e) { checks.push({ name: 'Wallet loads', pass: false, error: e.message }); }
  try { checks.push({ name: 'RPC reachable', pass: true, info: `slot ${await connection.getSlot()}` }); }
  catch (e) { checks.push({ name: 'RPC reachable', pass: false, error: e.message }); }
  try {
    const bal = await connection.getBalance(getWallet().publicKey);
    checks.push({ name: 'SOL balance > 0.01', pass: bal > 10_000_000, info: `${(bal / 1e9).toFixed(4)} SOL` });
  } catch (e) { checks.push({ name: 'SOL balance', pass: false, error: e.message }); }

  console.log('\n=== PREFLIGHT ===');
  for (const c of checks) console.log(`${c.pass ? '✓' : '✗'} ${c.name}${c.info ? `  (${c.info})` : ''}${c.error ? ` — ${c.error}` : ''}`);
  const ok = checks.every((c) => c.pass);
  console.log(`\n${ok ? '🟢 ready' : '🔴 fix failures before live'}  |  Mode: ${DRY_RUN ? '📋 DRY RUN' : '🔴 LIVE'}\n`);
  return ok;
}

export const IS_DRY_RUN = DRY_RUN;
