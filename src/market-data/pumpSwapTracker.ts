import { config } from "../config.js";
import type { HealthSink } from "../logging/health.js";
import type { NormalizedMarketEvent } from "../types/market.js";
import { validateVault, type PumpSwapPool } from "./pumpSwapPool.js";
import { SolanaAccountClient, type SolanaAccountUpdate } from "./solanaAccountClient.js";
import { SolanaRpcClient, type PoolSnapshot } from "./solanaRpcClient.js";
type EventHandler = (event: NormalizedMarketEvent) => Promise<void> | void;
interface Watch {
    mint: string;
    pool: PumpSwapPool;
    previous?: PoolSnapshot;
    generation?: number;
    base?: {
        value: bigint;
        slot: number;
    };
    quote?: {
        value: bigint;
        slot: number;
    };
    expiresAt: number;
    timer: NodeJS.Timeout;
    settle?: NodeJS.Timeout;
    refreshing?: Promise<void>;
    lastRefresh: number;
}
/** Paired confirmed-slot snapshots; bounded 80ms batching, never a resettable debounce. */
export class PumpSwapTracker {
    private readonly watches = new Map<string, Watch>();
    private readonly pending = new Set<string>();
    private stopped = false;
    constructor(private readonly solanaWs: SolanaAccountClient, private readonly rpc: SolanaRpcClient, private readonly onEvent: EventHandler, private readonly health: HealthSink = () => { }, private readonly isPinned: (mint: string) => boolean = () => false) { }
    async watchMint(mint: string): Promise<boolean> {
        if (this.stopped)
            return false;
        if (this.watches.has(mint) || this.pending.has(mint))
            return true;
        if (this.watches.size + this.pending.size >= config.maxPumpSwapSubscriptions && !this.isPinned(mint)) {
            this.health("swap_capacity_rejected", { mint });
            return false;
        }
        this.pending.add(mint);
        this.health("discovery_started", { mint });
        try {
            let pool: PumpSwapPool | null = null;
            for (const delay of [0, 500, 1000, 2000, 4000, 8000]) {
                if (this.stopped)
                    return false;
                if (delay)
                    await new Promise(resolve => setTimeout(resolve, delay));
                try {
                    pool = await this.rpc.findCanonicalPumpSwapPool(mint);
                    if (pool)
                        break;
                }
                catch (error) {
                    this.health("discovery_retry", { mint, error: String(error) });
                }
            }
            if (!pool) {
                this.health("discovery_failed", { mint });
                return false;
            }
            const baseline = await this.rpc.getPoolSnapshot(pool);
            if (this.stopped)
                return false;
            const w: Watch = { mint, pool, previous: baseline, expiresAt: Date.now() + config.pumpSwapWatchTtlMs,
                timer: setInterval(() => { if (Date.now() > w.expiresAt && !this.isPinned(mint))
                    this.unwatch(mint); }, 1000), lastRefresh: 0 };
            w.timer.unref();
            this.watches.set(mint, w);
            this.solanaWs.subscribe(pool.baseVault, u => this.update(w, "base", u));
            this.solanaWs.subscribe(pool.quoteVault, u => this.update(w, "quote", u));
            await this.emit(w, baseline);
            this.health("watch_active", { mint, pool: pool.address, slot: baseline.slot });
            return true;
        }
        catch (error) {
            this.health("watch_failed", { mint, error: String(error) });
            return false;
        }
        finally {
            this.pending.delete(mint);
        }
    }
    private update(w: Watch, side: "base" | "quote", u: SolanaAccountUpdate): void {
        if (this.watches.get(w.mint) !== w)
            return;
        if (w.generation !== u.generation) {
            w.generation = u.generation;
            w.base = undefined;
            w.quote = undefined;
            w.previous = undefined;
            this.health("swap_rebaseline", { mint: w.mint, generation: u.generation });
        }
        if (u.slot < (w.previous?.slot ?? 0) || u.slot < (w[side]?.slot ?? 0)) {
            this.health("swap_stale_slot", { mint: w.mint, slot: u.slot });
            return;
        }
        if (u.owner && !["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"].includes(u.owner))
            return;
        const value = validateVault(u.dataBase64, side === "base" ? w.pool.baseMint : w.pool.quoteMint, w.pool.address);
        w[side] = { value, slot: u.slot };
        if (!w.settle) {
            w.settle = setTimeout(() => { w.settle = undefined; void this.evaluate(w).catch(error => this.health("swap_evaluation_error", { mint: w.mint, error: String(error) })); }, 80);
            w.settle.unref();
        }
    }
    private async evaluate(w: Watch): Promise<void> {
        if (this.watches.get(w.mint) !== w || w.refreshing)
            return;
        if (!w.base || !w.quote || w.base.slot !== w.quote.slot) {
            // Never combine unmatched vault slots. A shared RPC context establishes a new baseline.
            await this.refresh(w.mint);
            return;
        }
        const snap = { base: w.base.value, quote: w.quote.value, slot: w.base.slot };
        w.base = undefined;
        w.quote = undefined;
        if (snap.slot < (w.previous?.slot ?? 0))
            return;
        const prev = w.previous;
        w.previous = snap;
        if (prev && prev.base === snap.base && prev.quote === snap.quote)
            return;
        const bd = prev ? snap.base - prev.base : 0n, qd = prev ? snap.quote - prev.quote : 0n;
        const side = bd < 0n && qd > 0n ? "buy" : bd > 0n && qd < 0n ? "sell" : undefined;
        await this.emit(w, snap, side, bd, qd);
    }
    async refresh(mint: string): Promise<void> {
        const w = this.watches.get(mint);
        if (!w) {
            await this.watchMint(mint);
            return;
        }
        if (w.refreshing)
            return w.refreshing;
        if (Date.now() - w.lastRefresh < 2000)
            return;
        w.lastRefresh = Date.now();
        const generation = w.generation;
        w.refreshing = (async () => {
            try {
                const minSlot = Math.max(w.previous?.slot ?? 0, w.base?.slot ?? 0, w.quote?.slot ?? 0);
                const snap = await this.rpc.getPoolSnapshot(w.pool, minSlot);
                if (this.watches.get(mint) !== w || w.generation !== generation || snap.slot < Math.max(w.previous?.slot ?? 0, w.base?.slot ?? 0, w.quote?.slot ?? 0))
                    return;
                w.previous = snap;
                w.base = undefined;
                w.quote = undefined;
                await this.emit(w, snap);
                this.health("quote_refreshed", { mint, slot: snap.slot });
            }
            catch (error) {
                this.health("quote_refresh_failed", { mint, error: String(error) });
            }
            finally {
                w.refreshing = undefined;
            }
        })();
        return w.refreshing;
    }
    private async emit(w: Watch, s: PoolSnapshot, side?: "buy" | "sell", bd = 0n, qd = 0n): Promise<void> {
        await this.onEvent({ kind: side ? "trade" : "snapshot", receivedAt: new Date().toISOString(), mint: w.mint,
            txType: side ? `inferred_swap_${side}` : undefined, virtualSolReserves: Number(s.quote), virtualTokenReserves: Number(s.base),
            raw: { source: "solana_pumpswap_vaults", pool: w.pool.address, coherent: true, slot: s.slot, generation: w.generation,
                side, solDeltaLamports: (qd < 0n ? -qd : qd).toString(), tokenDeltaBaseUnits: (bd < 0n ? -bd : bd).toString(),
                quoteReserve: s.quote.toString(), baseReserve: s.base.toString() } });
    }
    unwatch(mint: string): void {
        const w = this.watches.get(mint);
        if (!w)
            return;
        clearInterval(w.timer);
        if (w.settle)
            clearTimeout(w.settle);
        this.solanaWs.unsubscribe(w.pool.baseVault);
        this.solanaWs.unsubscribe(w.pool.quoteVault);
        this.watches.delete(mint);
        this.health("watch_expired", { mint });
    }
    count(): number { return this.watches.size; }
    stop(): void { this.stopped = true; for (const mint of this.watches.keys())
        this.unwatch(mint); }
}
