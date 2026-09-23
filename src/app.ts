import { assertObserverConfig, config } from "./config.js";
import { DashboardServer } from "./dashboard/server.js";
import { LiveMetricsEngine } from "./engine/liveMetrics.js";
import { JsonlEventStore } from "./logging/eventStore.js";
import { logger } from "./logging/logger.js";
import { formatObserverEvent } from "./market-data/format.js";
import { PumpCurveTracker } from "./market-data/pumpCurveTracker.js";
import { PumpPortalClient } from "./market-data/pumpPortalClient.js";
import { PumpSwapTracker } from "./market-data/pumpSwapTracker.js";
import { SolanaAccountClient } from "./market-data/solanaAccountClient.js";
import { SolanaRpcClient } from "./market-data/solanaRpcClient.js";
import { TokenRegistry } from "./market-data/tokenRegistry.js";
import type { NormalizedMarketEvent } from "./types/market.js";

assertObserverConfig();

const store = new JsonlEventStore(config.eventLogPath);
const registry = new TokenRegistry();
const metrics = new LiveMetricsEngine(config.paperStartingBalanceSol);
const solana = new SolanaAccountClient();
const rpc = new SolanaRpcClient();
const dashboard = new DashboardServer(metrics, config.dashboardPort);

let curveTracker: PumpCurveTracker;
let pumpSwapTracker: PumpSwapTracker;

function isSolanaAddress(value: string | undefined): boolean {
  return Boolean(value && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value));
}

function isSolanaPump(event: NormalizedMarketEvent): boolean {
  if (event.chain && !event.chain.toLowerCase().includes("solana")) return false;
  if (!isSolanaAddress(event.mint) || !isSolanaAddress(event.bondingCurveKey)) {
    return false;
  }

  const venue = [event.pool, event.platform, event.source]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  return venue.length === 0 || venue.includes("pump");
}

async function handleEvent(event: NormalizedMarketEvent): Promise<void> {
  await store.append(event);
  metrics.ingest(event);
  const state = registry.apply(event);

  if (event.kind === "new_token" || event.kind === "migration") {
    logger.info(
      {
        kind: event.kind,
        mint: event.mint,
        trackedTokens: registry.size(),
        watchedCurves: curveTracker.count(),
      },
      formatObserverEvent(event, state),
    );
  }

  if (
    event.kind === "new_token" &&
    event.mint &&
    event.bondingCurveKey &&
    isSolanaPump(event)
  ) {
    curveTracker.watch(event.mint, event.bondingCurveKey);
  }

  if (event.kind === "migration" && event.mint && isSolanaAddress(event.mint)) {
    if (state?.bondingCurveKey) {
      curveTracker.unwatch(state.bondingCurveKey);
    }
    void pumpSwapTracker.watchMint(event.mint);
  }

  if (event.kind === "trade" && event.txType?.startsWith("inferred_")) {
    const rawAmount = event.raw.solDeltaLamports;
    const lamports =
      typeof rawAmount === "string" ? Number(rawAmount) : Number.NaN;
    const sol = Number.isFinite(lamports) ? lamports / 1_000_000_000 : undefined;

    logger.info(
      {
        mint: event.mint,
        side: event.txType.replace("inferred_", ""),
        sol,
        source: "free-solana-wss",
      },
      `[FREE TRADE] ${event.txType.replace("inferred_", "").toUpperCase()} ${
        sol !== undefined ? `${sol.toFixed(4)} SOL` : ""
      }`,
    );
  }
}

curveTracker = new PumpCurveTracker(solana, handleEvent);
pumpSwapTracker = new PumpSwapTracker(solana, rpc, handleEvent);
const pumpPortal = new PumpPortalClient(handleEvent);

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down paper lab");
  pumpPortal.stop();
  solana.stop();
  setTimeout(() => process.exit(0), 50);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

dashboard.start();
solana.start();
pumpPortal.start();

logger.info(
  {
    dashboard: `http://127.0.0.1:${config.dashboardPort}`,
    mode: "paper-only",
    paidTradeFeeds: false,
    preMigration: "free bonding-curve accountSubscribe",
    postMigration: "free PumpSwap vault accountSubscribe",
  },
  "Memecoiner Paper Lab started",
);
