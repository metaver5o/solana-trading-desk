# Solana Trading Desk (propose-only)

A multi-agent Solana trading desk that does the boring 95% autonomously and
stops at the 5% that spends your money. Agents scan the market, rank setups, and
size positions; **you approve; TradeRouter executes.** No "Always Allow."

This is the honest version of the "350 bots run my desk" story: ~6 focused roles
(not 350 clones), a real approval gate, and hard risk limits — instead of
autonomy theater.

![Desk UI: run a scan, approve one proposal, reject another, preflight refuses an unfunded wallet](docs/ui-demo.gif)

*Real run from a fresh clone. The tokens are live scanner output, not
recommendations. The wallet is a brand-new throwaway with 0 SOL, so preflight
refuses to trade.*

## The desk

| Agent | File | Job |
|-------|------|-----|
| Scanner | `src/agents/scanner.js` | Pull candidate universe (Dexscreener, free), apply hard liquidity/age/volume gates |
| Setup analyst | `src/agents/setup.js` | Score 0–100 on transparent momentum + flow + liquidity-quality heuristic |
| Risk manager | `src/agents/risk.js` | Decide *if* and *how much*; enforce portfolio caps; conviction-size within `MAX_BUY_SOL` |
| Head of desk | `src/agents/headofdesk.js` | Run the cycle, escalate only what clears risk → proposal queue |
| Executor | `src/execution/traderouter.js` | The only code that spends. DRY_RUN gate, kill-switch, server-sig verify |

## Web UI

```bash
npm run web      # http://127.0.0.1:4777
```

A local control room over the same code paths as the CLI: run a desk scan,
review each proposal's score breakdown and market data, approve or reject, and
run preflight.

**It can approve. It cannot spend.** There is no execute route on the server.
Approved trades still run only when you run `node src/execute.js`.

- Binds to `127.0.0.1` only and rejects requests for any other Host
- Every write needs a per-process token embedded in the page, so another
  website open in your browser can't approve through it
- No external scripts, fonts or CDNs: the page talks only to this server

![Pending queue with score breakdown and approve/reject](docs/ui-1-queue.png)

![Preflight result and decided proposals](docs/ui-2-preflight.png)

## CLI flow

```
node src/desk.js        →  scan + rank + size  →  writes proposals (read-only, no wallet)
node src/approve.js     →  review the queue in full
node src/approve.js ID  →  mark intent to trade  (still spends nothing)
node src/execute.js     →  execute approved buys + place TP/SL  (DRY_RUN by default)
```

### What each step looks like

![CLI demo](docs/cli-demo.gif)

**1. `node src/desk.js`**: scan, gate, score and size. No wallet is touched.

![desk.js output](docs/1-desk.png)

**2. `node src/approve.js`**: the full queue, with the score breakdown, exits and chart link for each proposal.

![approve.js queue](docs/2-queue.png)

**3. `node src/approve.js <id>`**: marks intent only. Nothing is spent.

![approve.js approving one proposal](docs/3-approve.png)

**4. `node src/execute.js`**: preflight runs before anything is signed. Here the wallet is empty, so it aborts.

![execute.js preflight refusing](docs/4-preflight.png)

## Setup

```bash
npm install
cp .env.example .env      # edit limits; PRIVATE_KEY only needed to execute
node src/desk.js          # safe: no wallet touched, no orders sent
```

Going live is a deliberate, separate act: set `DRY_RUN=false` in `.env`. Until
then `execute.js` walks the entire path and submits nothing.

## Safety (all in `src/execution/traderouter.js` + `src/agents/risk.js`)

- **DRY_RUN=true by default** — no accidental live trade on first run
- **Per-buy cap** `MAX_BUY_SOL`, enforced on REST and WebSocket paths
- **Portfolio caps** `MAX_DEPLOYED_SOL`, `MAX_POSITIONS`
- **Daily-loss kill-switch** `MAX_DAILY_LOSS_SOL` → halts all execution
- **Slippage bounds** 1%–25%; **unsellable-token cooldown** 15m
- **Server-signature verification** on every fill before signing
- **Human approval** required between proposal and execution — the whole point

## Honest limits

- The scoring heuristic is a **starting rubric, not proven alpha.** It filters
  for liquid, trending, buy-pressured tokens — it does not predict price. Tune
  the weights in `setup.js` or swap in your own model; the rest of the desk
  doesn't change.
- Dexscreener free data is rate-limited and can lag. For serious use, add a
  paid data feed and a paid RPC.
- Memecoin trading loses money by default. This tool makes the process
  disciplined and auditable; it does not make it profitable. Size accordingly.
```

## License

MIT. See LICENSE.
