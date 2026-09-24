export interface PoolQuote {
    pool: string;
    base: number; // token base units; do not assume mint decimals
    quoteSol: number;
    at: number;
    slot: number;
    generation?: number;
}
export function buyQuote(q: PoolQuote, stakeSol: number) {
    const tokens = q.base * stakeSol / (q.quoteSol + stakeSol);
    const spotTokens = stakeSol * q.base / q.quoteSol;
    return { tokens, impactPct: (1 - tokens / spotTokens) * 100 };
}
export function sellQuote(q: PoolQuote, tokens: number) {
    return q.quoteSol * tokens / (q.base + tokens);
}
