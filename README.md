# memecoiner

Zero-cost Solana memecoin observer and paper-strategy comparison lab.

## Current milestone

The app now combines:

- PumpPortal's free new-token and migration discovery events
- free Solana `accountSubscribe` updates for Pump bonding curves
- inferred buy/sell flow from reserve changes
- rolling 10s / 30s / 60s metrics
- Hybrid V1 candidate scoring
- Pure Migration-Dip strategy state
- two isolated virtual 10 SOL paper accounts
- a local dashboard at `http://127.0.0.1:3210`
- raw JSONL event logging

There are **no real wallets, signatures, orders, or real-money execution paths**.

## Windows: easiest start

Double-click:

`START_MEMECOINER.bat`

On first run it installs dependencies if needed and opens the dashboard automatically.

## Manual start

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Add the PumpPortal API key you already generated.
4. Run:

```bash
npm install
npm run app
```

Dashboard:

`http://127.0.0.1:3210`

Raw events:

`data/events.jsonl`

## Important current limitation

Pre-migration Pump trades are derived from free Solana bonding-curve account updates.

After a token migrates, the bonding curve stops being the live market. The two paper strategies therefore currently show **WAIT POST-MIGRATION FEED** instead of inventing fills. The next engineering milestone is a free PumpSwap post-migration data path.

## Principles

- zero paid market-data feeds for the experiment
- paper trading only
- raw source data retained before interpretation
- deterministic strategy reasoning
- no private keys anywhere in the project
