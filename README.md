# memecoiner

Experimental Solana memecoin market observer and paper-trading lab.

## Stage 1 — read-only observer

The first milestone is intentionally non-custodial and non-trading:

- connect to one PumpPortal WebSocket
- subscribe to new-token events
- subscribe to migration events
- preserve raw events as JSONL
- normalize the stable fields we can identify
- maintain an in-memory token state
- print human-readable observer events

No private keys, wallet signing, buying, or selling are implemented in Stage 1.

## Setup

1. Install Node.js 20+.
2. Copy `.env.example` to `.env`.
3. Add a PumpPortal API key.
4. Run:

```bash
npm install
npm run observer
```

Raw events are written to `data/events.jsonl` by default.

## Principles

- One WebSocket connection; subscriptions share it.
- Raw source data is retained before interpretation.
- Unknown/malformed payloads are logged rather than guessed.
- Trading logic will be added only after live-data validation.
- Secrets belong in `.env` and are never committed.
