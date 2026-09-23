import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../logging/logger.js";
import { normalizeMarketEvent } from "./normalize.js";
import type { NormalizedMarketEvent } from "../types/market.js";

type EventHandler = (event: NormalizedMarketEvent) => Promise<void> | void;

export class PumpPortalClient {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectAttempt = 0;

  constructor(private readonly onEvent: EventHandler) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  private buildUrl(): string {
    const url = new URL(config.pumpPortalWsUrl);
    url.searchParams.set("api-key", config.pumpPortalApiKey);
    return url.toString();
  }

  private connect(): void {
    if (this.stopped) return;

    const url = this.buildUrl();
    logger.info({ endpoint: config.pumpPortalWsUrl }, "connecting to PumpPortal");

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      logger.info("PumpPortal connected");

      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      socket.send(JSON.stringify({ method: "subscribeMigration" }));

      logger.info(
        { subscriptions: ["subscribeNewToken", "subscribeMigration"] },
        "subscriptions active",
      );
    });

    socket.on("message", async (payload) => {
      try {
        const text = payload.toString();
        const parsed: unknown = JSON.parse(text);
        const event = normalizeMarketEvent(parsed);
        await this.onEvent(event);
      } catch (error) {
        logger.warn({ error }, "failed to parse/process websocket message");
      }
    });

    socket.on("error", (error) => {
      logger.warn({ error }, "PumpPortal websocket error");
    });

    socket.on("close", (code, reason) => {
      logger.warn(
        { code, reason: reason.toString() },
        "PumpPortal websocket closed",
      );
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const exponential =
      config.reconnectMinMs * Math.pow(2, this.reconnectAttempt++);
    const delay = Math.min(exponential, config.reconnectMaxMs);

    logger.info({ delay }, "scheduling websocket reconnect");
    setTimeout(() => this.connect(), delay);
  }
}
