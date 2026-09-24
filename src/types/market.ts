export type UnknownRecord = Record<string, unknown>;
export type EventKind = "new_token" | "migration" | "trade" | "unknown" | "system" | "snapshot";
export interface NormalizedMarketEvent {
    kind: EventKind;
    eventId?: string;
    runId?: string;
    sequence?: number;
    receivedAt: string;
    mint?: string;
    signature?: string;
    name?: string;
    symbol?: string;
    traderPublicKey?: string;
    txType?: string;
    chain?: string;
    pool?: string;
    platform?: string;
    source?: string;
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
    chain?: string;
    pool?: string;
    platform?: string;
    source?: string;
    marketCapSol?: number;
    virtualSolReserves?: number;
    virtualTokenReserves?: number;
    bondingCurveKey?: string;
    rawEventCount: number;
}
