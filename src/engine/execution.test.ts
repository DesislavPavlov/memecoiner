import test from "node:test";
import assert from "node:assert/strict";
import { buyQuote, sellQuote } from "./execution.js";
import { DipSetup } from "./dip.js";
test("AMM buy cannot buy more than available tokens and sell cannot exceed reserves", () => {
    const q = { pool: "p", base: 1000, quoteSol: .05, at: 1, slot: 1 };
    const fill = buyQuote(q, .25);
    assert.ok(fill.tokens < 1000);
    assert.ok(fill.impactPct > 80);
    assert.ok(sellQuote(q, fill.tokens) < .05);
});
test("ordered peak-trough-recovery and irreversible collapse rejection", () => {
    const d = new DipSetup(8, 40);
    d.update(100, 1);
    d.update(110, 2);
    assert.equal(d.phase, "peak");
    d.update(98, 3);
    assert.equal(d.phase, "dip");
    d.update(102, 4);
    assert.equal(d.phase, "recovery");
    assert.equal(d.peakAt, 2);
    assert.equal(d.troughAt, 3);
    d.update(20, 5);
    d.update(100, 6);
    assert.equal(d.phase, "rejected");
});
