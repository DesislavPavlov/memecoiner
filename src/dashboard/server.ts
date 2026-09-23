import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { LiveMetricsEngine } from "../engine/liveMetrics.js";
import { logger } from "../logging/logger.js";

export class DashboardServer {
  constructor(
    private readonly metrics: LiveMetricsEngine,
    private readonly port: number,
  ) {}

  start(): void {
    const publicDir = join(process.cwd(), "src", "dashboard", "public");

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

      if (url.pathname === "/api/state") {
        const body = JSON.stringify(this.metrics.snapshot());
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        createReadStream(join(publicDir, "index.html")).pipe(res);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    });

    server.listen(this.port, "127.0.0.1", () => {
      logger.info(
        { url: `http://127.0.0.1:${this.port}` },
        "paper dashboard ready",
      );
    });
  }
}
