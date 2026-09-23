export interface PumpBondingCurveSnapshot {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}

export interface InferredCurveTrade {
  side: "buy" | "sell" | "unknown";
  solDeltaLamports: bigint;
  tokenDeltaBaseUnits: bigint;
}

const MIN_ACCOUNT_BYTES = 49;

export function decodePumpBondingCurve(
  dataBase64: string,
): PumpBondingCurveSnapshot {
  const data = Buffer.from(dataBase64, "base64");
  if (data.length < MIN_ACCOUNT_BYTES) {
    throw new Error(
      `BondingCurve account too short: expected >= ${MIN_ACCOUNT_BYTES}, got ${data.length}`,
    );
  }

  // Anchor discriminator occupies bytes 0..7.
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data.readUInt8(48) !== 0,
  };
}

export function inferCurveTrade(
  previous: PumpBondingCurveSnapshot,
  current: PumpBondingCurveSnapshot,
): InferredCurveTrade {
  const solDelta = current.virtualSolReserves - previous.virtualSolReserves;
  const tokenDelta =
    current.virtualTokenReserves - previous.virtualTokenReserves;

  if (solDelta > 0n && tokenDelta < 0n) {
    return {
      side: "buy",
      solDeltaLamports: solDelta,
      tokenDeltaBaseUnits: -tokenDelta,
    };
  }

  if (solDelta < 0n && tokenDelta > 0n) {
    return {
      side: "sell",
      solDeltaLamports: -solDelta,
      tokenDeltaBaseUnits: tokenDelta,
    };
  }

  return {
    side: "unknown",
    solDeltaLamports: solDelta < 0n ? -solDelta : solDelta,
    tokenDeltaBaseUnits: tokenDelta < 0n ? -tokenDelta : tokenDelta,
  };
}
