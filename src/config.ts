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

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${name}: ${raw}`);
  }
  return parsed;
}

const apiKey = process.env.PUMPPORTAL_API_KEY?.trim();

export const config = {
  pumpPortalApiKey: apiKey ?? "",
  pumpPortalWsUrl:
    process.env.PUMPPORTAL_WS_URL?.trim() || "wss://pumpportal.fun/api/data",
  solanaWsUrl:
    process.env.SOLANA_WS_URL?.trim() || "wss://api.mainnet.solana.com/",
  solanaRpcUrl:
    process.env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com",
  curveWatchTtlMs: readInt("CURVE_WATCH_TTL_MS", 180_000),
  maxCurveSubscriptions: readInt("MAX_CURVE_SUBSCRIPTIONS", 100),
  pumpSwapWatchTtlMs: readInt("PUMPSWAP_WATCH_TTL_MS", 300_000),
  maxPumpSwapSubscriptions: readInt("MAX_PUMPSWAP_SUBSCRIPTIONS", 40),
  dashboardPort: readInt("DASHBOARD_PORT", 3210),
  paperStartingBalanceSol: readNumber("PAPER_STARTING_BALANCE_SOL", 10),
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
