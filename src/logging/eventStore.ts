import { appendFile, mkdir, stat, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
/** Single ordered writer; rotation never requires loading a large file in memory. */
export class JsonlEventStore {
    private tail: Promise<void> = Promise.resolve();
    private size?: number;
    constructor(private readonly path: string, private readonly maxBytes = config.logRotateBytes) { }
    append(event: unknown): Promise<void> {
        const line = JSON.stringify(event) + "\n";
        const next = this.tail.then(async () => {
            await mkdir(dirname(this.path), { recursive: true });
            if (this.size === undefined) {
                try {
                    this.size = (await stat(this.path)).size;
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                        throw error;
                    this.size = 0;
                }
            }
            if (this.size > 0 && this.size + Buffer.byteLength(line) > this.maxBytes) {
                const archive = `${this.path}.${Date.now()}-${randomUUID()}`;
                await rename(this.path, archive);
                // Keep uncompressed archive on compression failure; never discard raw evidence.
                await pipeline(createReadStream(archive), createGzip(), createWriteStream(archive + ".gz"));
                await unlink(archive);
                this.size = 0;
            }
            await appendFile(this.path, line, "utf8");
            this.size += Buffer.byteLength(line);
        });
        this.tail = next; // Fail closed after a disk error.
        return next;
    }
    flush(): Promise<void> { return this.tail; }
}
