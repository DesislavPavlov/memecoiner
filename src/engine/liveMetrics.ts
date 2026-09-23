import type { NormalizedMarketEvent } from "../types/market.js";

type Side = "buy" | "sell";

interface TradeSample {
  ts: number;
  side: Side;
  sol: number;
  priceRatio?: number;
}

interface TokenLiveState {
  mint: string;
  firstSeenAt: number;
  lastSeenAt: number;
  migratedAt?: number;
  symbol?: string;
  name?: string;
  marketCapSol?: number;
  bondingCurveKey?: string;
  postMigrationLive?: boolean;
  trades: TradeSample[];
}

export interface WindowMetrics {
  buys: number;
  sells: number;
  buySol: number;
  sellSol: number;
  buySellVolumeRatio: number | null;
  priceChangePct: number | null;
}

export interface StrategyAssessment {
  status: string;
  score?: number;
  reasons: string[];
}

export interface TokenDashboardRow {
  mint: string;
  symbol?: string;
  name?: string;
  ageSeconds: number;
  migrated: boolean;
  postMigrationLive: boolean;
  marketCapSol?: number;
  lastPriceRatio?: number;
  w10: WindowMetrics;
  w30: WindowMetrics;
  w60: WindowMetrics;
  hybrid: StrategyAssessment;
  migration: StrategyAssessment;
}

export interface PaperBotSummary {
  id: "hybrid" | "migration";
  name: string;
  startingBalanceSol: number;
  balanceSol: number;
  realizedPnlSol: number;
  openPositions: number;
  closedTrades: number;
  mode: "paper";
  status: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  trackedTokens: number;
  rows: TokenDashboardRow[];
  bots: PaperBotSummary[];
  recentEvents: string[];
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function emptyWindow(): WindowMetrics {
  return {
    buys: 0,
    sells: 0,
    buySol: 0,
    sellSol: 0,
    buySellVolumeRatio: null,
    priceChangePct: null,
  };
}

export class LiveMetricsEngine {
  private readonly tokens = new Map<string, TokenLiveState>();
  private readonly recentEvents: string[] = [];
  private readonly startingBalanceSol: number;

  constructor(startingBalanceSol = 10) {
    this.startingBalanceSol = startingBalanceSol;
  }

  ingest(event: NormalizedMarketEvent): void {
    if (!event.mint) return;

    const now = Date.parse(event.receivedAt) || Date.now();
    const existing = this.tokens.get(event.mint);
    const token: TokenLiveState =
      existing ??
      {
        mint: event.mint,
        firstSeenAt: now,
        lastSeenAt: now,
        trades: [],
      };

    token.lastSeenAt = now;
    token.symbol = event.symbol ?? token.symbol;
    token.name = event.name ?? token.name;
    token.marketCapSol = event.marketCapSol ?? token.marketCapSol;
    token.bondingCurveKey = event.bondingCurveKey ?? token.bondingCurveKey;

    if (event.kind === "new_token" && !existing) {
      this.pushEvent(`NEW ${token.symbol ?? shortMint(token.mint)}`);
    }

    if (event.kind === "migration") {
      token.migratedAt = now;
      this.pushEvent(`MIGRATION ${token.symbol ?? shortMint(token.mint)}`);
    }

    if (event.kind === "trade" && event.txType?.startsWith("inferred_")) {
      if (event.txType.startsWith("inferred_swap_")) {
        token.postMigrationLive = true;
      }
      const side = event.txType.endsWith("buy") ? "buy" : "sell";
      const lamports = finiteNumber(event.raw.solDeltaLamports);
      const sol = lamports !== undefined ? lamports / 1_000_000_000 : 0;

      const vSol = event.virtualSolReserves;
      const vToken = event.virtualTokenReserves;
      const priceRatio =
        vSol !== undefined &&
        vToken !== undefined &&
        Number.isFinite(vSol) &&
        Number.isFinite(vToken) &&
        vToken > 0
          ? vSol / vToken
          : undefined;

      token.trades.push({ ts: now, side, sol, priceRatio });
      this.pushEvent(
        `${side.toUpperCase()} ${token.symbol ?? shortMint(token.mint)} ${sol.toFixed(4)} SOL`,
      );
    }

    const cutoff = Date.now() - 5 * 60_000;
    if (token.trades.length > 0) {
      token.trades = token.trades.filter((trade) => trade.ts >= cutoff);
    }

    this.tokens.set(event.mint, token);
    this.pruneTokens();
  }

  rowForMint(mint: string): TokenDashboardRow | undefined {
    const token = this.tokens.get(mint);
    return token ? this.toRow(token, Date.now()) : undefined;
  }

  snapshot(
    limit = 80,
    bots?: PaperBotSummary[],
    extraEvents: string[] = [],
  ): DashboardSnapshot {
    const now = Date.now();
    const rows = [...this.tokens.values()]
      .map((token) => this.toRow(token, now))
      .sort((a, b) => {
        const aActivity = a.w60.buySol + a.w60.sellSol;
        const bActivity = b.w60.buySol + b.w60.sellSol;
        return bActivity - aActivity || a.ageSeconds - b.ageSeconds;
      })
      .slice(0, limit);

    return {
      generatedAt: new Date(now).toISOString(),
      trackedTokens: this.tokens.size,
      rows,
      bots:
        bots ??
        [
          {
            id: "hybrid",
            name: "Hybrid Runner + Migration",
            startingBalanceSol: this.startingBalanceSol,
            balanceSol: this.startingBalanceSol,
            realizedPnlSol: 0,
            openPositions: 0,
            closedTrades: 0,
            mode: "paper",
            status: "SCORING / WATCHING",
          },
          {
            id: "migration",
            name: "Pure Migration Dip",
            startingBalanceSol: this.startingBalanceSol,
            balanceSol: this.startingBalanceSol,
            realizedPnlSol: 0,
            openPositions: 0,
            closedTrades: 0,
            mode: "paper",
            status: "WAITING FOR MIGRATIONS",
          },
        ],
      recentEvents: [...extraEvents, ...this.recentEvents].slice(0, 60),
    };
  }

  private toRow(token: TokenLiveState, now: number): TokenDashboardRow {
    const w10 = this.window(token, now, 10_000);
    const w30 = this.window(token, now, 30_000);
    const w60 = this.window(token, now, 60_000);
    const ageSeconds = Math.max(0, Math.floor((now - token.firstSeenAt) / 1000));
    const lastPriceRatio = [...token.trades]
      .reverse()
      .find((trade) => trade.priceRatio !== undefined)?.priceRatio;

    return {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      ageSeconds,
      migrated: token.migratedAt !== undefined,
      postMigrationLive: token.postMigrationLive === true,
      marketCapSol: token.marketCapSol,
      lastPriceRatio,
      w10,
      w30,
      w60,
      hybrid: this.assessHybrid(
        ageSeconds,
        token.migratedAt !== undefined,
        token.postMigrationLive === true,
        w10,
        w30,
        w60,
      ),
      migration: this.assessMigration(
        token.migratedAt !== undefined,
        token.postMigrationLive === true,
      ),
    };
  }

  private window(
    token: TokenLiveState,
    now: number,
    windowMs: number,
  ): WindowMetrics {
    const trades = token.trades.filter((trade) => trade.ts >= now - windowMs);
    if (trades.length === 0) return emptyWindow();

    let buys = 0;
    let sells = 0;
    let buySol = 0;
    let sellSol = 0;

    for (const trade of trades) {
      if (trade.side === "buy") {
        buys += 1;
        buySol += trade.sol;
      } else {
        sells += 1;
        sellSol += trade.sol;
      }
    }

    const prices = trades
      .map((trade) => trade.priceRatio)
      .filter((value): value is number => value !== undefined && value > 0);

    const priceChangePct =
      prices.length >= 2
        ? ((prices[prices.length - 1]! / prices[0]!) - 1) * 100
        : null;

    return {
      buys,
      sells,
      buySol,
      sellSol,
      // Keep API output JSON-safe. 99 means "buys present, zero sell volume"
      // and is effectively infinite for our scoring thresholds.
      buySellVolumeRatio:
        sellSol > 0 ? buySol / sellSol : buySol > 0 ? 99 : null,
      priceChangePct,
    };
  }

  private assessHybrid(
    ageSeconds: number,
    migrated: boolean,
    postMigrationLive: boolean,
    w10: WindowMetrics,
    w30: WindowMetrics,
    w60: WindowMetrics,
  ): StrategyAssessment {
    if (migrated) {
      return {
        status: postMigrationLive ? "PUMPSWAP LIVE" : "WAIT PUMPSWAP DATA",
        reasons: postMigrationLive
          ? ["Migration detected", "Free PumpSwap vault stream is live"]
          : ["Migration detected", "Waiting for canonical PumpSwap pool discovery"],
      };
    }

    let score = 0;
    const reasons: string[] = [];

    if (ageSeconds <= 180) {
      score += 20;
      reasons.push("Age <= 3m");
    } else {
      reasons.push("Older than 3m");
    }

    const ratio = w60.buySellVolumeRatio;
    if (ratio !== null && ratio >= 1.5) {
      score += 20;
      reasons.push("Strong buy/sell volume");
    } else if (ratio !== null && ratio >= 1.1) {
      score += 10;
      reasons.push("Positive buy/sell volume");
    } else {
      reasons.push("Buy pressure not strong");
    }

    if (w60.buySol >= 1) {
      score += 20;
      reasons.push(">= 1 SOL buy volume / 60s");
    } else if (w60.buySol >= 0.25) {
      score += 10;
      reasons.push("Some buy volume");
    } else {
      reasons.push("Low buy volume");
    }

    const tradeCount = w60.buys + w60.sells;
    if (tradeCount >= 10) {
      score += 15;
      reasons.push("Active tape");
    } else if (tradeCount >= 4) {
      score += 8;
      reasons.push("Moderate tape");
    } else {
      reasons.push("Thin tape");
    }

    if (w30.priceChangePct !== null && w30.priceChangePct > 0) {
      score += 15;
      reasons.push("30s momentum positive");
    } else if (w30.priceChangePct !== null) {
      reasons.push("30s momentum not positive");
    }

    if (hasConstructiveRecentFlow(w10)) {
      score += 10;
      reasons.push("Recent flow still constructive");
    }

    return {
      status: score >= 75 ? "PRIME WATCH" : score >= 55 ? "WATCH" : "IGNORE",
      score,
      reasons,
    };
  }

  private assessMigration(
    migrated: boolean,
    postMigrationLive: boolean,
  ): StrategyAssessment {
    return migrated
      ? {
          status: postMigrationLive ? "PUMPSWAP LIVE" : "WAIT PUMPSWAP DATA",
          reasons: postMigrationLive
            ? ["Migration detected", "Free post-migration flow is active"]
            : ["Migration detected", "Waiting for canonical PumpSwap pool discovery"],
        }
      : {
          status: "WAIT MIGRATION",
          reasons: ["Pure strategy intentionally ignores pre-migration scoring"],
        };
  }

  private pushEvent(message: string): void {
    const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    this.recentEvents.unshift(`${stamp}  ${message}`);
    if (this.recentEvents.length > 40) this.recentEvents.length = 40;
  }

  private pruneTokens(): void {
    const cutoff = Date.now() - 20 * 60_000;
    for (const [mint, token] of this.tokens) {
      if (token.lastSeenAt < cutoff) this.tokens.delete(mint);
    }
  }
}

function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 5)}…${mint.slice(-4)}` : mint;
}

function hasConstructiveRecentFlow(w10: WindowMetrics): boolean {
  return (
    w10.buySellVolumeRatio !== null &&
    w10.buySellVolumeRatio >= 1.2 &&
    w10.buys > 0
  );
}
