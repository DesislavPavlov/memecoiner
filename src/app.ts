import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { assertObserverConfig, config } from "./config.js";
import { DashboardServer } from "./dashboard/server.js";
import { LiveMetricsEngine } from "./engine/liveMetrics.js";
import { PaperTradingEngine } from "./engine/paperTrading.js";
import { JsonlEventStore } from "./logging/eventStore.js";
import { logger } from "./logging/logger.js";
import { PaperJournal } from "./logging/paperJournal.js";
import { createHealth } from "./logging/health.js";
import { PumpCurveTracker } from "./market-data/pumpCurveTracker.js";
import { PumpPortalClient } from "./market-data/pumpPortalClient.js";
import { PumpSwapTracker } from "./market-data/pumpSwapTracker.js";
import { SolanaAccountClient } from "./market-data/solanaAccountClient.js";
import { SolanaRpcClient } from "./market-data/solanaRpcClient.js";
import bs58 from "bs58";
import type { NormalizedMarketEvent } from "./types/market.js";
assertObserverConfig();
const runId = randomUUID(), health = createHealth(runId);
const lockPath = config.paperStatePath + ".lock";
await mkdir(dirname(lockPath), { recursive: true });
try {
    const lock = await open(lockPath, "wx");
    await lock.writeFile(String(process.pid));
    await lock.close();
}
catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw error;
    const pid = Number(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0)
        throw new Error(`Invalid paper lock: ${lockPath}`);
    try {
        process.kill(pid, 0);
        throw new Error("Another paper lab is running");
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH")
            throw e;
    }
    await unlink(lockPath);
    const lock = await open(lockPath, "wx");
    await lock.writeFile(String(process.pid));
    await lock.close();
}
const store = new JsonlEventStore(config.eventLogPath), journal = new PaperJournal(config.paperJournalPath);
const metrics = new LiveMetricsEngine(config.paperStartingBalanceSol);
const paper = new PaperTradingEngine(config.paperStartingBalanceSol, journal, { statePath: config.paperStatePath, runId, health: health.emit });
await paper.restore();
const solana = new SolanaAccountClient(health.emit), rpc = new SolanaRpcClient(health.emit);
const migrations = new Set<string>(), curves = new Map<string, string>();
let sequence = 0, tail: Promise<void> = Promise.resolve(), stopping = false, failed = false;
let lastMarketAt = 0, lastSwapAt = 0;
function enqueue(task: () => Promise<void>): Promise<void> {
    const result = tail.then(() => { if (failed)
        return; health.check(); return task(); });
    tail = result.catch(error => { failed = true; logger.error({ error }, "paper lab paused after processing failure"); health.emit("fatal_processing_error", { error: String(error) }); void shutdown("processing failure", 1); });
    return result;
}
function validAddress(s: string | undefined): boolean { try {
    return Boolean(s && bs58.decode(s).length === 32);
}
catch {
    return false;
} }
function handleEvent(event: NormalizedMarketEvent): Promise<void> {
    if (stopping)
        return Promise.resolve();
    event = { ...event, runId, sequence: ++sequence, eventId: `${runId}:${sequence}` };
    return enqueue(async () => {
        await store.append(event);
        if (event.kind === "system") {
            health.emit("upstream_control", { raw: event.raw });
            return;
        }
        if (!validAddress(event.mint))
            return;
        lastMarketAt = Date.now();
        if (event.kind === "migration") {
            if ((event.pool ?? event.raw.pool) !== "pump-amm") {
                health.emit("unsupported_migration_venue", { mint: event.mint, pool: event.pool ?? event.raw.pool });
                return;
            }
            if (migrations.has(event.mint!)) {
                health.emit("duplicate_migration", { mint: event.mint, signature: event.signature });
                return;
            }
            migrations.add(event.mint!);
        }
        const before = metrics.rowForMint(event.mint!);
        metrics.ingest(event);
        await paper.ingest(event, before, metrics.rowForMint(event.mint!));
        if (event.kind === "new_token" && validAddress(event.bondingCurveKey) && (event.pool ?? event.raw.pool) === "pump" && event.raw.is_mayhem_mode !== true) {
            curves.set(event.mint!, event.bondingCurveKey!);
            curveTracker.watch(event.mint!, event.bondingCurveKey!);
        }
        if (event.kind === "migration") {
            const key = curves.get(event.mint!);
            if (key) {
                curveTracker.unwatch(key);
                curves.delete(event.mint!);
            }
            void pumpSwapTracker.watchMint(event.mint!);
        }
        if (event.raw.source === "solana_pumpswap_vaults")
            lastSwapAt = Date.now();
    });
}
const curveTracker = new PumpCurveTracker(solana, handleEvent, health.emit);
const pumpSwapTracker = new PumpSwapTracker(solana, rpc, handleEvent, health.emit, mint => paper.openMints().includes(mint));
const pumpPortal = new PumpPortalClient(handleEvent, health.emit);
const dashboard = new DashboardServer(() => ({ ...metrics.snapshot(80, paper.summaries(), paper.recentEvents()),
    health: { runId, mode: failed ? "PAUSED" : lastMarketAt && Date.now() - lastMarketAt < 30000 ? "RECEIVING DATA" : "WAITING / STALE FEED",
        lastMarketAt, lastSwapAt, ...pumpSwapTracker.diagnostics() } }), config.dashboardPort);
const clock = setInterval(() => { void enqueue(() => paper.tick()).catch(() => { }); }, 250);
const refresh = setInterval(() => { for (const mint of paper.openMints())
    void pumpSwapTracker.refresh(mint); }, 2000);
const heartbeat = setInterval(() => health.emit("heartbeat", { lastMarketAt, lastSwapAt, curves: curveTracker.count(), pools: pumpSwapTracker.count(), bots: paper.summaries() }), 30000);
async function shutdown(signal: string, code = 0): Promise<void> {
    if (stopping)
        return;
    stopping = true;
    clearInterval(clock);
    clearInterval(refresh);
    clearInterval(heartbeat);
    pumpPortal.stop();
    pumpSwapTracker.stop();
    solana.stop();
    try {
        await tail;
        await paper.flush();
        await store.flush();
        health.emit("session_end", { signal });
        await health.flush();
        await unlink(lockPath);
    }
    catch (error) {
        logger.error({ error }, "shutdown flush failed");
        code = 1;
    }
    process.exit(code);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
const safeConfig = Object.fromEntries(Object.entries(config).filter(([k]) => !k.toLowerCase().includes("key") && !k.toLowerCase().includes("url")));
health.emit("session_start", { version: "0.3.1", schema: 3, runId, config: safeConfig, executionModel: "constant-product-v3-effective-reserves-estimated-fees", restoredOpen: paper.openMints() });
dashboard.start();
solana.start();
pumpPortal.start();
for (const mint of paper.openMints())
    void pumpSwapTracker.watchMint(mint);
logger.info({ version: "0.3.1", dashboard: `http://127.0.0.1:${config.dashboardPort}`, runId }, "Paper lab started; no real orders");
