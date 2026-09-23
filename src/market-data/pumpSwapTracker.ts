import { config } from "../config.js";
import { logger } from "../logging/logger.js";
import type { NormalizedMarketEvent } from "../types/market.js";
import { decodeSplTokenAmount, type PumpSwapPool } from "./pumpSwapPool.js";
import { SolanaAccountClient } from "./solanaAccountClient.js";
import { SolanaRpcClient } from "./solanaRpcClient.js";

type EventHandler = (event: NormalizedMarketEvent) => Promise<void> | void;

interface Watch {
  mint: string;
  pool: PumpSwapPool;
  base: bigint;
  quote: bigint;
  previousBase: bigint;
  previousQuote: bigint;
  dirtyBase: boolean;
  dirtyQuote: boolean;
  timer: NodeJS.Timeout;
  settleTimer?: NodeJS.Timeout;
}

export class PumpSwapTracker {
  private readonly watches = new Map<string, Watch>();
  private readonly pending = new Set<string>();

  constructor(
    private readonly solanaWs: SolanaAccountClient,
    private readonly rpc: SolanaRpcClient,
    private readonly onEvent: EventHandler,
  ) {}

  async watchMint(mint: string): Promise<boolean> {
    if (this.watches.has(mint) || this.pending.has(mint)) return true;
    if (this.watches.size >= config.maxPumpSwapSubscriptions) return false;

    this.pending.add(mint);
    try {
      const pool = await this.discoverWithRetry(mint);
      if (!pool) {
        logger.warn({ mint }, "canonical PumpSwap pool not found");
        return false;
      }

      const [base, quote] = await this.rpc.getTokenAccountAmounts([
        pool.baseVault,
        pool.quoteVault,
      ]);

      const timer = setTimeout(
        () => this.unwatch(mint),
        config.pumpSwapWatchTtlMs,
      );
      timer.unref();

      const watch: Watch = {
        mint,
        pool,
        base,
        quote,
        previousBase: base,
        previousQuote: quote,
        dirtyBase: false,
        dirtyQuote: false,
        timer,
      };
      this.watches.set(mint, watch);

      this.solanaWs.subscribe(pool.baseVault, (update) => {
        const current = this.watches.get(mint);
        if (!current) return;
        current.base = decodeSplTokenAmount(update.dataBase64);
        current.dirtyBase = true;
        this.scheduleEvaluate(current);
      });

      this.solanaWs.subscribe(pool.quoteVault, (update) => {
        const current = this.watches.get(mint);
        if (!current) return;
        current.quote = decodeSplTokenAmount(update.dataBase64);
        current.dirtyQuote = true;
        this.scheduleEvaluate(current);
      });

      logger.info(
        { mint, pool: pool.address },
        "free post-migration PumpSwap watch active",
      );
      return true;
    } catch (error) {
      logger.warn({ mint, error }, "failed to start PumpSwap watch");
      return false;
    } finally {
      this.pending.delete(mint);
    }
  }

  unwatch(mint: string): void {
    const watch = this.watches.get(mint);
    if (!watch) return;

    clearTimeout(watch.timer);
    if (watch.settleTimer) clearTimeout(watch.settleTimer);
    this.solanaWs.unsubscribe(watch.pool.baseVault);
    this.solanaWs.unsubscribe(watch.pool.quoteVault);
    this.watches.delete(mint);
  }

  count(): number {
    return this.watches.size;
  }

  private scheduleEvaluate(watch: Watch): void {
    if (watch.settleTimer) clearTimeout(watch.settleTimer);
    watch.settleTimer = setTimeout(() => {
      void this.evaluate(watch);
    }, 80);
    watch.settleTimer.unref();
  }

  private async evaluate(watch: Watch): Promise<void> {
    if (!watch.dirtyBase || !watch.dirtyQuote) return;

    const baseDelta = watch.base - watch.previousBase;
    const quoteDelta = watch.quote - watch.previousQuote;

    watch.previousBase = watch.base;
    watch.previousQuote = watch.quote;
    watch.dirtyBase = false;
    watch.dirtyQuote = false;

    let side: "buy" | "sell" | null = null;
    if (baseDelta < 0n && quoteDelta > 0n) side = "buy";
    if (baseDelta > 0n && quoteDelta < 0n) side = "sell";
    if (!side) return;

    const quoteAbs = quoteDelta < 0n ? -quoteDelta : quoteDelta;
    const baseAbs = baseDelta < 0n ? -baseDelta : baseDelta;

    await this.onEvent({
      kind: "trade",
      receivedAt: new Date().toISOString(),
      mint: watch.mint,
      txType: `inferred_swap_${side}`,
      virtualSolReserves: Number(watch.quote),
      virtualTokenReserves: Number(watch.base),
      raw: {
        source: "solana_pumpswap_vaults",
        pool: watch.pool.address,
        side,
        solDeltaLamports: quoteAbs.toString(),
        tokenDeltaBaseUnits: baseAbs.toString(),
        quoteReserve: watch.quote.toString(),
        baseReserve: watch.base.toString(),
      },
    });
  }

  private async discoverWithRetry(mint: string): Promise<PumpSwapPool | null> {
    const delays = [0, 250, 500, 1_000, 2_000, 4_000];

    for (const delay of delays) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        const pool = await this.rpc.findCanonicalPumpSwapPool(mint);
        if (pool) return pool;
      } catch (error) {
        logger.debug({ mint, error }, "PumpSwap discovery retry failed");
      }
    }

    return null;
  }
}
