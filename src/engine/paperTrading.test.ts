import test from "node:test";
import assert from "node:assert/strict";
import { LiveMetricsEngine } from "./liveMetrics.js";
import { PaperTradingEngine } from "./paperTrading.js";
import { PaperJournal } from "../logging/paperJournal.js";
import type { NormalizedMarketEvent } from "../types/market.js";

function makeEvent(
  ts: number,
  partial: Partial<NormalizedMarketEvent> & Pick<NormalizedMarketEvent, "kind" | "mint">,
): NormalizedMarketEvent {
  return {
    receivedAt: new Date(ts).toISOString(),
    raw: {},
    ...partial,
  };
}

test("pure migration bot enters a confirmed dip recovery then stops out", async () => {
  const now = Date.now();
  const mint = "MintPaper11111111111111111111111111111111111";
  const metrics = new LiveMetricsEngine(10);
  const paper = new PaperTradingEngine(
    10,
    new PaperJournal("/tmp/memecoiner-paper-test.jsonl"),
  );

  const created = makeEvent(now, {
    kind: "new_token",
    mint,
    symbol: "PAPER",
  });
  metrics.ingest(created);

  const migration = makeEvent(now + 1_000, { kind: "migration", mint });
  const beforeMigration = metrics.rowForMint(mint);
  metrics.ingest(migration);
  await paper.ingest(migration, beforeMigration, metrics.rowForMint(mint));

  const post = [
    makeEvent(now + 2_000, {
      kind: "trade",
      mint,
      txType: "inferred_swap_buy",
      virtualSolReserves: 100,
      virtualTokenReserves: 100,
      raw: { solDeltaLamports: "1000000000" },
    }),
    makeEvent(now + 3_000, {
      kind: "trade",
      mint,
      txType: "inferred_swap_sell",
      virtualSolReserves: 90,
      virtualTokenReserves: 100,
      raw: { solDeltaLamports: "200000000" },
    }),
    makeEvent(now + 4_000, {
      kind: "trade",
      mint,
      txType: "inferred_swap_buy",
      virtualSolReserves: 93,
      virtualTokenReserves: 100,
      raw: { solDeltaLamports: "500000000" },
    }),
  ];

  for (const event of post) {
    const before = metrics.rowForMint(mint);
    metrics.ingest(event);
    await paper.ingest(event, before, metrics.rowForMint(mint));
  }

  let migrationBot = paper.summaries().find((bot) => bot.id === "migration")!;
  assert.equal(migrationBot.openPositions, 1);
  assert.equal(migrationBot.closedTrades, 0);

  const stop = makeEvent(now + 5_000, {
    kind: "trade",
    mint,
    txType: "inferred_swap_sell",
    virtualSolReserves: 75,
    virtualTokenReserves: 100,
    raw: { solDeltaLamports: "1000000000" },
  });
  const beforeStop = metrics.rowForMint(mint);
  metrics.ingest(stop);
  await paper.ingest(stop, beforeStop, metrics.rowForMint(mint));

  migrationBot = paper.summaries().find((bot) => bot.id === "migration")!;
  assert.equal(migrationBot.openPositions, 0);
  assert.equal(migrationBot.closedTrades, 1);
  assert.ok(migrationBot.realizedPnlSol < 0);
});
