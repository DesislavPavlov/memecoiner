import test from "node:test";
import assert from "node:assert/strict";
import {
  decodePumpBondingCurve,
  inferCurveTrade,
} from "./pumpBondingCurve.js";

function encodeCurve(values: {
  virtualToken: bigint;
  virtualSol: bigint;
  realToken: bigint;
  realSol: bigint;
  supply: bigint;
  complete?: boolean;
}): string {
  const data = Buffer.alloc(49);
  data.writeBigUInt64LE(values.virtualToken, 8);
  data.writeBigUInt64LE(values.virtualSol, 16);
  data.writeBigUInt64LE(values.realToken, 24);
  data.writeBigUInt64LE(values.realSol, 32);
  data.writeBigUInt64LE(values.supply, 40);
  data.writeUInt8(values.complete ? 1 : 0, 48);
  return data.toString("base64");
}

test("decodes the stable Pump bonding curve prefix", () => {
  const snapshot = decodePumpBondingCurve(
    encodeCurve({
      virtualToken: 1_000n,
      virtualSol: 500n,
      realToken: 800n,
      realSol: 100n,
      supply: 2_000n,
      complete: true,
    }),
  );

  assert.equal(snapshot.virtualTokenReserves, 1_000n);
  assert.equal(snapshot.virtualSolReserves, 500n);
  assert.equal(snapshot.realTokenReserves, 800n);
  assert.equal(snapshot.complete, true);
});

test("infers a buy from reserve movement", () => {
  const previous = decodePumpBondingCurve(
    encodeCurve({
      virtualToken: 1_000n,
      virtualSol: 500n,
      realToken: 800n,
      realSol: 100n,
      supply: 2_000n,
    }),
  );
  const current = decodePumpBondingCurve(
    encodeCurve({
      virtualToken: 900n,
      virtualSol: 550n,
      realToken: 700n,
      realSol: 150n,
      supply: 2_000n,
    }),
  );

  const trade = inferCurveTrade(previous, current);
  assert.equal(trade.side, "buy");
  assert.equal(trade.solDeltaLamports, 50n);
  assert.equal(trade.tokenDeltaBaseUnits, 100n);
});

test("infers a sell from reserve movement", () => {
  const previous = decodePumpBondingCurve(
    encodeCurve({
      virtualToken: 900n,
      virtualSol: 550n,
      realToken: 700n,
      realSol: 150n,
      supply: 2_000n,
    }),
  );
  const current = decodePumpBondingCurve(
    encodeCurve({
      virtualToken: 1_000n,
      virtualSol: 500n,
      realToken: 800n,
      realSol: 100n,
      supply: 2_000n,
    }),
  );

  assert.equal(inferCurveTrade(previous, current).side, "sell");
});
