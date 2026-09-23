import test from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { decodePumpSwapPool, decodeSplTokenAmount } from "./pumpSwapPool.js";

function key(seed: number): Buffer {
  return Buffer.alloc(32, seed);
}

test("decodes stable PumpSwap pool offsets", () => {
  const data = Buffer.alloc(203);
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
