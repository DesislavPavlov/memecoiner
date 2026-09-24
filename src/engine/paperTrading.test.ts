import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveMetricsEngine } from "./liveMetrics.js";
import { PaperTradingEngine } from "./paperTrading.js";
import { PaperJournal } from "../logging/paperJournal.js";
import type { NormalizedMarketEvent } from "../types/market.js";
import { config } from "../config.js";
const mint = "test-mint";
async function lab(t: TestContext, hybridScore = 0, realLiquidity?: number) {
    const dir = await mkdtemp(join(tmpdir(), "memecoiner-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let now = 1800000000000;
    const clock = () => now, journal = new PaperJournal(join(dir, "trades.jsonl"));
    const health: {
        type: string;
        detail?: Record<string, unknown>;
    }[] = [];
    const options = { statePath: join(dir, "state.json"), clock, health: (type: string, detail?: Record<string, unknown>) => { health.push({ type, detail }); } };
    const paper = new PaperTradingEngine(10, journal, options), metrics = new LiveMetricsEngine(10, clock);
    async function send(kind: "migration" | "trade" | "snapshot", price = 1, side = "buy", liquidity = 100, advance = 1000) {
        now += advance;
        const e: NormalizedMarketEvent = { kind, mint, pool: "pump-amm", receivedAt: new Date(now).toISOString(),
            txType: kind === "trade" ? "inferred_swap_" + side : undefined,
            virtualSolReserves: liquidity * 1e9, virtualTokenReserves: liquidity * 1e9 / price,
            raw: kind === "migration" ? { pool: "pump-amm" } : { source: "solana_pumpswap_vaults", pool: "canonical-pool", slot: Math.floor(now / 400), coherent: true,
                realQuoteReserve: realLiquidity === undefined ? undefined : String(realLiquidity * 1e9), baseReserve: String(liquidity * 1e9 / price), quoteReserve: String(liquidity * 1e9), solDeltaLamports: side === "buy" ? "2000000000" : "200000000" } };
        const before = metrics.rowForMint(mint);
        metrics.ingest(e);
        await paper.ingest(e, kind === "migration" && hybridScore ? { ...metrics.rowForMint(mint)!, hybrid: { status: "PRIME WATCH", score: hybridScore, reasons: [] } } : before, metrics.rowForMint(mint));
    }
    async function setup(liquidity = 100) {
        await send("migration");
        for (const [price, side] of [[1, "buy"], [.98, "buy"], [.9, "sell"], [.91, "buy"], [.94, "buy"]] as const)
            await send("trade", price, side, liquidity);
    }
    async function rows() { try {
        return (await readFile(join(dir, "trades.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    }
    catch {
        return [];
    } }
    return { paper, metrics, journal, options, send, setup, rows, health, advance: (ms: number) => { now += ms; }, clock };
}
test("ordered dip waits for delayed fresh quote and applies reserve-based fills", async (t) => {
    const l = await lab(t);
    await l.setup();
    assert.equal(l.paper.summaries()[1]!.status, "ENTRY PENDING");
    await l.send("trade", .94, "buy");
    assert.equal(l.paper.summaries()[1]!.openPositions, 1);
    const entries = await l.rows();
    assert.equal(entries.length, 1);
    assert.ok(entries[0].tokenBaseUnits < .25 * 1e9 / .94);
    assert.equal(entries[0].executionModel, "constant-product-v3-effective-reserves-estimated-fees");
    await l.send("trade", .7, "sell"); // stop signal, never same-event fill
    assert.equal(l.paper.summaries()[1]!.openPositions, 1);
    await l.send("snapshot", .69);
    assert.equal(l.paper.summaries()[1]!.openPositions, 0);
    const records = await l.rows();
    assert.equal(records.length, 2);
    assert.ok(records[1].pnlSol < 0);
    assert.ok(Math.abs(l.paper.summaries()[1]!.balanceSol - 10 - records[1].pnlSol) < 1e-10);
});
test("a rising tape never invents a migration dip", async (t) => {
    const l = await lab(t);
    await l.send("migration");
    for (const p of [1, 1.03, 1.06, 1.1, 1.15, 1.2, 1.3])
        await l.send("trade", p);
    assert.equal(l.paper.summaries()[1]!.openPositions, 0);
    assert.deepEqual(await l.rows(), []);
});
test("dust pools and catastrophic collapses are rejected", async (t) => {
    const l = await lab(t);
    await l.setup(.05);
    await l.send("trade", .94, "buy", .05);
    assert.deepEqual(await l.rows(), []);
    assert.ok(l.health.some(x => String(x.detail?.reason).includes("liquidity")));
    const other = await lab(t);
    await other.send("migration");
    for (const p of [1, .3, .4, .5, .6, .7])
        await other.send("trade", p);
    assert.deepEqual(await other.rows(), []);
});
test("quiet position requests exit on clock, stays unresolved until a fresh delayed quote", async (t) => {
    const l = await lab(t);
    await l.setup();
    await l.send("trade", .94);
    l.advance(121000);
    await l.paper.tick();
    const status = l.paper.summaries()[1]!;
    assert.equal(status.openPositions, 1);
    assert.match(status.status, /STALE/);
    assert.equal((await l.rows()).length, 1);
    await l.send("snapshot", .93);
    assert.equal(l.paper.summaries()[1]!.openPositions, 0);
    assert.equal((await l.rows())[1].reasons[0], "wall-clock timeout");
});
test("stale pending entries expire without imaginary fills", async (t) => {
    const l = await lab(t);
    await l.setup();
    l.advance(config.paperPendingTtlMs + 1);
    await l.paper.tick();
    assert.equal(l.paper.summaries()[1]!.status, "SCANNING");
    assert.deepEqual(await l.rows(), []);
});
test("checkpoint restores positions and cash; replayed journal intents are idempotent", async (t) => {
    const l = await lab(t);
    await l.setup();
    await l.send("trade", .94);
    await l.paper.flush();
    const old = l.paper.summaries()[1]!;
    const restored = new PaperTradingEngine(100, l.journal, l.options);
    await restored.restore();
    assert.equal(restored.summaries()[1]!.balanceSol, old.balanceSol);
    assert.equal(restored.summaries()[1]!.startingBalanceSol, 10);
    assert.deepEqual(restored.openMints(), [mint]);
    const entry = (await l.rows())[0];
    await l.journal.append(entry);
    assert.equal((await l.rows()).length, 1);
    l.advance(200000);
    await restored.tick();
    assert.match(restored.summaries()[1]!.status, /STALE/);
});
test("duplicate migration cannot reset an existing recovery setup", async (t) => {
    const l = await lab(t);
    await l.setup();
    await l.send("migration");
    await l.send("trade", .94);
    assert.equal(l.paper.summaries()[1]!.openPositions, 1);
    assert.ok(l.health.some(x => x.type === "duplicate_migration"));
});
test("Hybrid and Migration keep separate ledgers and distinct scalp/runner exits", async (t) => {
    const l = await lab(t, 85);
    await l.setup();
    await l.send("trade", .94);
    assert.deepEqual(l.paper.summaries().map(b => b.openPositions), [1, 1]);
    await l.send("trade", 1.26);
    await l.send("snapshot", 1.25);
    assert.equal(l.paper.summaries()[1]!.closedTrades, 1);
    assert.equal(l.paper.summaries()[0]!.openPositions, 1);
    await l.send("trade", 1.08);
    await l.send("snapshot", 1.07);
    assert.equal(l.paper.summaries()[0]!.closedTrades, 1);
    const rows = await l.rows();
    assert.equal(rows.length, 4);
    assert.notEqual(rows[0].positionId, rows[1].positionId);
    for (const b of l.paper.summaries())
        assert.ok(Math.abs(b.balanceSol - 10 - rows.find(r => r.bot === b.id && r.action === "EXIT").pnlSol) < 1e-10);
});

test("empty liquidity invalidates an old quote instead of filling a pending order",async t=>{
 const l=await lab(t);await l.setup();await l.send("snapshot",.94,"buy",0);
 l.advance(600);await l.paper.tick();assert.equal(l.paper.summaries()[1]!.openPositions,0);
 assert.equal((await l.rows()).length,0);
});


test("virtual liquidity cannot satisfy the real liquidity entry minimum", async (t) => {
    const l = await lab(t, 0, .05);
    await l.setup(100);
    await l.send("trade", .94);
    assert.deepEqual(await l.rows(), []);
    assert.ok(l.health.some(x => String(x.detail?.reason).includes("liquidity")));
});
