import { JsonlEventStore } from "./eventStore.js";
import { config } from "../config.js";
import { logger } from "./logger.js";
export type HealthSink = (type: string, detail?: Record<string, unknown>) => void;
export function createHealth(runId: string) {
    const store = new JsonlEventStore(config.healthLogPath);
    let failure: unknown;
    const emit: HealthSink = (type, detail = {}) => {
        void store.append({ ts: new Date().toISOString(), runId, type, ...detail })
            .catch(error => { failure = error;
            logger.error({ error }, "health journal failed"); process.exitCode = 1; });
    };
    return { emit, check: () => { if (failure) throw failure; }, flush: () => store.flush() };
}
