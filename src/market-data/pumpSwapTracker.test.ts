import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { PumpSwapTracker } from "./pumpSwapTracker.js";
import type { SolanaAccountClient, SolanaAccountUpdate } from "./solanaAccountClient.js";
import type { SolanaRpcClient } from "./solanaRpcClient.js";
import type { NormalizedMarketEvent } from "../types/market.js";
const key = (n: number) => bs58.encode(Buffer.alloc(32, n));
const pool = { address: key(1), index: 0, creator: key(2), baseMint: key(3), quoteMint: key(4), baseVault: key(5), quoteVault: key(6), unsupportedMode: false };
function update(side: "base" | "quote", amount: bigint, slot: number, generation = 1): SolanaAccountUpdate {
    const d = Buffer.alloc(165);
    Buffer.from(bs58.decode(side === "base" ? pool.baseMint : pool.quoteMint)).copy(d);
    Buffer.from(bs58.decode(pool.address)).copy(d, 32);
    d.writeBigUInt64LE(amount, 64);
    d[108] = 1;
    return { pubkey: side === "base" ? pool.baseVault : pool.quoteVault, slot, generation, dataBase64: d.toString("base64") };
}
async function fixture(virtualQuoteReserves = 0n) {
    const handlers = new Map<string, (u: SolanaAccountUpdate) => void>();
    const events: NormalizedMarketEvent[] = [];
    let baseline = { base: 1000n, quote: 1000n, slot: 10 };
    const ws = { subscribe: (k: string, h: (u: SolanaAccountUpdate) => void) => handlers.set(k, h), unsubscribe: (k: string) => handlers.delete(k) };
    const rpc = { findCanonicalPumpSwapPool: async () => ({ ...pool, virtualQuoteReserves }), getPoolSnapshot: async () => baseline };
    const tracker = new PumpSwapTracker(ws as unknown as SolanaAccountClient, rpc as unknown as SolanaRpcClient, e => { events.push(e); });
    await tracker.watchMint(pool.baseMint);
    const send = (side: "base" | "quote", amount: bigint, slot: number, generation = 1) => handlers.get(side === "base" ? pool.baseVault : pool.quoteVault)!(update(side, amount, slot, generation));
    return { tracker, events, send, handlers, setBaseline: (s: typeof baseline) => { baseline = s; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 110));
test("paired vault updates emit inferred flow only after a baseline; duplicates and older slots do not replay", async () => {
    const f = await fixture();
    try {
        f.send("base", 1000n, 11);
        f.send("quote", 1000n, 11);
        await settle();
        f.send("base", 900n, 12);
        f.send("quote", 1112n, 12);
        await settle();
        assert.equal(f.events.filter(e => e.kind === "trade").length, 1);
        assert.equal(f.events.at(-1)!.raw.slot, 12);
        assert.equal(f.events.at(-1)!.raw.coherent, true);
        f.send("base", 900n, 12);
        f.send("quote", 1112n, 12);
        await settle();
        f.send("base", 1000n, 11);
        f.send("quote", 1000n, 11);
        await settle();
        assert.equal(f.events.filter(e => e.kind === "trade").length, 1);
    }
    finally {
        f.tracker.stop();
    }
});
test("mismatched slots refresh a common snapshot, never manufacture cross-vault flow", async () => {
    const f = await fixture();
    try {
        f.setBaseline({ base: 900n, quote: 1112n, slot: 13 });
        f.send("base", 900n, 12);
        f.send("quote", 1112n, 13);
        await settle();
        assert.equal(f.events.filter(e => e.kind === "trade").length, 0);
        assert.equal(f.events.at(-1)!.raw.slot, 13);
    }
    finally {
        f.tracker.stop();
    }
});
test("reconnect generation establishes a new baseline instead of counting disconnected changes as a trade", async () => {
    const f = await fixture();
    try {
        f.send("base", 1000n, 11);
        f.send("quote", 1000n, 11);
        await settle();
        f.send("base", 500n, 20, 2);
        f.send("quote", 2000n, 20, 2);
        await settle();
        assert.equal(f.events.filter(e => e.kind === "trade").length, 0);
    }
    finally {
        f.tracker.stop();
    }
});


test("virtual quote liquidity changes price but never counted as real flow", async () => {
    const f = await fixture(5000n);
    try {
        assert.equal(f.events[0]!.raw.quoteReserve, "6000");
        assert.equal(f.events[0]!.raw.realQuoteReserve, "1000");
        f.send("base", 1000n, 11); f.send("quote", 1000n, 11); await settle();
        f.send("base", 900n, 12); f.send("quote", 1112n, 12); await settle();
        const e = f.events.at(-1)!;
        assert.equal(e.kind, "trade");
        assert.equal(e.virtualSolReserves, 6112);
        assert.equal(e.raw.solDeltaLamports, "112");
        assert.equal(e.raw.quoteReserve, "6112");
        assert.equal(e.raw.realQuoteReserve, "1112");
    } finally { f.tracker.stop(); }
});


test("changed virtual reserves invalidate old quotes and rebaseline without fabricated flow", async () => {
    const { createHash } = await import("node:crypto");
    const f = await fixture(5000n);
    try {
        f.send("base", 1000n, 11); f.send("quote", 1000n, 11); await settle();
        const d = Buffer.alloc(261);
        createHash("sha256").update("account:Pool").digest().copy(d, 0, 0, 8);
        for (const [k, offset] of [[pool.creator, 11], [pool.baseMint, 43], [pool.quoteMint, 75], [pool.baseVault, 139], [pool.quoteVault, 171]] as const)
            Buffer.from(bs58.decode(k)).copy(d, offset);
        d.writeBigUInt64LE(7000n, 245);
        f.setBaseline({ base: 1000n, quote: 1000n, slot: 12 });
        await f.handlers.get(pool.address)!({ pubkey: pool.address, slot: 12, generation: 1, dataBase64: d.toString("base64") });
        assert.ok(f.events.some(e => e.raw.baseReserve === "0"));
        assert.equal(f.events.at(-1)!.raw.quoteReserve, "8000");
        assert.equal(f.events.filter(e => e.kind === "trade").length, 0);
    } finally { f.tracker.stop(); }
});
