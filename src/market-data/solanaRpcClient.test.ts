import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { SolanaRpcClient } from "./solanaRpcClient.js";
import { canonicalPoolAddress, WRAPPED_SOL_MINT, PUMP_AMM_PROGRAM_ID } from "./pumpSwapPool.js";
const mint = "7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump";
function data() {
    const d = Buffer.alloc(261), p = canonicalPoolAddress(mint);
    createHash("sha256").update("account:Pool").digest().copy(d, 0, 0, 8);
    Buffer.from(bs58.decode(p.creator)).copy(d, 11);
    Buffer.from(bs58.decode(mint)).copy(d, 43);
    Buffer.from(bs58.decode(WRAPPED_SOL_MINT)).copy(d, 75);
    Buffer.alloc(32, 1).copy(d, 139);
    Buffer.alloc(32, 2).copy(d, 171);
    return d;
}
test("RPC pool lookup uses the canonical address and rejects wrong owner and unsupported mode", async (t) => {
    let owner = PUMP_AMM_PROGRAM_ID, d = data();
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        const req = JSON.parse(String(init.body));
        assert.equal(req.params[0], canonicalPoolAddress(mint).address);
        assert.equal(req.method, "getAccountInfo");
        return new Response(JSON.stringify({ result: { value: { owner, data: [d.toString("base64"), "base64"] } } }));
    });
    const rpc = new SolanaRpcClient();
    assert.equal((await rpc.findCanonicalPumpSwapPool(mint))!.baseMint, mint);
    owner = "other";
    await assert.rejects(rpc.findCanonicalPumpSwapPool(mint), /owner/);
    owner = PUMP_AMM_PROGRAM_ID;
    d[243] = 1;
    await assert.rejects(rpc.findCanonicalPumpSwapPool(mint), /Unsupported/);
});
test("RPC errors are explicit and reported instead of interpreted as absent pools", async (t) => {
    const errors: string[] = [];
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: { code: -32005, message: "rate limited" } })));
    await assert.rejects(new SolanaRpcClient(type => errors.push(type)).findCanonicalPumpSwapPool(mint), /RPC/);
    assert.deepEqual(errors, ["rpc_failure"]);
});
