import type {
  EventKind,
  NormalizedMarketEvent,
  UnknownRecord,
} from "../types/market.js";

function asRecord(value: unknown): UnknownRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UnknownRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function inferKind(raw: UnknownRecord): EventKind {
  const txType = asString(raw.txType)?.toLowerCase();
  if (txType === "create") return "new_token";
  if (txType === "migrate" || txType === "migration") return "migration";
  if (txType === "buy" || txType === "sell") return "trade";

  const message = asString(raw.message)?.toLowerCase();
  if (message?.includes("migration")) return "migration";
  if (message?.includes("new token") || message?.includes("create")) {
    return "new_token";
  }

  return "unknown";
}

export function normalizeMarketEvent(input: unknown): NormalizedMarketEvent {
  const raw = asRecord(input) ?? { value: input };

  return {
    kind: inferKind(raw),
    receivedAt: new Date().toISOString(),
    mint:
      asString(raw.mint) ??
      asString(raw.token) ??
      asString(raw.tokenAddress) ??
      asString(raw.address),
    signature: asString(raw.signature),
    name: asString(raw.name),
    symbol: asString(raw.symbol),
    traderPublicKey:
      asString(raw.traderPublicKey) ??
      asString(raw.trader) ??
      asString(raw.user),
    txType: asString(raw.txType),
    chain:
      asString(raw.chain) ??
      asString(raw.blockchain) ??
      asString(raw.network),
    pool:
      asString(raw.pool) ??
      asString(raw.poolType) ??
      asString(raw.exchange),
    platform:
      asString(raw.platform) ??
      asString(raw.launchpad) ??
      asString(raw.createdOn),
    source:
      asString(raw.source) ??
      asString(raw.program),
    marketCapSol:
      asNumber(raw.marketCapSol) ??
      asNumber(raw.marketCap) ??
      asNumber(raw.solMarketCap),
    virtualSolReserves:
      asNumber(raw.vSolInBondingCurve) ??
      asNumber(raw.virtualSolReserves),
    virtualTokenReserves:
      asNumber(raw.vTokensInBondingCurve) ??
      asNumber(raw.virtualTokenReserves),
    bondingCurveKey:
      asString(raw.bondingCurveKey) ??
      asString(raw.bondingCurve),
    raw,
  };
}
