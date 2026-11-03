import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addMeas, addStep, parameterize } from "../src/edits.js";
import { parse } from "../src/netlist.js";

const RC = ["rc divider", "V1 in 0 1", "R1 in out 1k", "C1 out 0 1u", ".tran 1u 1m", ".end", ""].join("\n");

describe("addMeas", () => {
  it("inserts a new .meas directive before .end and never simulates", () => {
    const r = addMeas(RC, { analysis: "tran", name: "vfinal", expr: "FIND v(out) AT=1m" });
    assert.equal(r.diagnostic, null);
    assert.equal(r.changed, true);
    assert.match(r.text, /\.meas tran vfinal FIND v\(out\) AT=1m/);
    // The directive sits before .end.
    assert.ok(r.text.indexOf(".meas") < r.text.lastIndexOf(".end"));
    // It still parses.
    const n = parse(r.text);
    assert.ok(n.directives.some((d) => d.kind === ".meas"));
  });

  it("updates an existing .meas with the same name in place", () => {
    const first = addMeas(RC, { analysis: "tran", name: "vfinal", expr: "FIND v(out) AT=1m" });
    const second = addMeas(first.text, { analysis: "tran", name: "vfinal", expr: "MAX v(out)" });
    assert.equal(second.changed, true);
    assert.match(second.text, /\.meas tran vfinal MAX v\(out\)/);
    assert.doesNotMatch(second.text, /FIND v\(out\)/);
    // Exactly one .meas vfinal remains.
    const count = (second.text.match(/\.meas tran vfinal/g) ?? []).length;
    assert.equal(count, 1);
  });
});

describe("addStep", () => {
  it("adds a .param default and a .step list for a new parameter", () => {
    const r = addStep(RC, { param: "rl", values: ["1k", "2k", "3k"], default: "1k" });
    assert.equal(r.diagnostic, null);
    assert.equal(r.changed, true);
    assert.match(r.text, /\.param rl=1k/);
    assert.match(r.text, /\.step param rl list 1k 2k 3k/);
  });

  it("updates an existing .step for the same parameter", () => {
    const first = addStep(RC, { param: "rl", values: ["1k", "2k"], default: "1k" });
    const second = addStep(first.text, { param: "rl", values: ["5k", "6k"], default: "5k" });
    assert.match(second.text, /\.step param rl list 5k 6k/);
    assert.doesNotMatch(second.text, /list 1k 2k/);
    assert.equal((second.text.match(/\.step param rl/g) ?? []).length, 1);
  });

  it("returns a diagnostic and leaves the text unchanged when values are empty", () => {
    const r = addStep(RC, { param: "rl", values: [], default: "1k" });
    assert.ok(r.diagnostic !== null);
    assert.equal(r.changed, false);
    assert.equal(r.text, RC);
  });
});

describe("parameterize", () => {
  it("replaces a device value with a {name} reference and adds a .param default", () => {
    const r = parameterize(RC, { device: "R1", name: "rval" });
    assert.equal(r.diagnostic, null);
    assert.equal(r.changed, true);
    assert.match(r.text, /R1 in out \{rval\}/);
    assert.match(r.text, /\.param rval=1k/);
  });

  it("returns a diagnostic and does not alter the text for an absent device", () => {
    const r = parameterize(RC, { device: "R9", name: "rval" });
    assert.ok(r.diagnostic !== null);
    assert.match(r.diagnostic ?? "", /R9/);
    assert.equal(r.changed, false);
    assert.equal(r.text, RC);
  });

  it("returns a diagnostic for a device that has no scalar value (model-based)", () => {
    const withQ = ["bjt", "Q1 c b 0 2N2222", ".model 2N2222 NPN", ".op", ".end", ""].join("\n");
    const r = parameterize(withQ, { device: "Q1", name: "qp" });
    assert.ok(r.diagnostic !== null);
    assert.equal(r.changed, false);
  });
});
