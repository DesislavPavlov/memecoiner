import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { canonicalPoolAddress, validateVault, decodePumpSwapPool, decodeSplTokenAmount } from "./pumpSwapPool.js";
function key(seed: number): Buffer {
    return Buffer.alloc(32, seed);
}
test("decodes stable PumpSwap pool offsets", () => {
    const data = Buffer.alloc(203);
    createHash("sha256").update("account:Pool").digest().copy(data, 0, 0, 8);
    data.writeUInt16LE(0, 9);
    key(1).copy(data, 43);
    key(2).copy(data, 75);
    key(3).copy(data, 139);
    key(4).copy(data, 171);
    const pool = decodePumpSwapPool("Pool111", data.toString("base64"));
    assert.equal(pool.index, 0);
    assert.equal(pool.baseMint, bs58.encode(key(1)));
    assert.equal(pool.quoteMint, bs58.encode(key(2)));
    assert.equal(pool.baseVault, bs58.encode(key(3)));
    assert.equal(pool.quoteVault, bs58.encode(key(4)));
});
test("decodes SPL token amount at offset 64", () => {
    const data = Buffer.alloc(165);
    data.writeBigUInt64LE(123456789n, 64);
    assert.equal(decodeSplTokenAmount(data.toString("base64")), 123456789n);
});
test("canonical derivation is deterministic and rejects invalid mints", () => {
    const mint = bs58.encode(key(9));
    assert.deepEqual(canonicalPoolAddress(mint), canonicalPoolAddress(mint));
    assert.throws(() => canonicalPoolAddress("invalid"));
});
test("pool discriminator and vault identity are validated", () => {
    assert.throws(() => decodePumpSwapPool("p", Buffer.alloc(203).toString("base64")), /discriminator/);
    const d = Buffer.alloc(165);
    key(1).copy(d);
    key(2).copy(d, 32);
    d[108] = 1;
    assert.equal(validateVault(d.toString("base64"), bs58.encode(key(1)), bs58.encode(key(2))), 0n);
    assert.throws(() => validateVault(d.toString("base64"), bs58.encode(key(3)), bs58.encode(key(2))));
});
test("canonical PDA matches the official PumpSwap documented pool vector", () => {
    assert.deepEqual(canonicalPoolAddress("7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump"), {
        address: "GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J", creator: "9XDYTfQKwW8sHPqnFdUreMmtmffmkHVPGTNV2e3LKxNW"
    });
});
