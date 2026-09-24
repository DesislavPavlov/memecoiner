import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { JsonlEventStore } from "./eventStore.js";
test("concurrent append order survives rotation and gzip compression", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memecoin-log-"));
    try {
        const path = join(dir, "events.jsonl"), store = new JsonlEventStore(path, 90);
        await Promise.all(Array.from({ length: 20 }, (_, n) => store.append({ n, data: "payload" })));
        await store.flush();
        const all = [];
        for (const file of await readdir(dir)) {
            const b = await readFile(join(dir, file));
            const text = file.endsWith(".gz") ? gunzipSync(b).toString() : b.toString();
            const chunk = text.trim().split("\n").map(x => JSON.parse(x).n);
            assert.deepEqual(chunk, [...chunk].sort((a, b) => a - b));
            all.push(...chunk);
        }
        assert.deepEqual(all.sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i));
        assert.ok((await readdir(dir)).some(f => f.endsWith(".gz")));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
