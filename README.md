# Memecoiner Paper Lab v0.3.0

Two experimental paper strategies on free Solana discovery/account data. No wallet keys, real orders or signing code. Start with `START_MEMECOINER.bat` on Windows, or `npm ci` then `npm run app`. Dashboard: http://127.0.0.1:3210.

## Upgrading from v0.2

Stop the old process, pull the update, install dependencies, then restart. Keep your existing `.env` and API key. New settings have defaults; `.env.example` documents them. If your `.env` uses the old `wss://api.mainnet.solana.com/` default, change it to `wss://api.mainnet-beta.solana.com/` (or retain a working provider endpoint).

The first v0.3 run starts two new 10 SOL ledgers because v0.2 did not save recoverable position state. Existing logs are preserved; new paper rows carry position/run identifiers and an execution-model label, so do not combine old and new P&L. Subsequent v0.3 restarts restore cash, traded mints and open positions from `data/paper-state-v3.json`. Pending entry signals are deliberately cancelled on restart. A second process using that state path is refused. Never delete a checkpoint just to hide an unresolved position; for a separate experiment use separate state, journal and health paths while stopped.

## What changed

- Wall-clock supervision runs independently of token updates. Open positions keep their watches. Missing prices display **STALE / UNRESOLVED** and trigger bounded refreshes; an exit needs a fresh quote, never a fabricated stale-price fill.
- The setup requires a chronological peak → decline → subsequent trough → recovery. Rising prices alone cannot satisfy the dip rule. Repeated migration messages cannot reset a live setup.
- Paper buys and sells use constant-product reserve quotes, actual simulated token amounts, liquidity/impact checks, 500 ms minimum execution delay, and a later quote. Entries expire after five seconds or excessive adverse movement. Fees remain a configurable **estimate**, not a replica of dynamic on-chain fees.
- Confirmed vault updates retain slots and connection generations. Both vaults must match slots; mismatches fetch a common RPC snapshot and rebaseline without counting intervening movement as trade volume. RPC snapshots never count as trades. Reconnects rebaseline, and older slots are rejected.
- Canonical pool PDA, creator, program owner, discriminator and vault identity are checked. Only supported SOL PumpSwap pools are eligible. Raydium and unsupported pool modes are logged and skipped.
- Pre- and post-migration flow windows are separate. Displayed counts represent inferred flow samples, **not** distinct trades or buyers. Dust samples below 0.001 SOL do not count toward buying activity.
- Ordered event processing, compressed log rotation, operational health records, durable ledger checkpoints and idempotent journal recovery replace unbounded raw logging and in-memory-only balances.

## Strategy defaults

Shared entry conditions:

- migration within 120 seconds, at least three seconds of setup observation;
- at least five post-migration inferred flow samples;
- an observed decline of 8–40% from a preceding peak;
- recovery remains at or below that setup peak;
- two qualifying buy samples and at least 0.1 SOL of buying in the last ten seconds;
- at least 10 SOL quote liquidity; estimated entry impact at most 2%;
- quote age at most three seconds and execution slippage at most 3%;
- one open position per bot, one completed entry per mint per ledger.

| Rule | Hybrid V2 | Migration Scalp V2 |
|---|---|---|
| Pre-migration activity score | ≥75 | Not required |
| Recovery from trough | ≥4% | ≥3% |
| Buy/sell flow ratio | ≥1.2 | ≥1.05 |
| Net liquidation stop | −10% | −15% |
| Net profit target | +100% | +25% |
| Giveback exit | 35% of peak profit after +25% | 35% of peak profit after +12% |
| Other exits | Profitable flow reversal; 180 seconds | 120 seconds |

Net liquidation returns include modeled reserve impact and fees. Stops/targets request delayed exits; actual simulated fills can be worse. Migration's smaller target and earlier giveback protection are **provisional scalp defaults**, not thresholds optimized on the flawed old run. Hybrid retains runner-style exits. Neither strategy includes verified holder, bundle, developer or social safety analysis yet.

The September 23–24 v0.2 archive had 241 completed Migration trades (−3.0380 SOL) and 123 Hybrid trades (+0.2103 SOL). Migration gained ~0.834 SOL in the first partial hour (eight trades), later lost ground and became blocked by a quiet open position. Its larger count is not evidence of a better edge: it lacked Hybrid's pre-score filter, and both used flawed dip/fill logic. Do not optimize against those profits.

## Logs and operation

- `data/events.jsonl`: raw market/control/snapshot events with run ID and sequence.
- `data/paper-trades.jsonl`: entry/exit reasoning, position ID, signal time, quote slot, simulated tokens and model.
- `data/health.jsonl`: session config (without secrets/endpoints), discovery/expiry/capacity, subscription errors, decisions, stale positions and periodic health.
- `data/paper-state-v3.json`: authoritative ledger with a recoverable journal outbox.

Logs rotate at 64 MiB and compress to timestamped `.gz` files. Keep archives for replay; rotation bounds individual file size, not total retention. Logs and state are git-ignored. Copy the active logs **and archives** after stopping if requesting analysis. Disk/state errors stop the lab rather than continue unjournaled trading. Malformed checkpoints/journals fail startup rather than reset balances silently.

Account updates are still sampled inferences. Same-slot pairing is not a transaction-level feed; liquidity events and netted trades remain limitations. The quote simulator estimates fees and assumes standard constant-product pools; it is not live execution validation. Free endpoint rate limits can delay/skip candidates. A fresh RPC quote lets an unresolved exit complete when available; a genuinely unavailable market remains explicitly unresolved and blocks that bot.

Validate a short new session before leaving it overnight: verify both bots remain supervised, check health logs for unexplained gaps, and compare strategies over the same interval. Keep raw evidence; do not drop tiny updates merely to reduce disk usage.

## Development

`npm ci`, `npm run check`, `npm run build`. Tests cover quiet-feed timeout/recovery, real ordered dips versus rallies, low liquidity, delayed execution, restart recovery, duplicate migrations, coherent vault handling and log rotation. CI uses a locked dependency graph on Node 20.

Canonical pool validation follows the [official PumpSwap pool layout](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md) and [canonical creator definition](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_PROGRAM_README.md). Fee rates are intentionally labeled estimated because the protocol's current schedule is dynamic.

## v0.3.1: PumpSwap discovery repair

v0.3.0 rejected pools with nonzero virtual quote reserves. In the affected runtime, all 150 discovery attempts failed, so both paper strategies had no PumpSwap input. v0.3.1 supports signed virtual quote reserves and prices against real plus virtual reserves, per the [official PumpSwap quoting specification](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md#quoting-effective-quote-reserves). Actual vault liquidity remains separate for entry safeguards and sell availability. Mayhem and cashback modes remain excluded.

Pool metadata is monitored and refreshed with vault balances. A reserve-model change invalidates the previous quote and rebaselines sampling. The dashboard shows active PumpSwap pools, discovery failures and the latest error on hover. Strategy thresholds are unchanged. Existing paper state is preserved.

After pulling, restart the bot and refresh the dashboard. A successful feed produces active pools and PUMPSWAP LIVE rows; trades still require a qualifying dip/recovery setup. Regression coverage includes a recorded mainnet pool, signed reserve decoding, real-liquidity gating and metadata changes. A live read-only check confirmed pool discovery, vault reads and inferred buy/sell flow.
