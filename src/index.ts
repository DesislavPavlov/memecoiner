import { assertObserverConfig, config } from "./config.js";
import { JsonlEventStore } from "./logging/eventStore.js";
import { logger } from "./logging/logger.js";
import { formatObserverEvent } from "./market-data/format.js";
import { PumpCurveTracker } from "./market-data/pumpCurveTracker.js";
import { PumpPortalClient } from "./market-data/pumpPortalClient.js";
import { SolanaAccountClient } from "./market-data/solanaAccountClient.js";
import { TokenRegistry } from "./market-data/tokenRegistry.js";
import type { NormalizedMarketEvent } from "./types/market.js";

assertObserverConfig();

const store = new JsonlEventStore(config.eventLogPath);
const registry = new TokenRegistry();
const solana = new SolanaAccountClient();

let curveTracker: PumpCurveTracker;

function looksLikePump(event: NormalizedMarketEvent): boolean {
  const venue = [
    event.pool,
    event.platform,
    event.source,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  // Older/free discovery payloads may omit an explicit venue. A
  // bondingCurveKey is Pump-shaped data, so allow it when venue is absent.
  return venue.length === 0 || venue.includes("pump");
}

async function handleEvent(event: NormalizedMarketEvent): Promise<void> {
  await store.append(event);
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
    looksLikePump(event)
  ) {
    const accepted = curveTracker.watch(event.mint, event.bondingCurveKey);
    if (!accepted) {
      logger.debug(
        {
          mint: event.mint,
          max: config.maxCurveSubscriptions,
        },
        "free curve watch capacity reached",
      );
    }
  }

  if (event.kind === "migration" && state?.bondingCurveKey) {
    curveTracker.unwatch(state.bondingCurveKey);
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
  } else if (event.kind === "unknown") {
    logger.debug({ raw: event.raw }, "unclassified market event");
  }
}

curveTracker = new PumpCurveTracker(solana, handleEvent);
const pumpPortal = new PumpPortalClient(handleEvent);

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down observer");
  pumpPortal.stop();
  solana.stop();
  setTimeout(() => process.exit(0), 50);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info(
  {
    logPath: config.eventLogPath,
    discovery: "PumpPortal free new-token + migration",
    tradeData: "Solana accountSubscribe (free)",
    curveWatchTtlMs: config.curveWatchTtlMs,
    maxCurveSubscriptions: config.maxCurveSubscriptions,
  },
  "starting zero-cost read-only market observer",
);

solana.start();
pumpPortal.start();
