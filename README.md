# memecoiner

Zero-cost Solana memecoin observer and two-strategy paper-trading lab.

## What it does now

- PumpPortal free discovery for new-token and migration events
- free Solana bonding-curve account updates before migration
- free canonical PumpSwap pool/vault discovery after migration
- inferred BUY/SELL flow and SOL size without a paid trade feed
- rolling 10s / 30s / 60s metrics
- Hybrid Runner + Migration paper bot
- Pure Migration Dip paper bot
- separate 10 SOL virtual ledgers
- configurable paper position sizing and fee assumptions
- local dashboard at `http://127.0.0.1:3210`
- raw event log: `data/events.jsonl`
- paper ENTRY/EXIT reasoning log: `data/paper-trades.jsonl`

There are **no real wallets, signatures, orders, or real-money execution paths**.

## Windows: easiest start

After pulling the latest code, double-click:

`START_MEMECOINER.bat`

It checks dependencies, starts the live engine, and opens the dashboard automatically.

## Manual start

```bash
npm install
npm run app
```

## Current V1 paper rules

### Hybrid

A token is scored pre-migration from age, volume, tape activity, buy/sell flow and short-term momentum. At migration, the score is frozen for the setup.

Default paper entry requires:

- pre-migration score >= 75
- at least 8% post-migration dip
- at least 4% recovery from the local low
- constructive 10-second buy/sell flow
- entry within 120 seconds of migration

Default exits include a 10% stop, order-flow reversal while profitable, trailing giveback after a strong move, 2x hard target, or 180-second timeout.

### Pure Migration Dip

No pre-migration quality score is required.

Default paper entry requires:

- at least 8% post-migration dip
- at least 3% recovery from the local low
- buyers returning on the 10-second flow
- entry within 120 seconds of migration

Default exits are a 15% stop, 2x target, or 120-second timeout.

All thresholds are editable in `.env`.

## Notes

The experiment deliberately uses free public Solana infrastructure. Public RPC endpoints can rate-limit or temporarily fail; the app fails safe by skipping data/trades rather than fabricating prices.
