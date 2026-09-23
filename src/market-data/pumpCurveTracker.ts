import { config } from "../config.js";
import { logger } from "../logging/logger.js";
import type { NormalizedMarketEvent } from "../types/market.js";
import {
  decodePumpBondingCurve,
  inferCurveTrade,
  type PumpBondingCurveSnapshot,
} from "./pumpBondingCurve.js";
import { SolanaAccountClient } from "./solanaAccountClient.js";

type EventHandler = (event: NormalizedMarketEvent) => Promise<void> | void;

interface WatchedCurve {
  mint: string;
  expiresAt: number;
  previous?: PumpBondingCurveSnapshot;
  timer: NodeJS.Timeout;
}

export class PumpCurveTracker {
  private readonly curves = new Map<string, WatchedCurve>();

  constructor(
    private readonly solana: SolanaAccountClient,
    private readonly onEvent: EventHandler,
  ) {}

  watch(mint: string, bondingCurveKey: string): boolean {
    if (this.curves.has(bondingCurveKey)) return true;
    if (this.curves.size >= config.maxCurveSubscriptions) return false;

    const timer = setTimeout(
      () => this.unwatch(bondingCurveKey),
      config.curveWatchTtlMs,
    );
    timer.unref();

    this.curves.set(bondingCurveKey, {
      mint,
      expiresAt: Date.now() + config.curveWatchTtlMs,
      timer,
    });

    this.solana.subscribe(bondingCurveKey, async (update) => {
      const watched = this.curves.get(bondingCurveKey);
      if (!watched) return;

      const current = decodePumpBondingCurve(update.dataBase64);
      const previous = watched.previous;
      watched.previous = current;

      if (!previous) {
        logger.debug(
          { mint, bondingCurveKey, slot: update.slot },
          "bonding curve baseline captured",
        );
        return;
      }

      const trade = inferCurveTrade(previous, current);
      if (trade.side === "unknown") return;

      await this.onEvent({
        kind: "trade",
        receivedAt: new Date().toISOString(),
        mint,
        txType: `inferred_${trade.side}`,
        virtualSolReserves: Number(current.virtualSolReserves),
        virtualTokenReserves: Number(current.virtualTokenReserves),
        bondingCurveKey,
        raw: {
          source: "solana_account_subscribe",
          slot: update.slot,
          side: trade.side,
          solDeltaLamports: trade.solDeltaLamports.toString(),
          tokenDeltaBaseUnits: trade.tokenDeltaBaseUnits.toString(),
          virtualSolReserves: current.virtualSolReserves.toString(),
          virtualTokenReserves: current.virtualTokenReserves.toString(),
          realSolReserves: current.realSolReserves.toString(),
          realTokenReserves: current.realTokenReserves.toString(),
          tokenTotalSupply: current.tokenTotalSupply.toString(),
          complete: current.complete,
        },
      });
    });

    return true;
  }

  unwatch(bondingCurveKey: string): void {
    const watched = this.curves.get(bondingCurveKey);
    if (!watched) return;
    clearTimeout(watched.timer);
    this.curves.delete(bondingCurveKey);
    this.solana.unsubscribe(bondingCurveKey);
  }

  count(): number {
    return this.curves.size;
  }
}
