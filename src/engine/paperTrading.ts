import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "../config.js";
import type { PaperBotSummary, TokenDashboardRow } from "./liveMetrics.js";
import type { NormalizedMarketEvent } from "../types/market.js";
import type { PaperJournal, PaperJournalEntry } from "../logging/paperJournal.js";
import type { HealthSink } from "../logging/health.js";
import { buyQuote, sellQuote, type PoolQuote } from "./execution.js";
import { DipSetup } from "./dip.js";
type BotId = "hybrid" | "migration";
interface Position {
    id: string;
    mint: string;
    symbol?: string;
    pool: string;
    entryAt: number;
    entryPrice: number;
    tokens: number;
    stakeSol: number;
    entryFeeSol: number;
    lastValue: number;
    peakReturnPct: number;
    exitRequested?: {
        at: number;
        reason: string;
    };
    staleReported?: boolean;
}
interface Pending {
    mint: string;
    symbol?: string;
    pool: string;
    at: number;
    signalPrice: number;
    reasons: string[];
}
interface Ledger {
    id: BotId;
    name: string;
    cashSol: number;
    realizedPnlSol: number;
    closedTrades: number;
    open?: Position;
    pending?: Pending;
    tradedMints: string[];
}
interface Track {
    migratedAt: number;
    score: number;
    setup: DipSetup;
    lastDecision?: Record<string, string>;
}
interface Options {
    statePath?: string;
    runId?: string;
    health?: HealthSink;
    clock?: () => number;
}
const ids: BotId[] = ["hybrid", "migration"];
export class PaperTradingEngine {
    private ledgers: Record<BotId, Ledger>;
    private readonly tracks = new Map<string, Track>();
    private readonly quotes = new Map<string, PoolQuote>();
    private readonly rows = new Map<string, {
        row: TokenDashboardRow;
        at: number;
    }>();
    private readonly recent: string[] = [];
    private readonly clock: () => number;
    private readonly health: HealthSink;
    private outbox: PaperJournalEntry[] = [];
    private startingBalance: number;
    private lastCheckpoint = 0;
    constructor(startingBalanceSol: number, private readonly journal: PaperJournal, private readonly options: Options = {}) {
        this.startingBalance = startingBalanceSol;
        this.clock = options.clock ?? Date.now;
        this.health = options.health ?? (() => { });
        this.ledgers = Object.fromEntries(ids.map(id => [id, {
                id, name: id === "hybrid" ? "Hybrid V2" : "Migration Scalp V2",
                cashSol: startingBalanceSol, realizedPnlSol: 0, closedTrades: 0, tradedMints: [],
            }])) as unknown as Record<BotId, Ledger>;
    }
    async restore(): Promise<void> {
        if (!this.options.statePath)
            return;
        let text: string;
        try {
            text = await readFile(this.options.statePath, "utf8");
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return;
            throw error;
        }
        const state = JSON.parse(text);
        if (state.schema !== 3 || !Number.isFinite(state.startingBalance) || !Array.isArray(state.outbox))
            throw new Error("Invalid paper checkpoint");
        for (const id of ids) {
            const b = state.ledgers?.[id];
            if (!b || b.id !== id || !Number.isFinite(b.cashSol) || b.cashSol < 0 ||
                !Number.isFinite(b.realizedPnlSol) || !Number.isInteger(b.closedTrades) || !Array.isArray(b.tradedMints))
                throw new Error("Invalid paper ledger");
            if (b.open && (![b.open.tokens, b.open.stakeSol, b.open.entryPrice, b.open.entryAt].every(v => Number.isFinite(v) && v > 0) || !b.open.pool || !b.open.id))
                throw new Error("Invalid open position");
            delete b.pending; // Never execute pre-restart signals.
        }
        this.ledgers = state.ledgers;
        this.startingBalance = state.startingBalance;
        this.outbox = state.outbox;
        await this.flushOutbox();
        this.health("paper_restored", { positions: this.openMints() });
    }
    openMints(): string[] { return [...new Set(ids.flatMap(id => this.ledgers[id].open ? [this.ledgers[id].open!.mint] : []))]; }
    async ingest(event: NormalizedMarketEvent, before?: TokenDashboardRow, after?: TokenDashboardRow): Promise<void> {
        if (!event.mint)
            return;
        const mint = event.mint, at = Date.parse(event.receivedAt), now = this.clock();
        if (!Number.isFinite(at) || at > now + 1000)
            return;
        if (event.kind === "migration") {
            if ((event.pool ?? event.raw.pool) !== "pump-amm")
                return;
            if (this.tracks.has(mint)) {
                this.health("duplicate_migration", { mint });
                return;
            }
            this.tracks.set(mint, { migratedAt: at, score: before?.hybrid.score ?? 0,
                setup: new DipSetup(config.paperMigrationMinDipPct, config.paperMaxDipPct) });
            return;
        }
        if (event.kind !== "trade" && event.kind !== "snapshot")
            return;
        const r = event.raw;
        if (r.source !== "solana_pumpswap_vaults" || r.coherent !== true || typeof r.pool !== "string")
            return;
        const base = Number(r.baseReserve), quoteSol = Number(r.quoteReserve) / 1e9, slot = Number(r.slot);
        const realQuoteSol = r.realQuoteReserve === undefined ? quoteSol : Number(r.realQuoteReserve) / 1e9;
        if (![base, quoteSol, slot].every(v => Number.isFinite(v) && v > 0) || !Number.isFinite(realQuoteSol) || realQuoteSol < 0) {
            this.quotes.delete(mint);
            const track = this.tracks.get(mint);
            if (track) track.setup = new DipSetup(config.paperMigrationMinDipPct, config.paperMaxDipPct);
            for (const id of ids) if (this.ledgers[id].pending?.mint === mint) delete this.ledgers[id].pending;
            this.health("invalid_pool_quote", { mint, slot });
            await this.tick(now);
            return;
        }
        const prev = this.quotes.get(mint);
        if (prev && (slot < prev.slot || at < prev.at || r.pool !== prev.pool))
            return;
        if (prev && prev.generation !== r.generation) {
            const track = this.tracks.get(mint);
            if (track) track.setup = new DipSetup(config.paperMigrationMinDipPct, config.paperMaxDipPct);
            for (const id of ids) if (this.ledgers[id].pending?.mint === mint) delete this.ledgers[id].pending;
        }
        const quote: PoolQuote = { pool: r.pool, base, quoteSol, realQuoteSol, slot, at, generation: typeof r.generation === "number" ? r.generation : undefined };
        this.quotes.set(mint, quote);
        if (after)
            this.rows.set(mint, { row: after, at });
        const track = this.tracks.get(mint);
        if (event.kind === "trade" && track && now - at <= config.paperQuoteMaxAgeMs) {
            track.setup.update(quoteSol / base, at);
        }
        await this.tick(now, event.eventId);
        if (!track || event.kind !== "trade" || !after)
            return;
        for (const id of ids) {
            const bot = this.ledgers[id];
            if (bot.open || bot.pending || bot.tradedMints.includes(mint))
                continue;
            const reject = this.entryRejection(id, mint, now);
            if (reject) {
                this.decision(track, mint, id + ": " + reject);
                continue;
            }
            bot.pending = { mint, symbol: after.symbol, pool: quote.pool, at: now, signalPrice: quoteSol / base,
                reasons: [id === "hybrid" ? `Pre-migration score ${track.score}` : "Pure migration: no pre-score",
                    `Ordered dip ${track.setup.dipPct.toFixed(1)}%`, `Recovery ${track.setup.recoveryPct(quoteSol / base).toFixed(1)}%`,
                    `Post-migration 10s flow ratio ${after.w10.buySellVolumeRatio?.toFixed(2)}`] };
            this.health("entry_signal", { bot: id, mint, peakAt: track.setup.peakAt, troughAt: track.setup.troughAt, eventId: event.eventId });
        }
    }
    private entryRejection(id: BotId, mint: string, now: number): string | undefined {
        const q = this.quotes.get(mint), t = this.tracks.get(mint), row = this.rows.get(mint)?.row;
        if (!q || !t || !row || now - q.at > config.paperQuoteMaxAgeMs)
            return "stale/missing quote";
        if (now - t.migratedAt > config.paperMigrationEntryWindowSec * 1000)
            return "entry window expired";
        if (id === "hybrid" && t.score < config.paperHybridMinScore)
            return "pre-score below threshold";
        if (t.setup.phase === "rejected")
            return "collapse exceeds maximum dip";
        if (t.setup.phase !== "recovery" || t.setup.samples < config.paperMinPostSamples || now - t.migratedAt < config.paperMinSetupMs)
            return "waiting for ordered dip/recovery";
        const price = q.quoteSol / q.base;
        const recovery = t.setup.recoveryPct(price);
        if (recovery < (id === "hybrid" ? config.paperHybridRecoveryPct : config.paperMigrationRecoveryPct))
            return "recovery too small";
        if (price > t.setup.peak)
            return "recovery already above setup peak";
        if ((q.realQuoteSol ?? q.quoteSol) < config.paperMinQuoteSol)
            return "insufficient quote liquidity";
        if (buyQuote(q, config.paperPositionSol).impactPct > config.paperMaxImpactPct)
            return "entry price impact too high";
        if ((row.w10.buySellVolumeRatio ?? 0) < (id === "hybrid" ? 1.2 : 1.05) || row.w10.buys < 2 || row.w10.buySol < config.paperMinBuySol10)
            return "insufficient post-migration buying";
        return undefined;
    }
    async tick(now = this.clock(), eventId?: string): Promise<void> {
        for (const id of ids) {
            const bot = this.ledgers[id];
            if (bot.open)
                await this.manage(bot, now, eventId);
            const pending = bot.pending;
            if (!pending)
                continue;
            if (now - pending.at > config.paperPendingTtlMs) {
                this.health("entry_cancelled", { bot: id, mint: pending.mint, reason: "execution quote timeout" });
                delete bot.pending;
                continue;
            }
            const q = this.quotes.get(pending.mint);
            if (!q || q.at < pending.at + config.paperExecutionDelayMs || now - q.at > config.paperQuoteMaxAgeMs)
                continue;
            const reject = this.entryRejection(id, pending.mint, now);
            const slippage = ((q.quoteSol / q.base) / pending.signalPrice - 1) * 100;
            if (reject || slippage > config.paperMaxEntrySlippagePct || q.pool !== pending.pool) {
                this.health("entry_cancelled", { bot: id, mint: pending.mint, reason: reject ?? "entry slippage/pool changed" });
                delete bot.pending;
                continue;
            }
            delete bot.pending;
            const stake = config.paperPositionSol, fee = stake * config.paperFeePctPerSide / 100;
            if (bot.cashSol < stake + fee)
                continue;
            const fill = buyQuote(q, stake);
            bot.cashSol -= stake + fee;
            const pos: Position = { id: randomUUID(), mint: pending.mint, symbol: pending.symbol, pool: q.pool,
                entryAt: now, entryPrice: stake / fill.tokens, tokens: fill.tokens, stakeSol: stake, entryFeeSol: fee,
                lastValue: sellQuote(q, fill.tokens) * (1 - config.paperFeePctPerSide / 100), peakReturnPct: 0 };
            bot.open = pos;
            bot.tradedMints.push(pos.mint);
            await this.commit({ ts: new Date(now).toISOString(), bot: id, action: "ENTRY", mint: pos.mint, symbol: pos.symbol,
                priceRatio: pos.entryPrice / 1e9, stakeSol: stake, feeSol: fee, balanceAfterSol: bot.cashSol,
                reasons: [...pending.reasons, `AMM impact ${fill.impactPct.toFixed(2)}%; delayed paper fill`],
                positionId: pos.id, runId: this.options.runId, eventId, quoteSlot: q.slot, quoteSol: q.quoteSol, tokenBaseUnits: pos.tokens,
                signalAt: new Date(pending.at).toISOString(), executionModel: "constant-product-v3-effective-reserves-estimated-fees" });
        }
        for (const [mint, t] of this.tracks) {
            if (now - t.migratedAt > 20 * 60000 && !this.openMints().includes(mint)) {
                this.tracks.delete(mint);
                this.quotes.delete(mint);
                this.rows.delete(mint);
            }
        }
        if (now - this.lastCheckpoint >= 1000 && this.openMints().length) {
            await this.checkpoint();
            this.lastCheckpoint = now;
        }
    }
    private async manage(bot: Ledger, now: number, eventId?: string): Promise<void> {
        const p = bot.open!, q = this.quotes.get(p.mint);
        const fresh = q && q.pool === p.pool && now - q.at <= config.paperQuoteMaxAgeMs;
        if (!fresh && !p.staleReported) {
            p.staleReported = true;
            this.health("position_stale", { bot: bot.id, mint: p.mint });
        }
        const held = (now - p.entryAt) / 1000;
        if (!p.exitRequested && held >= (bot.id === "migration" ? 120 : 180))
            p.exitRequested = { at: now, reason: "wall-clock timeout" };
        if (!fresh) {
            if (!p.exitRequested && now - p.entryAt > config.paperQuoteMaxAgeMs)
                p.exitRequested = { at: now, reason: "stale feed exit requested" };
            return; // Unresolved is explicit; never manufacture a stale-price fill.
        }
        p.staleReported = false;
        const proceeds = sellQuote(q, p.tokens), net = proceeds * (1 - config.paperFeePctPerSide / 100);
        if (proceeds > (q.realQuoteSol ?? q.quoteSol)) {
            p.staleReported = true;
            this.health("exit_insufficient_real_liquidity", { mint: p.mint, bot: bot.id });
            return;
        }
        p.lastValue = net;
        const ret = (net / (p.stakeSol + p.entryFeeSol) - 1) * 100;
        p.peakReturnPct = Math.max(p.peakReturnPct, ret);
        let reason: string | undefined;
        if (ret <= (bot.id === "migration" ? -15 : -10))
            reason = "net liquidation stop";
        else if (ret >= (bot.id === "migration" ? config.paperMigrationTargetPct : 100))
            reason = "net profit target";
        else if (p.peakReturnPct >= (bot.id === "migration" ? config.paperMigrationTrailArmPct : 25) &&
            ret <= p.peakReturnPct * (1 - (bot.id === "migration" ? config.paperMigrationTrailGivebackPct : 35) / 100))
            reason = "profit giveback";
        else {
            const flow = this.rows.get(p.mint)?.row.w10;
            if (bot.id === "hybrid" && ret >= 5 && flow && flow.sells > 0 && (flow.buySellVolumeRatio ?? 0) < 0.8)
                reason = "profitable flow reversal";
        }
        if (!p.exitRequested && reason)
            p.exitRequested = { at: now, reason };
        if (!p.exitRequested || q.at < p.exitRequested.at + config.paperExecutionDelayMs)
            return;
        const fee = proceeds * config.paperFeePctPerSide / 100, pnl = net - p.stakeSol - p.entryFeeSol;
        bot.cashSol += net;
        bot.realizedPnlSol += pnl;
        bot.closedTrades++;
        delete bot.open;
        await this.commit({ ts: new Date(now).toISOString(), bot: bot.id, action: "EXIT", mint: p.mint, symbol: p.symbol,
            priceRatio: proceeds / p.tokens / 1e9, stakeSol: p.stakeSol, feeSol: fee, balanceAfterSol: bot.cashSol,
            reasons: [p.exitRequested.reason, `Net paper P&L ${pnl.toFixed(6)} SOL`], pnlSol: pnl, pnlPct: ret,
            positionId: p.id, runId: this.options.runId, eventId, quoteSlot: q.slot, quoteSol: q.quoteSol, tokenBaseUnits: p.tokens,
            signalAt: new Date(p.exitRequested.at).toISOString(), executionModel: "constant-product-v3-effective-reserves-estimated-fees" });
    }
    summaries(): PaperBotSummary[] {
        return ids.map(id => {
            const b = this.ledgers[id], p = b.open;
            return { id, name: b.name, startingBalanceSol: this.startingBalance, balanceSol: b.cashSol + (p?.lastValue ?? 0),
                realizedPnlSol: b.realizedPnlSol, openPositions: p ? 1 : 0, closedTrades: b.closedTrades, mode: "paper",
                status: p ? (p.staleReported ? "STALE / UNRESOLVED" : p.exitRequested ? "EXIT PENDING" : "OPEN") + " " + (p.symbol ?? p.mint) : b.pending ? "ENTRY PENDING" : "SCANNING" };
        });
    }
    recentEvents(): string[] { return [...this.recent]; }
    private decision(track: Track, mint: string, reason: string): void {
        const bot = reason.split(":")[0]!;
        track.lastDecision ??= {};
        if (track.lastDecision[bot] === reason)
            return;
        track.lastDecision[bot] = reason;
        this.health("setup_decision", { mint, reason });
    }
    private async commit(entry: PaperJournalEntry): Promise<void> {
        this.outbox.push(entry);
        await this.checkpoint(); // Persist ledger and journal intent together before appending.
        await this.flushOutbox();
        this.recent.unshift(`${entry.bot.toUpperCase()} ${entry.action} ${entry.symbol ?? entry.mint} · ${entry.reasons[0]}`);
        this.recent.length = Math.min(this.recent.length, 40);
    }
    private async flushOutbox(): Promise<void> {
        for (const entry of this.outbox)
            await this.journal.append(entry);
        this.outbox = [];
        await this.checkpoint();
    }
    private async checkpoint(): Promise<void> {
        const path = this.options.statePath;
        if (!path)
            return;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path + ".tmp", JSON.stringify({ schema: 3, startingBalance: this.startingBalance, ledgers: this.ledgers, outbox: this.outbox }), "utf8");
        await rename(path + ".tmp", path);
    }
    async flush(): Promise<void> { await this.checkpoint(); await this.journal.flush(); }
}
