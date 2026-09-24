import { config } from "../config.js";
import { canonicalPoolAddress, decodePumpSwapPool, validateVault, PUMP_AMM_PROGRAM_ID, WRAPPED_SOL_MINT, type PumpSwapPool } from "./pumpSwapPool.js";
import type { HealthSink } from "../logging/health.js";
interface Account {
    owner: string;
    data: [
        string,
        string
    ];
}
export interface PoolSnapshot {
    base: bigint;
    quote: bigint;
    slot: number;
}
export class SolanaRpcClient {
    private id = 1;
    private tail: Promise<unknown> = Promise.resolve();
    constructor(private readonly health: HealthSink = () => { }) { }
    async findCanonicalPumpSwapPool(baseMint: string): Promise<PumpSwapPool | null> {
        const expected = canonicalPoolAddress(baseMint);
        const result = await this.call<{
            value: Account | null;
        }>("getAccountInfo", [expected.address, { commitment: "confirmed", encoding: "base64" }]);
        if (!result.value)
            return null;
        if (result.value.owner !== PUMP_AMM_PROGRAM_ID)
            throw new Error("Pool owner mismatch");
        const pool = decodePumpSwapPool(expected.address, result.value.data[0]);
        if (pool.index !== 0 || pool.creator !== expected.creator || pool.baseMint !== baseMint || pool.quoteMint !== WRAPPED_SOL_MINT || pool.unsupportedMode)
            throw new Error("Unsupported or invalid canonical pool");
        return pool;
    }
    async getPoolSnapshot(pool: PumpSwapPool, minContextSlot = 0): Promise<PoolSnapshot> {
        const result = await this.call<{
            context: {
                slot: number;
            };
            value: (Account | null)[];
        }>("getMultipleAccounts", [
            [pool.baseVault, pool.quoteVault], { commitment: "confirmed", encoding: "base64", ...(minContextSlot ? { minContextSlot } : {}) }
        ]);
        const [base, quote] = result.value;
        const owners = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
        if (!base || !quote || !owners.includes(base.owner) || !owners.includes(quote.owner))
            throw new Error("Missing/invalid vault owners");
        if (result.context.slot < minContextSlot)
            throw new Error("Stale RPC context");
        return { base: validateVault(base.data[0], pool.baseMint, pool.address), quote: validateVault(quote.data[0], pool.quoteMint, pool.address), slot: result.context.slot };
    }
    private call<T>(method: string, params: unknown[]): Promise<T> {
        // Bound concurrency and rate for the free endpoint. Every request has a timeout.
        const next = this.tail.then(async () => {
            await new Promise(resolve => setTimeout(resolve, 150));
            try {
                const response = await fetch(config.solanaRpcUrl, { method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }), signal: AbortSignal.timeout(config.rpcTimeoutMs) });
                if (!response.ok)
                    throw new Error(`HTTP ${response.status}`);
                const body = await response.json() as {
                    result?: T;
                    error?: {
                        code: number;
                        message: string;
                    };
                };
                if (body.error || body.result === undefined)
                    throw new Error(body.error ? `RPC ${body.error.code}` : "Missing RPC result");
                return body.result;
            }
            catch (error) {
                this.health("rpc_failure", { method, error: String(error) });
                throw error;
            }
        });
        this.tail = next.catch(() => { });
        return next;
    }
}
