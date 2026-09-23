import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMarketEvent } from "./normalize.js";

test("normalizes token creation payload", () => {
  const event = normalizeMarketEvent({
    txType: "create",
    mint: "Mint111",
    name: "Example",
    symbol: "EX",
    marketCapSol: 31.25,
    vSolInBondingCurve: 12,
    vTokensInBondingCurve: 999,
  });

  assert.equal(event.kind, "new_token");
  assert.equal(event.mint, "Mint111");
  assert.equal(event.symbol, "EX");
  assert.equal(event.marketCapSol, 31.25);
  assert.equal(event.virtualSolReserves, 12);
});

test("normalizes migration payload", () => {
  const event = normalizeMarketEvent({
    txType: "migration",
    tokenAddress: "Mint222",
  });

  assert.equal(event.kind, "migration");
  assert.equal(event.mint, "Mint222");
});

test("keeps unknown payload intact instead of guessing", () => {
  const raw = { hello: "world", number: 42 };
  const event = normalizeMarketEvent(raw);

  assert.equal(event.kind, "unknown");
  assert.deepEqual(event.raw, raw);
});
