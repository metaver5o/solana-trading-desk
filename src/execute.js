// EXECUTE — the only script that can spend. Reads APPROVED proposals, runs the
// market buy through TradeRouter, then places TP/SL limit orders over the
// WebSocket. DRY_RUN=true (default) walks the full path but submits nothing.
//
//   node src/execute.js --preflight   # checks only, no trades
//   node src/execute.js               # execute approved proposals
//
// Going live is a deliberate, separate act: set DRY_RUN=false in .env.

import { CONFIG, sol } from './config.js';
import { approved, setStatus } from './proposals.js';
import {
  preflight, marketBuy, connectWs, handleOrderFilled, hasWallet, IS_DRY_RUN, log,
} from './execution/traderouter.js';

async function main() {
  const ok = await preflight();
  if (process.argv.includes('--preflight')) process.exit(ok ? 0 : 1);
  if (!ok) { console.error('Preflight failed — aborting.'); process.exit(1); }
  if (!hasWallet()) { console.error('No PRIVATE_KEY — cannot execute.'); process.exit(1); }

  const queue = approved();
  if (!queue.length) { console.log('No approved proposals. Approve some: node src/approve.js'); process.exit(0); }

  console.log(`\nExecuting ${queue.length} approved proposal(s)  [${IS_DRY_RUN ? 'DRY RUN' : 'LIVE'}]\n`);

  // One WS connection for the exit orders placed after each fill.
  const ws = connectWs(handleOrderFilled);
  setInterval(() => ws.send({ action: 'list_orders' }), 60000); // silent-expiry guard

  for (const p of queue) {
    try {
      log({ step: 'execute_begin', id: p.id, token: p.mint, symbol: p.symbol, size_sol: p.sizeSol });
      const res = await marketBuy(p.mint, sol(p.sizeSol), p.slippageBps);

      if (res.dry_run) {
        setStatus([p.id], 'executed', { executedAt: new Date().toISOString(), dryRun: true });
        log({ step: 'execute_dry_run', id: p.id, message: 'would buy + place TP/SL' });
      } else {
        setStatus([p.id], 'executed', { executedAt: new Date().toISOString(), buySignature: res.signature });
        // Take-profit and stop-loss as limit sells vs entry mcap.
        ws.send({ action: 'sell', token_address: p.mint, holdings_percentage: 10000, target: p.exits.tpBps, slippage: p.slippageBps, expiry_hours: 144 });
        ws.send({ action: 'sell', token_address: p.mint, holdings_percentage: 10000, target: p.exits.slBps, slippage: p.slippageBps, expiry_hours: 144 });
        log({ step: 'execute_done', id: p.id, signature: res.signature });
      }
    } catch (e) {
      setStatus([p.id], 'failed', { failedAt: new Date().toISOString(), error: e.message });
      log({ step: 'execute_error', id: p.id, error: e.message });
    }
  }

  if (IS_DRY_RUN) {
    console.log('\n📋 DRY RUN complete — nothing was submitted. Set DRY_RUN=false in .env to go live.\n');
    process.exit(0);
  } else {
    console.log('\n🔴 Live orders placed. Keeping WS open 30s for exit-order confirmations...\n');
    setTimeout(() => process.exit(0), 30000);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
