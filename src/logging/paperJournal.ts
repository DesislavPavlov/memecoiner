import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface PaperJournalEntry {
  ts: string;
  bot: "hybrid" | "migration";
  action: "ENTRY" | "EXIT";
  mint: string;
  symbol?: string;
  priceRatio: number;
  stakeSol: number;
  feeSol: number;
  balanceAfterSol: number;
  reasons: string[];
  pnlSol?: number;
  pnlPct?: number;
}

export class PaperJournal {
  private readonly ready: Promise<void>;

  constructor(private readonly path: string) {
    this.ready = mkdir(dirname(path), { recursive: true }).then(() => undefined);
  }

  async append(entry: PaperJournalEntry): Promise<void> {
    await this.ready;
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
