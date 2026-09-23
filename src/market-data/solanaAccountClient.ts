import WebSocket from "ws";
import { config } from "../config.js";
import { logger } from "../logging/logger.js";

export interface SolanaAccountUpdate {
  pubkey: string;
  slot: number;
  dataBase64: string;
  lamports?: number;
}

type Handler = (update: SolanaAccountUpdate) => Promise<void> | void;

interface DesiredSubscription {
  handler: Handler;
}

export class SolanaAccountClient {
  private socket?: WebSocket;
  private stopped = false;
  private reconnectAttempt = 0;
  private requestId = 1;
  private readonly desired = new Map<string, DesiredSubscription>();
  private readonly pending = new Map<number, string>();
  private readonly serverSubscriptions = new Map<number, string>();

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  subscribe(pubkey: string, handler: Handler): boolean {
    const isNew = !this.desired.has(pubkey);
    this.desired.set(pubkey, { handler });

    if (isNew && this.socket?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(pubkey);
    }
    return isNew;
  }

  unsubscribe(pubkey: string): void {
    this.desired.delete(pubkey);

    for (const [serverId, mappedPubkey] of this.serverSubscriptions) {
      if (mappedPubkey !== pubkey) continue;
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: this.requestId++,
            method: "accountUnsubscribe",
            params: [serverId],
          }),
        );
      }
      this.serverSubscriptions.delete(serverId);
    }
  }

  count(): number {
    return this.desired.size;
  }

  private connect(): void {
    if (this.stopped) return;

    logger.info({ endpoint: config.solanaWsUrl }, "connecting to free Solana WSS");
    const socket = new WebSocket(config.solanaWsUrl);
    this.socket = socket;

    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.pending.clear();
      this.serverSubscriptions.clear();
      logger.info(
        { desiredSubscriptions: this.desired.size },
        "free Solana WSS connected",
      );

      for (const pubkey of this.desired.keys()) {
        this.sendSubscribe(pubkey);
      }
    });

    socket.on("message", async (payload) => {
      try {
        const message = JSON.parse(payload.toString()) as Record<string, unknown>;

        if (typeof message.id === "number" && typeof message.result === "number") {
          const pubkey = this.pending.get(message.id);
          if (pubkey) {
            this.pending.delete(message.id);
            this.serverSubscriptions.set(message.result, pubkey);
          }
          return;
        }

        if (message.method !== "accountNotification") return;
        const params = message.params as
          | {
              subscription?: number;
              result?: {
                context?: { slot?: number };
                value?: {
                  lamports?: number;
                  data?: [string, string] | string;
                };
              };
            }
          | undefined;

        const serverId = params?.subscription;
        if (typeof serverId !== "number") return;
        const pubkey = this.serverSubscriptions.get(serverId);
        if (!pubkey) return;

        const value = params?.result?.value;
        const encoded = Array.isArray(value?.data)
          ? value?.data[0]
          : typeof value?.data === "string"
            ? value.data
            : undefined;
        if (!encoded) return;

        const handler = this.desired.get(pubkey)?.handler;
        if (!handler) return;

        await handler({
          pubkey,
          slot: params?.result?.context?.slot ?? 0,
          dataBase64: encoded,
          lamports: value?.lamports,
        });
      } catch (error) {
        logger.warn({ error }, "failed to process Solana account update");
      }
    });

    socket.on("error", (error) => {
      logger.warn({ error }, "Solana websocket error");
    });

    socket.on("close", (code, reason) => {
      logger.warn(
        { code, reason: reason.toString() },
        "Solana websocket closed",
      );
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private sendSubscribe(pubkey: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;

    const id = this.requestId++;
    this.pending.set(id, pubkey);
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "accountSubscribe",
        params: [
          pubkey,
          {
            encoding: "base64",
            commitment: "processed",
          },
        ],
      }),
    );
  }

  private scheduleReconnect(): void {
    const exponential =
      config.reconnectMinMs * Math.pow(2, this.reconnectAttempt++);
    const delay = Math.min(exponential, config.reconnectMaxMs);
    logger.info({ delay }, "scheduling Solana websocket reconnect");
    setTimeout(() => this.connect(), delay);
  }
}
