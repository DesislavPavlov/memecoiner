import bs58 from "bs58";

export const PUMP_AMM_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";

export interface PumpSwapPool {
  address: string;
  index: number;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
}

export function decodePumpSwapPool(
  address: string,
  dataBase64: string,
): PumpSwapPool {
  const data = Buffer.from(dataBase64, "base64");
  if (data.length < 203) {
    throw new Error(`PumpSwap pool account too short: ${data.length}`);
  }

  // Anchor discriminator: 0..7
  // pool_bump: 8
  // index u16: 9..10
  // creator: 11..42
  // base_mint: 43..74
  // quote_mint: 75..106
  // lp_mint: 107..138
  // pool_base_token_account: 139..170
  // pool_quote_token_account: 171..202
  return {
    address,
    index: data.readUInt16LE(9),
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
