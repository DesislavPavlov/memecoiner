import "dotenv/config";

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return parsed;
}

const apiKey = process.env.PUMPPORTAL_API_KEY?.trim();

export const config = {
  pumpPortalApiKey: apiKey ?? "",
  pumpPortalWsUrl:
    process.env.PUMPPORTAL_WS_URL?.trim() || "wss://pumpportal.fun/api/data",
  eventLogPath: process.env.EVENT_LOG_PATH?.trim() || "data/events.jsonl",
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
  reconnectMinMs: readInt("RECONNECT_MIN_MS", 1_000),
  reconnectMaxMs: readInt("RECONNECT_MAX_MS", 30_000),
} as const;

export function assertObserverConfig(): void {
  if (!config.pumpPortalApiKey) {
    throw new Error(
      "PUMPPORTAL_API_KEY is required. Copy .env.example to .env and add your key.",
    );
  }
}
