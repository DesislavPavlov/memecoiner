import type { HealthSink } from "../logging/health.js";
import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../logging/logger.js";
import { normalizeMarketEvent } from "./normalize.js";
import type { NormalizedMarketEvent } from "../types/market.js";
type EventHandler = (event: NormalizedMarketEvent) => Promise<void> | void;
export class PumpPortalClient {
    private socket?: WebSocket;
    private heartbeat?: NodeJS.Timeout;
    private alive = true;
    private stopped = false;
    private reconnectAttempt = 0;
    constructor(private readonly onEvent: EventHandler, private readonly health: HealthSink = () => { }) { }
    start(): void {
        this.stopped = false;
        this.connect();
    }
    stop(): void {
        this.stopped = true;
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.socket?.close();
    }
    private buildUrl(): string {
        const url = new URL(config.pumpPortalWsUrl);
        url.searchParams.set("api-key", config.pumpPortalApiKey);
        return url.toString();
    }
    private connect(): void {
        if (this.stopped)
            return;
        const url = this.buildUrl();
        logger.info({ endpoint: new URL(config.pumpPortalWsUrl).origin }, "connecting to PumpPortal");
        const socket = new WebSocket(url);
        this.socket = socket;
        socket.on("open", () => {
            this.alive = true;
            this.heartbeat = setInterval(() => { if (!this.alive) {
                socket.terminate();
                return;
            } this.alive = false; socket.ping(); }, 30000);
            this.heartbeat.unref();
            this.reconnectAttempt = 0;
            this.health("pumpportal_connected");
            logger.info("PumpPortal connected");
            socket.send(JSON.stringify({ method: "subscribeNewToken" }));
            socket.send(JSON.stringify({ method: "subscribeMigration" }));
            logger.info({ subscriptions: ["subscribeNewToken", "subscribeMigration"] }, "subscriptions active");
        });
        socket.on("pong", () => { this.alive = true; });
        socket.on("message", async (payload) => {
            try {
                const text = payload.toString();
                const parsed: unknown = JSON.parse(text);
                const event = normalizeMarketEvent(parsed);
                await this.onEvent(event);
            }
            catch (error) {
                this.health("pumpportal_message_error", { error: String(error) });
                logger.warn({ error }, "failed to parse/process websocket message");
            }
        });
        socket.on("error", (error) => {
            this.health("pumpportal_error", { error: String(error) });
            logger.warn({ error }, "PumpPortal websocket error");
        });
        socket.on("close", (code, reason) => {
            if (this.heartbeat)
                clearInterval(this.heartbeat);
            this.health("pumpportal_disconnected", { code });
            logger.warn({ code, reason: reason.toString() }, "PumpPortal websocket closed");
            if (!this.stopped)
                this.scheduleReconnect();
        });
    }
    private scheduleReconnect(): void {
        const exponential = config.reconnectMinMs * Math.pow(2, this.reconnectAttempt++);
        const delay = Math.min(exponential, config.reconnectMaxMs);
        logger.info({ delay }, "scheduling websocket reconnect");
        setTimeout(() => this.connect(), delay);
    }
}
