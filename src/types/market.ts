export type UnknownRecord = Record<string, unknown>;

export type EventKind =
  | "new_token"
  | "migration"
  | "trade"
  | "unknown"
  | "system";

export interface NormalizedMarketEvent {
  kind: EventKind;
  receivedAt: string;
  mint?: string;
  signature?: string;
  name?: string;
  symbol?: string;
  traderPublicKey?: string;
  txType?: string;
  marketCapSol?: number;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  bondingCurveKey?: string;
  raw: UnknownRecord;
}

export interface TokenState {
  mint: string;
  firstSeenAt: string;
  lastSeenAt: string;
  migratedAt?: string;
  name?: string;
  symbol?: string;
  marketCapSol?: number;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  bondingCurveKey?: string;
  rawEventCount: number;
}
