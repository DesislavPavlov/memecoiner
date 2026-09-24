import bs58 from "bs58";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
export const PUMP_AMM_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export interface PumpSwapPool {
    address: string;
    index: number;
    creator: string;
    unsupportedMode: boolean;
    virtualQuoteReserves?: bigint;
    baseMint: string;
    quoteMint: string;
    baseVault: string;
    quoteVault: string;
}
export function decodePumpSwapPool(address: string, dataBase64: string): PumpSwapPool {
    const data = Buffer.from(dataBase64, "base64");
    if (data.length < 203) {
        throw new Error(`PumpSwap pool account too short: ${data.length}`);
    }
    if (!data.subarray(0, 8).equals(createHash("sha256").update("account:Pool").digest().subarray(0, 8)))
        throw new Error("Invalid pool discriminator");
    // Anchor discriminator: 0..7
    // pool_bump: 8
    // index u16: 9..10
    // creator: 11..42
    // base_mint: 43..74
    // quote_mint: 75..106
    // lp_mint: 107..138
    // pool_base_token_account: 139..170
    // pool_quote_token_account: 171..202
    if (data.length > 245 && data.length < 261) throw new Error("Truncated virtual quote reserves");
    const virtualQuoteReserves = data.length >= 261
        ? BigInt.asIntN(128, data.readBigUInt64LE(245) | (data.readBigUInt64LE(253) << 64n)) : 0n;
    return {
        address,
        index: data.readUInt16LE(9),
        creator: bs58.encode(data.subarray(11, 43)),
        // Virtual reserves are supported by pricing against real + virtual quote reserves.
        unsupportedMode: (data[243] ?? 0) !== 0 || (data[244] ?? 0) !== 0,
        virtualQuoteReserves,
        baseMint: bs58.encode(data.subarray(43, 75)),
        quoteMint: bs58.encode(data.subarray(75, 107)),
        baseVault: bs58.encode(data.subarray(139, 171)),
        quoteVault: bs58.encode(data.subarray(171, 203)),
    };
}
export function decodeSplTokenAmount(dataBase64: string): bigint {
    const data = Buffer.from(dataBase64, "base64");
    if (data.length < 72) {
        throw new Error(`Token account too short: ${data.length}`);
    }
    return data.readBigUInt64LE(64);
}
// Solana PDA derivation uses SHA-256 plus Ed25519 point rejection; no signing/RPC SDK needed.
// Algorithm reference: solana-labs/solana-web3.js maintenance/v1.x/src/publickey.ts.
function programAddress(seeds: Uint8Array[], program: string): Buffer {
    const programBytes = bs58.decode(program);
    if (programBytes.length !== 32 || seeds.some(seed => seed.length > 32))
        throw new Error("Invalid PDA seeds");
    for (let bump = 255; bump > 0; bump--) {
        const hash = createHash("sha256").update(Buffer.concat([...seeds, Buffer.from([bump]), programBytes, Buffer.from("ProgramDerivedAddress")])).digest();
        try {
            ed25519.ExtendedPoint.fromHex(hash);
        }
        catch {
            return hash;
        }
    }
    throw new Error("No valid PDA bump");
}
export function canonicalPoolAddress(mint: string): {
    address: string;
    creator: string;
} {
    const base = bs58.decode(mint);
    if (base.length !== 32)
        throw new Error("Invalid mint");
    const creator = programAddress([Buffer.from("pool-authority"), base], "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    const pool = programAddress([Buffer.from("pool"), Buffer.from([0, 0]), creator, base, bs58.decode(WRAPPED_SOL_MINT)], PUMP_AMM_PROGRAM_ID);
    return { address: bs58.encode(pool), creator: bs58.encode(creator) };
}
export function validateVault(dataBase64: string, mint: string, authority: string): bigint {
    const data = Buffer.from(dataBase64, "base64");
    if (data.length < 165 || bs58.encode(data.subarray(0, 32)) !== mint || bs58.encode(data.subarray(32, 64)) !== authority || data[108] !== 1)
        throw new Error("Invalid/uninitialized pool vault");
    return decodeSplTokenAmount(dataBase64);
}
