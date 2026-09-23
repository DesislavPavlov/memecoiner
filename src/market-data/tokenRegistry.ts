import type {
  NormalizedMarketEvent,
  TokenState,
} from "../types/market.js";

export class TokenRegistry {
  private readonly tokens = new Map<string, TokenState>();

  apply(event: NormalizedMarketEvent): TokenState | undefined {
    if (!event.mint) return undefined;

    const existing = this.tokens.get(event.mint);
    const next: TokenState = {
      mint: event.mint,
      firstSeenAt: existing?.firstSeenAt ?? event.receivedAt,
      lastSeenAt: event.receivedAt,
      migratedAt:
        event.kind === "migration"
          ? event.receivedAt
          : existing?.migratedAt,
      name: event.name ?? existing?.name,
      symbol: event.symbol ?? existing?.symbol,
      marketCapSol: event.marketCapSol ?? existing?.marketCapSol,
      virtualSolReserves:
        event.virtualSolReserves ?? existing?.virtualSolReserves,
      virtualTokenReserves:
        event.virtualTokenReserves ?? existing?.virtualTokenReserves,
      bondingCurveKey:
        event.bondingCurveKey ?? existing?.bondingCurveKey,
      rawEventCount: (existing?.rawEventCount ?? 0) + 1,
    };

    this.tokens.set(event.mint, next);
    return next;
  }

  get(mint: string): TokenState | undefined {
    return this.tokens.get(mint);
  }

  size(): number {
    return this.tokens.size;
  }
}
