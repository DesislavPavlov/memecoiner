import { config } from "../config.js";
import {
  decodePumpSwapPool,
  decodeSplTokenAmount,
  PUMP_AMM_PROGRAM_ID,
  WRAPPED_SOL_MINT,
  type PumpSwapPool,
} from "./pumpSwapPool.js";

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

interface ProgramAccountResult {
  pubkey: string;
  account: {
    data: [string, string] | string;
  };
}

interface AccountInfoResult {
  value: Array<
    | null
    | {
        data: [string, string] | string;
      }
  >;
}

export class SolanaRpcClient {
  private id = 1;

  async findCanonicalPumpSwapPool(baseMint: string): Promise<PumpSwapPool | null> {
    const rows = await this.call<ProgramAccountResult[]>("getProgramAccounts", [
      PUMP_AMM_PROGRAM_ID,
      {
        commitment: "processed",
        encoding: "base64",
        filters: [{ memcmp: { offset: 43, bytes: baseMint } }],
      },
    ]);

    for (const row of rows) {
      const encoded = Array.isArray(row.account.data)
        ? row.account.data[0]
        : row.account.data;
      const pool = decodePumpSwapPool(row.pubkey, encoded);

      if (
        pool.index === 0 &&
        pool.baseMint === baseMint &&
        pool.quoteMint === WRAPPED_SOL_MINT
      ) {
        return pool;
      }
    }

    return null;
  }

  async getTokenAccountAmounts(pubkeys: string[]): Promise<bigint[]> {
    const result = await this.call<AccountInfoResult>("getMultipleAccounts", [
      pubkeys,
      { commitment: "processed", encoding: "base64" },
    ]);

    return result.value.map((account, index) => {
      if (!account) {
        throw new Error(`Missing token account ${pubkeys[index] ?? index}`);
      }
      const encoded = Array.isArray(account.data) ? account.data[0] : account.data;
      return decodeSplTokenAmount(encoded);
    });
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetch(config.solanaRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.id++,
        method,
        params,
      }),
    });

    if (!response.ok) {
      throw new Error(`Solana RPC HTTP ${response.status}`);
    }

    const body = (await response.json()) as RpcEnvelope<T>;
    if (body.error) {
      throw new Error(
        `Solana RPC ${body.error.code ?? "error"}: ${body.error.message ?? "unknown"}`,
      );
    }
    if (body.result === undefined) {
      throw new Error(`Solana RPC ${method} returned no result`);
    }

    return body.result;
  }
}
