import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { JsonlEventStore } from "./eventStore.js";
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
    positionId?: string;
    runId?: string;
    eventId?: string;
    quoteSlot?: number;
    quoteSol?: number;
    tokenBaseUnits?: number;
    signalAt?: string;
    executionModel?: string;
}
export class PaperJournal {
    private readonly store: JsonlEventStore;
    private readonly seen = new Set<string>();
    private readonly ready: Promise<void>;
    constructor(path: string) { this.store = new JsonlEventStore(path); this.ready = this.loadIds(path); }
    private async loadIds(path: string): Promise<void> {
        let files: string[];
        try {
            files = await readdir(dirname(path));
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return;
            throw error;
        }
        for (const file of files.filter(f => f === basename(path) || f.startsWith(basename(path) + "."))) {
            const input = createReadStream(join(dirname(path), file));
            for await (const line of createInterface({ input: file.endsWith(".gz") ? input.pipe(createGunzip()) : input, crlfDelay: Infinity })) {
                if (!line.trim())
                    continue;
                const e = JSON.parse(line);
                if (e.positionId)
                    this.seen.add(e.positionId + ":" + e.action);
            }
        }
    }
    async append(entry: PaperJournalEntry): Promise<void> {
        await this.ready;
        const key = entry.positionId ? entry.positionId + ":" + entry.action : undefined;
        if (key && this.seen.has(key))
            return;
        await this.store.append(entry);
        if (key)
            this.seen.add(key);
    }
    flush(): Promise<void> { return this.store.flush(); }
}
