// WEB — a local control room for the desk. Same code paths as the CLI:
// runCycle() to scan, the proposal queue to review/approve/reject, and the
// preflight checks. It can approve. It cannot spend: there is deliberately no
// execute route. Execution stays a separate, deliberate act (src/execute.js).
//
//   node src/web.js             # http://127.0.0.1:4777
//   WEB_PORT=8080 node src/web.js
//
// Bound to 127.0.0.1 only. Every write needs a per-process token embedded in
// the page, and requests must target a loopback Host, so another website open
// in your browser can't approve trades through this server.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, ROOT } from './config.js';
import { all, setStatus, countOpen, deployedSol } from './proposals.js';
import { runCycle } from './agents/headofdesk.js';
import { preflightChecks, hasWallet } from './execution/traderouter.js';

const PORT = Number(process.env.WEB_PORT) || 4777;
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const PAGE = fs.readFileSync(path.join(ROOT, 'src', 'web', 'index.html'), 'utf8').replace('__DESK_TOKEN__', TOKEN);
const LOOPBACK_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

let scanning = false;
let lastScan = null;

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON')); } });
  });
}

function state() {
  return {
    mode: CONFIG.dryRun ? 'DRY_RUN' : 'LIVE',
    walletLoaded: hasWallet(),
    limits: {
      maxBuySol: CONFIG.maxBuySol,
      maxDeployedSol: CONFIG.maxDeployedSol,
      maxPositions: CONFIG.maxPositions,
      maxDailyLossSol: CONFIG.maxDailyLossSol,
      slippageBps: CONFIG.defaultSlippageBps,
      tpBps: CONFIG.tpBps,
      slBps: CONFIG.slBps,
    },
    openPositions: countOpen(),
    deployedSol: deployedSol(),
    proposals: all().slice().reverse(),
    scanning,
    lastScan,
  };
}

// Only proposals still pending can change status from the UI.
function decide(ids, status) {
  const pendingIds = new Set(all().filter((p) => p.status === 'pending').map((p) => p.id));
  const ok = (Array.isArray(ids) ? ids : []).filter((id) => pendingIds.has(id));
  if (!ok.length) return 0;
  const stamp = status === 'approved' ? 'approvedAt' : 'rejectedAt';
  return setStatus(ok, status, { [stamp]: new Date().toISOString(), decidedVia: 'web' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!LOOPBACK_HOSTS.has(req.headers.host)) return send(res, 421, { error: 'loopback only' });

    if (req.method === 'GET' && req.url === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && req.url === '/api/state') return send(res, 200, state());

    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    if (req.headers['x-desk-token'] !== TOKEN) return send(res, 403, { error: 'bad token' });
    const body = await readJson(req);

    if (req.url === '/api/scan') {
      if (scanning) return send(res, 409, { error: 'scan already running' });
      scanning = true;
      try {
        const r = await runCycle(Date.now());
        lastScan = { at: new Date().toISOString(), scanned: r.scanned, passed: r.passedGates, rejected: r.rejectedGates, added: r.added };
        return send(res, 200, { lastScan, state: state() });
      } finally { scanning = false; }
    }
    if (req.url === '/api/approve') return send(res, 200, { changed: decide(body.ids, 'approved'), state: state() });
    if (req.url === '/api/reject') return send(res, 200, { changed: decide(body.ids, 'rejected'), state: state() });
    if (req.url === '/api/preflight') {
      const checks = await preflightChecks();
      return send(res, 200, { checks, ok: checks.every((c) => c.pass) });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Desk UI on http://${HOST}:${PORT}  [${CONFIG.dryRun ? 'DRY RUN' : 'LIVE'}]`);
  console.log('It can approve. It cannot spend. Execute with: node src/execute.js');
});
