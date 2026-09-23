import { assertObserverConfig, config } from "./config.js";
import { JsonlEventStore } from "./logging/eventStore.js";
import { logger } from "./logging/logger.js";
import { formatObserverEvent } from "./market-data/format.js";
import { PumpPortalClient } from "./market-data/pumpPortalClient.js";
import { TokenRegistry } from "./market-data/tokenRegistry.js";

assertObserverConfig();

const store = new JsonlEventStore(config.eventLogPath);
const registry = new TokenRegistry();

const client = new PumpPortalClient(async (event) => {
  await store.append(event);
  const state = registry.apply(event);

  if (event.kind === "new_token" || event.kind === "migration") {
    logger.info(
      {
        kind: event.kind,
        mint: event.mint,
        trackedTokens: registry.size(),
      },
      formatObserverEvent(event, state),
    );
  } else if (event.kind === "unknown") {
    logger.debug({ raw: event.raw }, "unclassified market event");
  }
});

function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down observer");
  client.stop();
  setTimeout(() => process.exit(0), 50);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info(
  {
    logPath: config.eventLogPath,
    subscriptions: ["new-token", "migration"],
  },
  "starting read-only market observer",
);

client.start();
