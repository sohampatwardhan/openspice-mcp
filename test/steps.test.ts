import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parse } from "../src/netlist.js";
import { buildControlBlock, parseStepDirectives, splitRawSections } from "../src/steps.js";

describe("parseStepDirectives", () => {
  it("parses a .step param list sweep", () => {
    const n = parse("t\nR1 in out {r}\n.step param r list 1k 2k 4k\n.op\n.end\n");
    const steps = parseStepDirectives(n);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.param, "r");
    assert.deepEqual(steps[0]?.values, ["1k", "2k", "4k"]);
  });

  it("parses a .step param linear sweep (start stop step)", () => {
    const n = parse("t\nR1 in out {r}\n.step param r 1k 3k 1k\n.op\n.end\n");
    const steps = parseStepDirectives(n);
    // Linear sweeps expand to plain numeric tokens ngspice accepts.
    assert.deepEqual(steps[0]?.values, ["1000", "2000", "3000"]);
  });

  it("returns no steps for a netlist without .step", () => {
    const n = parse("t\nR1 in 0 1k\n.op\n.end\n");
    assert.deepEqual(parseStepDirectives(n), []);
  });
});

describe("buildControlBlock", () => {
  it("emits a foreach loop with alter, run, and appendwrite", () => {
    const block = buildControlBlock(
      { param: "r", device: "R1", values: ["1k", "2k"] },
      { analysis: "op", rawName: "stepped.raw" },
    );
    assert.match(block, /\.control/);
    assert.match(block, /set appendwrite/);
    assert.match(block, /foreach/);
    assert.match(block, /alter R1/);
    assert.match(block, /write stepped\.raw/);
    assert.match(block, /\.endc/);
  });
});

describe("splitRawSections", () => {
  it("splits a concatenated multi-section rawfile into one buffer per step", () => {
    const section = (title: string) =>
      Buffer.concat([
        Buffer.from(
          `Title: ${title}\nPlotname: Operating Point\nFlags: real\nNo. Variables: 1\nNo. Points: 1\nVariables:\n\t0\tv(out)\tvoltage\nBinary:\n`,
          "latin1",
        ),
        (() => {
          const b = Buffer.alloc(8);
          b.writeDoubleLE(0.5, 0);
          return b;
        })(),
      ]);
    const combined = Buffer.concat([section("a"), section("b"), section("c")]);
    const parts = splitRawSections(combined);
    assert.equal(parts.length, 3);
    for (const part of parts) {
      assert.ok(part.toString("latin1").startsWith("Title:"));
      assert.ok(part.includes(Buffer.from("Binary:\n", "latin1")));
    }
  });

  it("returns a single section for a plain rawfile", () => {
    const one = Buffer.from(
      "Title: x\nFlags: real\nNo. Variables: 1\nNo. Points: 1\nVariables:\n\t0\tv(out)\tvoltage\nBinary:\n",
      "latin1",
    );
    const payload = Buffer.alloc(8);
    const parts = splitRawSections(Buffer.concat([one, payload]));
    assert.equal(parts.length, 1);
  });
});
