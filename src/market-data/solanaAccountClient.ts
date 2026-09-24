import WebSocket from "ws";
import type { HealthSink } from "../logging/health.js";
import { config } from "../config.js";
import { logger } from "../logging/logger.js";
export interface SolanaAccountUpdate {
    pubkey: string;
    slot: number;
    generation?: number;
    owner?: string;
    dataBase64: string;
    lamports?: number;
}
type Handler = (update: SolanaAccountUpdate) => Promise<void> | void;
interface DesiredSubscription {
    handler: Handler;
}
export class SolanaAccountClient {
    private socket?: WebSocket;
    private generation = 0;
    private messageTail: Promise<void> = Promise.resolve();
    private heartbeat?: NodeJS.Timeout;
    private alive = true;
    constructor(private readonly health: HealthSink = () => { }) { }
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
        if (this.heartbeat)
            clearInterval(this.heartbeat);
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
            if (mappedPubkey !== pubkey)
                continue;
            if (this.socket?.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({
                    jsonrpc: "2.0",
                    id: this.requestId++,
                    method: "accountUnsubscribe",
                    params: [serverId],
                }));
            }
            this.serverSubscriptions.delete(serverId);
        }
    }
    count(): number {
        return this.desired.size;
    }
    private connect(): void {
        if (this.stopped)
            return;
        logger.info({ endpoint: new URL(config.solanaWsUrl).origin }, "connecting to free Solana WSS");
        const socket = new WebSocket(config.solanaWsUrl);
        this.socket = socket;
        socket.on("open", () => {
            this.generation++;
            this.health("solana_connected", { generation: this.generation, desired: this.desired.size });
            this.alive = true;
            this.heartbeat = setInterval(() => { if (!this.alive) {
                socket.terminate();
                return;
            } this.alive = false; socket.ping(); }, 30000);
            this.heartbeat.unref();
            this.reconnectAttempt = 0;
            this.pending.clear();
            this.serverSubscriptions.clear();
            logger.info({ desiredSubscriptions: this.desired.size }, "free Solana WSS connected");
            for (const pubkey of this.desired.keys()) {
                this.sendSubscribe(pubkey);
            }
        });
        socket.on("pong", () => { this.alive = true; });
        socket.on("message", (payload) => {
            const generation = this.generation;
            this.messageTail = this.messageTail.then(async () => {
                if (socket !== this.socket || generation !== this.generation)
                    return;
                try {
                    const message = JSON.parse(payload.toString()) as Record<string, unknown>;
                    if (typeof message.id === "number" && message.error) {
                        const pubkey = this.pending.get(message.id);
                        this.pending.delete(message.id);
                        this.health("subscription_error", { pubkey, error: message.error });
                        if (pubkey && this.desired.has(pubkey))
                            setTimeout(() => { if (this.socket === socket && this.desired.has(pubkey))
                                this.sendSubscribe(pubkey); }, 5000).unref();
                        return;
                    }
                    if (typeof message.id === "number" && typeof message.result === "number") {
                        const pubkey = this.pending.get(message.id);
                        if (pubkey) {
                            this.pending.delete(message.id);
                            if (!this.desired.has(pubkey)) {
                                socket.send(JSON.stringify({ jsonrpc: "2.0", id: this.requestId++, method: "accountUnsubscribe", params: [message.result] }));
                                return;
                            }
                            this.serverSubscriptions.set(message.result, pubkey);
                        }
                        return;
                    }
                    if (message.method !== "accountNotification")
                        return;
                    const params = message.params as {
                        subscription?: number;
                        result?: {
                            context?: {
                                slot?: number;
                            };
                            value?: {
                                lamports?: number;
                                owner?: string;
                                data?: [
                                    string,
                                    string
                                ] | string;
                            };
                        };
                    } | undefined;
                    const serverId = params?.subscription;
                    if (typeof serverId !== "number")
                        return;
                    const pubkey = this.serverSubscriptions.get(serverId);
                    if (!pubkey)
                        return;
                    const value = params?.result?.value;
                    const encoded = Array.isArray(value?.data)
                        ? value?.data[0]
                        : typeof value?.data === "string"
                            ? value.data
                            : undefined;
                    if (!encoded)
                        return;
                    const handler = this.desired.get(pubkey)?.handler;
                    if (!handler)
                        return;
                    await handler({
                        pubkey,
                        generation,
                        owner: value?.owner,
                        slot: params?.result?.context?.slot ?? 0,
                        dataBase64: encoded,
                        lamports: value?.lamports,
                    });
                }
                catch (error) {
                    this.health("account_update_error", { error: String(error) });
                    logger.warn({ error }, "failed to process Solana account update");
                }
            });
        });
        socket.on("error", (error) => {
            this.health("solana_socket_error", { error: String(error) });
            logger.warn({ error }, "Solana websocket error");
        });
        socket.on("close", (code, reason) => {
            if (this.heartbeat)
                clearInterval(this.heartbeat);
            this.health("solana_disconnected", { code });
            logger.warn({ code, reason: reason.toString() }, "Solana websocket closed");
            if (!this.stopped)
                this.scheduleReconnect();
        });
    }
    private sendSubscribe(pubkey: string): void {
        if (this.stopped || this.socket?.readyState !== WebSocket.OPEN)
            return;
        const id = this.requestId++;
        this.pending.set(id, pubkey);
        setTimeout(() => {
            if (this.pending.delete(id) && this.desired.has(pubkey)) {
                this.health("subscription_ack_timeout", { pubkey });
                this.socket?.terminate();
            }
        }, 15000).unref();
        this.socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "accountSubscribe",
            params: [
                pubkey,
                {
                    encoding: "base64",
                    commitment: "confirmed",
                },
            ],
        }));
    }
    private scheduleReconnect(): void {
        const exponential = config.reconnectMinMs * Math.pow(2, this.reconnectAttempt++);
        const delay = Math.min(exponential, config.reconnectMaxMs);
        logger.info({ delay }, "scheduling Solana websocket reconnect");
        setTimeout(() => this.connect(), delay);
    }
}
