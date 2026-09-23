import { config } from "../config.js";
import type {
  PaperBotSummary,
  TokenDashboardRow,
} from "./liveMetrics.js";
import type { NormalizedMarketEvent } from "../types/market.js";
import { PaperJournal } from "../logging/paperJournal.js";

type BotId = "hybrid" | "migration";

interface Position {
  mint: string;
  symbol?: string;
  entryAt: number;
  entryPrice: number;
  lastPrice: number;
  stakeSol: number;
  entryFeeSol: number;
  peakReturnPct: number;
  entryReasons: string[];
}

interface BotLedger {
  id: BotId;
  name: string;
  cashSol: number;
  realizedPnlSol: number;
  closedTrades: number;
  open?: Position;
  tradedMints: Set<string>;
}

interface MigrationTrack {
  migratedAt: number;
  preHybridScore: number;
  high?: number;
  low?: number;
  postTrades: number;
}

export class PaperTradingEngine {
  private readonly ledgers: Record<BotId, BotLedger>;
  private readonly migrations = new Map<string, MigrationTrack>();
  private readonly recent: string[] = [];

  constructor(
    startingBalanceSol: number,
    private readonly journal: PaperJournal,
  ) {
    this.ledgers = {
      hybrid: {
        id: "hybrid",
        name: "Hybrid Runner + Migration",
        cashSol: startingBalanceSol,
        realizedPnlSol: 0,
        closedTrades: 0,
        tradedMints: new Set(),
      },
      migration: {
        id: "migration",
        name: "Pure Migration Dip",
        cashSol: startingBalanceSol,
        realizedPnlSol: 0,
        closedTrades: 0,
        tradedMints: new Set(),
      },
    };
  }

  async ingest(
    event: NormalizedMarketEvent,
    before: TokenDashboardRow | undefined,
    after: TokenDashboardRow | undefined,
  ): Promise<void> {
    if (!event.mint) return;
    const now = Date.parse(event.receivedAt) || Date.now();

    if (event.kind === "migration") {
      this.migrations.set(event.mint, {
        migratedAt: now,
        preHybridScore: before?.hybrid.score ?? 0,
        postTrades: 0,
      });
      this.push(
        `MIGRATION SETUP ${after?.symbol ?? shortMint(event.mint)} · hybrid pre-score ${before?.hybrid.score ?? 0}`,
      );
      return;
    }

    if (
      event.kind !== "trade" ||
      !event.txType?.startsWith("inferred_swap_") ||
      !after?.lastPriceRatio ||
      after.lastPriceRatio <= 0
    ) {
      return;
    }

    const track = this.migrations.get(event.mint);
    if (!track) return;

    const price = after.lastPriceRatio;
    track.postTrades += 1;
    track.high = track.high === undefined ? price : Math.max(track.high, price);
    track.low = track.low === undefined ? price : Math.min(track.low, price);

    await this.manageOpenPosition("hybrid", after, price, now);
    await this.manageOpenPosition("migration", after, price, now);

    if (!this.ledgers.hybrid.open) {
      await this.maybeEnterHybrid(after, track, price, now);
    }
    if (!this.ledgers.migration.open) {
      await this.maybeEnterMigration(after, track, price, now);
    }
  }

  summaries(): PaperBotSummary[] {
    return [
      this.summary(this.ledgers.hybrid),
      this.summary(this.ledgers.migration),
    ];
  }

  recentEvents(): string[] {
    return [...this.recent];
  }

  private summary(bot: BotLedger): PaperBotSummary {
    const markedPosition = bot.open
      ? bot.open.stakeSol * (bot.open.lastPrice / bot.open.entryPrice)
      : 0;

    return {
      id: bot.id,
      name: bot.name,
      startingBalanceSol: config.paperStartingBalanceSol,
      balanceSol: bot.cashSol + markedPosition,
      realizedPnlSol: bot.realizedPnlSol,
      openPositions: bot.open ? 1 : 0,
      closedTrades: bot.closedTrades,
      mode: "paper",
      status: bot.open
        ? `OPEN ${bot.open.symbol ?? shortMint(bot.open.mint)}`
        : "SCANNING",
    };
  }

  private async maybeEnterMigration(
    row: TokenDashboardRow,
    track: MigrationTrack,
    price: number,
    now: number,
  ): Promise<void> {
    const bot = this.ledgers.migration;
    if (bot.tradedMints.has(row.mint)) return;

    const setup = setupMetrics(track, price, now);
    if (
      setup.secondsSinceMigration > config.paperMigrationEntryWindowSec ||
      setup.dipPct > -config.paperMigrationMinDipPct ||
      setup.recoveryPct < config.paperMigrationRecoveryPct ||
      track.postTrades < 3
    ) {
      return;
    }

    const ratio = row.w10.buySellVolumeRatio ?? 0;
    if (ratio < 1.05 || row.w10.buys < 1) return;

    await this.enter(bot, row, price, [
      `Migration dip ${setup.dipPct.toFixed(1)}%`,
      `Recovery from low +${setup.recoveryPct.toFixed(1)}%`,
      `10s buy/sell volume ratio ${ratio.toFixed(2)}`,
      "Pure migration strategy: no pre-migration score required",
    ], now);
  }

  private async maybeEnterHybrid(
    row: TokenDashboardRow,
    track: MigrationTrack,
    price: number,
    now: number,
  ): Promise<void> {
    const bot = this.ledgers.hybrid;
    if (bot.tradedMints.has(row.mint)) return;
    if (track.preHybridScore < config.paperHybridMinScore) return;

    const setup = setupMetrics(track, price, now);
    if (
      setup.secondsSinceMigration > config.paperMigrationEntryWindowSec ||
      setup.dipPct > -config.paperMigrationMinDipPct ||
      setup.recoveryPct < config.paperHybridRecoveryPct ||
      track.postTrades < 3
    ) {
      return;
    }

    const ratio = row.w10.buySellVolumeRatio ?? 0;
    if (ratio < 1.2 || row.w10.buys < 1) return;

    await this.enter(bot, row, price, [
      `Pre-migration Hybrid score ${track.preHybridScore}`,
      `Migration dip ${setup.dipPct.toFixed(1)}%`,
      `Recovery from low +${setup.recoveryPct.toFixed(1)}%`,
      `10s buy/sell volume ratio ${ratio.toFixed(2)}`,
    ], now);
  }

  private async enter(
    bot: BotLedger,
    row: TokenDashboardRow,
    price: number,
    reasons: string[],
    now: number,
  ): Promise<void> {
    const stake = Math.min(config.paperPositionSol, bot.cashSol);
    const fee = stake * (config.paperFeePctPerSide / 100);
    if (stake <= 0 || bot.cashSol < stake + fee) return;

    bot.cashSol -= stake + fee;
    bot.tradedMints.add(row.mint);
    bot.open = {
      mint: row.mint,
      symbol: row.symbol,
      entryAt: now,
      entryPrice: price,
      lastPrice: price,
      stakeSol: stake,
      entryFeeSol: fee,
      peakReturnPct: 0,
      entryReasons: reasons,
    };

    this.push(
      `${bot.id.toUpperCase()} PAPER BUY ${row.symbol ?? shortMint(row.mint)} · ${stake.toFixed(3)} SOL`,
    );

    await this.journal.append({
      ts: new Date(now).toISOString(),
      bot: bot.id,
      action: "ENTRY",
      mint: row.mint,
      symbol: row.symbol,
      priceRatio: price,
      stakeSol: stake,
      feeSol: fee,
      balanceAfterSol: bot.cashSol,
      reasons,
    });
  }

  private async manageOpenPosition(
    botId: BotId,
    row: TokenDashboardRow,
    price: number,
    now: number,
  ): Promise<void> {
    const bot = this.ledgers[botId];
    const pos = bot.open;
    if (!pos || pos.mint !== row.mint) return;

    pos.lastPrice = price;
    const returnPct = (price / pos.entryPrice - 1) * 100;
    pos.peakReturnPct = Math.max(pos.peakReturnPct, returnPct);
    const heldSec = (now - pos.entryAt) / 1000;

    let reason: string | undefined;

    if (botId === "migration") {
      if (returnPct >= 100) reason = "2x target reached";
      else if (returnPct <= -15) reason = "15% stop";
      else if (heldSec >= 120) reason = "120s scalp timeout";
    } else {
      const flowRatio = row.w10.buySellVolumeRatio ?? 0;
      if (returnPct >= 100) reason = "2x hard target reached";
      else if (returnPct <= -10) reason = "10% hybrid stop";
      else if (
        pos.peakReturnPct >= 25 &&
        returnPct <= pos.peakReturnPct * 0.65
      ) {
        reason = "35% giveback from >=25% peak";
      } else if (returnPct >= 5 && flowRatio < 0.8 && row.w10.sells > 0) {
        reason = "profitable + 10s order-flow reversal";
      } else if (heldSec >= 180) {
        reason = "180s hybrid timeout";
      }
    }

    if (reason) {
      await this.exit(bot, row, price, returnPct, reason, now);
    }
  }

  private async exit(
    bot: BotLedger,
    row: TokenDashboardRow,
    price: number,
    grossReturnPct: number,
    exitReason: string,
    now: number,
  ): Promise<void> {
    const pos = bot.open;
    if (!pos) return;

    const grossProceeds = pos.stakeSol * (price / pos.entryPrice);
    const exitFee = grossProceeds * (config.paperFeePctPerSide / 100);
    const netProceeds = grossProceeds - exitFee;
    const pnl =
      netProceeds - pos.stakeSol - pos.entryFeeSol;
    const pnlPct = (pnl / (pos.stakeSol + pos.entryFeeSol)) * 100;

    bot.cashSol += netProceeds;
    bot.realizedPnlSol += pnl;
    bot.closedTrades += 1;
    bot.open = undefined;

    const reasons = [
      exitReason,
      `Gross move ${grossReturnPct >= 0 ? "+" : ""}${grossReturnPct.toFixed(1)}%`,
      `Net paper P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL`,
    ];

    this.push(
      `${bot.id.toUpperCase()} PAPER SELL ${row.symbol ?? shortMint(row.mint)} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL · ${exitReason}`,
    );

    await this.journal.append({
      ts: new Date(now).toISOString(),
      bot: bot.id,
      action: "EXIT",
      mint: row.mint,
      symbol: row.symbol,
      priceRatio: price,
      stakeSol: pos.stakeSol,
      feeSol: exitFee,
      balanceAfterSol: bot.cashSol,
      reasons,
      pnlSol: pnl,
      pnlPct,
    });
  }

  private push(message: string): void {
    const stamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
    this.recent.unshift(`${stamp}  ${message}`);
    if (this.recent.length > 40) this.recent.length = 40;
  }
}

function setupMetrics(
  track: MigrationTrack,
  price: number,
  now: number,
): {
  dipPct: number;
  recoveryPct: number;
  secondsSinceMigration: number;
} {
  const high = track.high ?? price;
  const low = track.low ?? price;
  return {
    dipPct: (low / high - 1) * 100,
    recoveryPct: (price / low - 1) * 100,
    secondsSinceMigration: (now - track.migratedAt) / 1000,
  };
}

function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 5)}…${mint.slice(-4)}` : mint;
}
