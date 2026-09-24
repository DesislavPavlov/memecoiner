import test from "node:test";
import assert from "node:assert/strict";
import { LiveMetricsEngine } from "./liveMetrics.js";
import type { NormalizedMarketEvent } from "../types/market.js";
function event(partial: Partial<NormalizedMarketEvent> & Pick<NormalizedMarketEvent, "kind" | "mint">): NormalizedMarketEvent {
    return {
        receivedAt: new Date().toISOString(),
        raw: {},
        ...partial,
    };
}
test("builds buy/sell rolling metrics", () => {
    const engine = new LiveMetricsEngine(10);
    engine.ingest(event({
        kind: "new_token",
        mint: "Mint11111111111111111111111111111111111111",
        symbol: "TEST",
    }));
    engine.ingest(event({
        kind: "trade",
        mint: "Mint11111111111111111111111111111111111111",
        txType: "inferred_buy",
        virtualSolReserves: 200,
        virtualTokenReserves: 100,
        raw: { solDeltaLamports: "500000000" },
    }));
    engine.ingest(event({
        kind: "trade",
        mint: "Mint11111111111111111111111111111111111111",
        txType: "inferred_sell",
        virtualSolReserves: 190,
        virtualTokenReserves: 110,
        raw: { solDeltaLamports: "100000000" },
    }));
    const row = engine.snapshot().rows[0]!;
    assert.equal(row.w60.buys, 1);
    assert.equal(row.w60.sells, 1);
    assert.equal(row.w60.buySol, 0.5);
    assert.equal(row.w60.sellSol, 0.1);
    assert.equal(row.w60.buySellVolumeRatio, 5);
});
test("zero sell volume stays JSON serializable", () => {
    const engine = new LiveMetricsEngine(10);
    engine.ingest(event({
        kind: "trade",
        mint: "Mint22222222222222222222222222222222222222",
        txType: "inferred_buy",
        raw: { solDeltaLamports: "100000000" },
    }));
    const snapshot = engine.snapshot();
    assert.equal(snapshot.rows[0]!.w60.buySellVolumeRatio, 99);
    assert.doesNotThrow(() => JSON.stringify(snapshot));
});
test("migration strategy refuses to invent a post-migration fill", () => {
    const engine = new LiveMetricsEngine(10);
    const mint = "Mint33333333333333333333333333333333333333";
    engine.ingest(event({ kind: "new_token", mint }));
    engine.ingest(event({ kind: "migration", mint }));
    const row = engine.snapshot().rows[0]!;
    assert.equal(row.migrated, true);
    assert.equal(row.migration.status, "WAIT PUMPSWAP DATA");
    assert.equal(engine.snapshot().bots[1]!.balanceSol, 10);
});
test("post-migration windows exclude curve flow and ignore future/dust samples", () => {
    const now = Date.now() + 100, e = new LiveMetricsEngine(10, () => now);
    e.ingest(event({ kind: "trade", mint: "x", txType: "inferred_buy", raw: { solDeltaLamports: "9000000000" } }));
    e.ingest(event({ kind: "migration", mint: "x" }));
    e.ingest(event({ kind: "trade", mint: "x", txType: "inferred_swap_buy", raw: { solDeltaLamports: "100000000" } }));
    e.ingest(event({ kind: "trade", mint: "x", txType: "inferred_swap_buy", raw: { solDeltaLamports: "100" } }));
    e.ingest(event({ kind: "trade", mint: "x", receivedAt: new Date(now + 10000).toISOString(), txType: "inferred_swap_sell", raw: { solDeltaLamports: "100000000" } }));
    const row = e.rowForMint("x")!;
    assert.equal(row.w10.buySol, .1);
    assert.equal(row.w10.buys, 1);
    assert.equal(row.w10.sells, 0);
});
