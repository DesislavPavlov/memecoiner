import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NormalizedMarketEvent } from "../types/market.js";

export class JsonlEventStore {
  private ready: Promise<void>;

  constructor(private readonly path: string) {
    this.ready = mkdir(dirname(path), { recursive: true }).then(() => undefined);
  }

  async append(event: NormalizedMarketEvent): Promise<void> {
    await this.ready;
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}
