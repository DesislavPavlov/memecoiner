import "dotenv/config";
function readInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid integer for ${name}: ${raw}`);
    }
    return parsed;
}
function readNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid number for ${name}: ${raw}`);
    }
    return parsed;
}
const apiKey = process.env.PUMPPORTAL_API_KEY?.trim();
export const config = {
    pumpPortalApiKey: apiKey ?? "",
    pumpPortalWsUrl: process.env.PUMPPORTAL_WS_URL?.trim() || "wss://pumpportal.fun/api/data",
    solanaWsUrl: process.env.SOLANA_WS_URL?.trim() || "wss://api.mainnet-beta.solana.com/",
    solanaRpcUrl: process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com",
    curveWatchTtlMs: readInt("CURVE_WATCH_TTL_MS", 180000),
    maxCurveSubscriptions: readInt("MAX_CURVE_SUBSCRIPTIONS", 100),
    pumpSwapWatchTtlMs: readInt("PUMPSWAP_WATCH_TTL_MS", 300000),
    maxPumpSwapSubscriptions: readInt("MAX_PUMPSWAP_SUBSCRIPTIONS", 40),
    paperMaxDipPct: readNumber("PAPER_MAX_DIP_PCT", 40),
    paperMinQuoteSol: readNumber("PAPER_MIN_QUOTE_SOL", 10),
    paperMaxImpactPct: readNumber("PAPER_MAX_IMPACT_PCT", 2),
    paperMinBuySol10: readNumber("PAPER_MIN_BUY_SOL_10", 0.1),
    paperMinSampleSol: readNumber("PAPER_MIN_SAMPLE_SOL", 0.001),
    paperMinPostSamples: readInt("PAPER_MIN_POST_SAMPLES", 5),
    paperMinSetupMs: readInt("PAPER_MIN_SETUP_MS", 3000),
    paperQuoteMaxAgeMs: readInt("PAPER_QUOTE_MAX_AGE_MS", 3000),
    paperExecutionDelayMs: readInt("PAPER_EXECUTION_DELAY_MS", 500),
    paperMaxEntrySlippagePct: readNumber("PAPER_MAX_ENTRY_SLIPPAGE_PCT", 3),
    paperPendingTtlMs: readInt("PAPER_PENDING_TTL_MS", 5000),
    paperMigrationTargetPct: readNumber("PAPER_MIGRATION_TARGET_PCT", 25),
    paperMigrationTrailArmPct: readNumber("PAPER_MIGRATION_TRAIL_ARM_PCT", 12),
    paperMigrationTrailGivebackPct: readNumber("PAPER_MIGRATION_TRAIL_GIVEBACK_PCT", 35),
    paperStatePath: process.env.PAPER_STATE_PATH?.trim() || "data/paper-state-v3.json",
    healthLogPath: process.env.HEALTH_LOG_PATH?.trim() || "data/health.jsonl",
    logRotateBytes: readInt("LOG_ROTATE_BYTES", 64 * 1024 * 1024),
    rpcTimeoutMs: readInt("RPC_TIMEOUT_MS", 8000),
    dashboardPort: readInt("DASHBOARD_PORT", 3210),
    paperStartingBalanceSol: readNumber("PAPER_STARTING_BALANCE_SOL", 10),
    paperPositionSol: readNumber("PAPER_POSITION_SOL", 0.25),
    paperFeePctPerSide: readNumber("PAPER_FEE_PCT_PER_SIDE", 1.25),
    paperMigrationEntryWindowSec: readNumber("PAPER_MIGRATION_ENTRY_WINDOW_SEC", 120),
    paperMigrationMinDipPct: readNumber("PAPER_MIGRATION_MIN_DIP_PCT", 8),
    paperMigrationRecoveryPct: readNumber("PAPER_MIGRATION_RECOVERY_PCT", 3),
    paperHybridRecoveryPct: readNumber("PAPER_HYBRID_RECOVERY_PCT", 4),
    paperHybridMinScore: readNumber("PAPER_HYBRID_MIN_SCORE", 75),
    paperJournalPath: process.env.PAPER_JOURNAL_PATH?.trim() || "data/paper-trades.jsonl",
    eventLogPath: process.env.EVENT_LOG_PATH?.trim() || "data/events.jsonl",
    logLevel: process.env.LOG_LEVEL?.trim() || "info",
    reconnectMinMs: readInt("RECONNECT_MIN_MS", 1000),
    reconnectMaxMs: readInt("RECONNECT_MAX_MS", 30000),
} as const;
export function assertObserverConfig(): void {
    for (const [key, value] of Object.entries(config)) {
        if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
            throw new Error(`Configuration ${key} must be positive and finite`);
        }
    }
    if (config.paperMaxDipPct >= 100 || config.paperMaxDipPct <= config.paperMigrationMinDipPct ||
        config.paperMaxImpactPct >= 100 || config.paperFeePctPerSide >= 100 ||
        config.paperMigrationTrailGivebackPct >= 100 ||
        config.paperPendingTtlMs <= config.paperExecutionDelayMs) {
        throw new Error("Invalid paper risk/fee/execution bounds");
    }
    if (!config.pumpPortalApiKey) {
        throw new Error("PUMPPORTAL_API_KEY is required. Copy .env.example to .env and add your key.");
    }
}
