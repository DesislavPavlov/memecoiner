import { config } from "../config.js";
import type { HealthSink } from "../logging/health.js";
import type { NormalizedMarketEvent } from "../types/market.js";
import { decodePumpSwapPool, PUMP_AMM_PROGRAM_ID, validateVault, type PumpSwapPool } from "./pumpSwapPool.js";
import { SolanaAccountClient, type SolanaAccountUpdate } from "./solanaAccountClient.js";
import { SolanaRpcClient, type PoolSnapshot } from "./solanaRpcClient.js";
type EventHandler = (event: NormalizedMarketEvent) => Promise<void> | void;
interface Watch {
    mint: string;
    pool: PumpSwapPool;
    previous?: PoolSnapshot;
    generation?: number;
    quoteEpoch: number;
    metadataSlot: number;
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
    private discoveryAttempts = 0;
    private discoveryFailures = 0;
    private lastDiscoveryError = "";
    diagnostics() { return { activePools: this.watches.size, pendingPools: this.pending.size, discoveryAttempts: this.discoveryAttempts, discoveryFailures: this.discoveryFailures, lastDiscoveryError: this.lastDiscoveryError }; }
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
        this.discoveryAttempts++;
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
                    this.lastDiscoveryError = String(error);
                    this.health("discovery_retry", { mint, error: String(error) });
                }
            }
            if (!pool) {
                this.discoveryFailures++;
                this.health("discovery_failed", { mint, error: this.lastDiscoveryError || "Pool not found" });
                return false;
            }
            const baseline = await this.rpc.getPoolSnapshot(pool);
            if (this.stopped)
                return false;
            const w: Watch = { mint, pool: { ...pool, virtualQuoteReserves: baseline.virtualQuoteReserves ?? pool.virtualQuoteReserves }, previous: baseline, quoteEpoch: 0, metadataSlot: baseline.slot, expiresAt: Date.now() + config.pumpSwapWatchTtlMs,
                timer: setInterval(() => { if (Date.now() > w.expiresAt && !this.isPinned(mint))
                    this.unwatch(mint); }, 1000), lastRefresh: 0 };
            w.timer.unref();
            this.watches.set(mint, w);
            this.solanaWs.subscribe(pool.baseVault, u => this.update(w, "base", u));
            this.solanaWs.subscribe(pool.quoteVault, u => this.update(w, "quote", u));
            this.solanaWs.subscribe(pool.address, u => this.updateMetadata(w, u));
            await this.emit(w, baseline);
            this.health("watch_active", { mint, pool: pool.address, slot: baseline.slot });
            return true;
        }
        catch (error) {
            this.discoveryFailures++;
            this.lastDiscoveryError = String(error);
            this.health("watch_failed", { mint, error: String(error) });
            return false;
        }
        finally {
            this.pending.delete(mint);
        }
    }
    private async updateMetadata(w: Watch, u: SolanaAccountUpdate): Promise<void> {
        if (this.watches.get(w.mint) !== w || u.slot < w.metadataSlot) return;
        w.metadataSlot = u.slot;
        const p = decodePumpSwapPool(w.pool.address, u.dataBase64);
        const valid = (!u.owner || u.owner === PUMP_AMM_PROGRAM_ID) && !p.unsupportedMode &&
            p.index === w.pool.index && p.creator === w.pool.creator && p.baseMint === w.pool.baseMint &&
            p.quoteMint === w.pool.quoteMint && p.baseVault === w.pool.baseVault && p.quoteVault === w.pool.quoteVault;
        if (!valid || p.virtualQuoteReserves !== w.pool.virtualQuoteReserves) {
            w.quoteEpoch++;
            w.previous = undefined; w.base = undefined; w.quote = undefined;
            await this.emit(w, { base: 0n, quote: 0n, slot: u.slot, virtualQuoteReserves: 0n });
            if (!valid) { this.health("pool_metadata_invalid", { mint: w.mint }); this.unwatch(w.mint); return; }
            w.pool = p;
            await this.refresh(w.mint);
        }
    }
    private update(w: Watch, side: "base" | "quote", u: SolanaAccountUpdate): void {
        if (this.watches.get(w.mint) !== w)
            return;
        if (w.generation !== u.generation) {
            w.generation = u.generation;
            w.quoteEpoch++;
            w.base = undefined;
            w.quote = undefined;
            w.previous = undefined;
            this.health("swap_rebaseline", { mint: w.mint, generation: u.generation });
        }
        if (u.slot < w.metadataSlot || u.slot < (w.previous?.slot ?? 0) || u.slot < (w[side]?.slot ?? 0)) {
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
        const snap = { base: w.base.value, quote: w.quote.value, slot: w.base.slot, virtualQuoteReserves: w.pool.virtualQuoteReserves };
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
        const generation = w.generation, epoch = w.quoteEpoch;
        w.refreshing = (async () => {
            try {
                const minSlot = Math.max(w.metadataSlot, w.previous?.slot ?? 0, w.base?.slot ?? 0, w.quote?.slot ?? 0);
                const snap = await this.rpc.getPoolSnapshot(w.pool, minSlot);
                if (this.watches.get(mint) !== w || w.generation !== generation || w.quoteEpoch !== epoch || snap.slot < Math.max(w.previous?.slot ?? 0, w.base?.slot ?? 0, w.quote?.slot ?? 0))
                    return;
                if (snap.virtualQuoteReserves !== undefined && snap.virtualQuoteReserves !== w.pool.virtualQuoteReserves) {
                    w.pool.virtualQuoteReserves = snap.virtualQuoteReserves; w.quoteEpoch++;
                }
                w.metadataSlot = Math.max(w.metadataSlot, snap.slot);
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
        const virtual = s.virtualQuoteReserves ?? w.pool.virtualQuoteReserves ?? 0n;
        const effective = s.quote + virtual;
        await this.onEvent({ kind: side ? "trade" : "snapshot", receivedAt: new Date().toISOString(), mint: w.mint,
            txType: side ? `inferred_swap_${side}` : undefined, virtualSolReserves: Number(effective), virtualTokenReserves: Number(s.base),
            raw: { source: "solana_pumpswap_vaults", pool: w.pool.address, coherent: true, slot: s.slot, generation: w.quoteEpoch,
                side, solDeltaLamports: (qd < 0n ? -qd : qd).toString(), tokenDeltaBaseUnits: (bd < 0n ? -bd : bd).toString(),
                quoteReserve: effective.toString(), realQuoteReserve: s.quote.toString(), virtualQuoteReserve: virtual.toString(), baseReserve: s.base.toString() } });
    }
    unwatch(mint: string): void {
        const w = this.watches.get(mint);
        if (!w)
            return;
        clearInterval(w.timer);
        if (w.settle)
            clearTimeout(w.settle);
        this.solanaWs.unsubscribe(w.pool.address);
        this.solanaWs.unsubscribe(w.pool.baseVault);
        this.solanaWs.unsubscribe(w.pool.quoteVault);
        this.watches.delete(mint);
        this.health("watch_expired", { mint });
    }
    count(): number { return this.watches.size; }
    stop(): void { this.stopped = true; for (const mint of this.watches.keys())
        this.unwatch(mint); }
}
