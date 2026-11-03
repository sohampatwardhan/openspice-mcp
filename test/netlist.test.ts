import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emit, parse, validate } from "../src/netlist.js";

describe("netlist parse", () => {
  it("captures the title line from the first line", () => {
    const n = parse("My Amplifier\nR1 in out 1k\n.end\n");
    assert.equal(n.title, "My Amplifier");
    assert.equal(n.devices.length, 1);
  });

  it("parses a two-terminal resistor with value", () => {
    const n = parse("t\nR1 n1 n2 4.7k\n");
    const r = n.devices[0];
    assert.equal(r?.kind, "R");
    assert.equal(r?.name, "R1");
    assert.deepEqual(r?.nodes, ["n1", "n2"]);
    assert.equal(r?.value, "4.7k");
  });

  it("parses a voltage source with a function value", () => {
    const n = parse("t\nV1 in 0 SIN(0 1 1k)\n");
    const v = n.devices[0];
    assert.equal(v?.kind, "V");
    assert.deepEqual(v?.nodes, ["in", "0"]);
    assert.equal(v?.value, "SIN(0 1 1k)");
  });

  it("parses a three-terminal BJT referencing a model", () => {
    const n = parse("t\nQ1 c b e NPN1\n");
    const q = n.devices[0];
    assert.equal(q?.kind, "Q");
    assert.deepEqual(q?.nodes, ["c", "b", "e"]);
    assert.equal(q?.model, "NPN1");
  });

  it("parses a four-terminal MOSFET with model and params", () => {
    const n = parse("t\nM1 d g s b NMOS L=1u W=10u\n");
    const m = n.devices[0];
    assert.equal(m?.kind, "M");
    assert.deepEqual(m?.nodes, ["d", "g", "s", "b"]);
    assert.equal(m?.model, "NMOS");
    assert.equal(m?.params.L, "1u");
    assert.equal(m?.params.W, "10u");
  });

  it("parses a subcircuit instance (X) and a .subckt definition", () => {
    const text = ["t", "X1 in out mid opamp", ".subckt opamp 1 2 3", "R1 1 2 1k", ".ends", ""].join("\n");
    const n = parse(text);
    const x = n.devices.find((d) => d.kind === "X");
    assert.equal(x?.name, "X1");
    assert.deepEqual(x?.nodes, ["in", "out", "mid"]);
    assert.equal(x?.model, "opamp");
    assert.equal(n.subckts.length, 1);
    assert.equal(n.subckts[0]?.name, "opamp");
    assert.deepEqual(n.subckts[0]?.ports, ["1", "2", "3"]);
    // Devices inside a .subckt are not part of the top-level device list.
    assert.ok(!n.devices.some((d) => d.name === "R1"));
  });

  it("collects models, directives, and includes", () => {
    const text = [
      "t",
      ".model NMOS NMOS (level=1)",
      ".tran 1n 1m",
      ".ac dec 10 1 1meg",
      ".include sub.cir",
      ".lib mylib.lib tt",
      ".param gain=2",
      ".step param gain 1 3 1",
      ".meas tran vmax MAX V(out)",
      ".end",
      "",
    ].join("\n");
    const n = parse(text);
    assert.equal(n.models[0]?.name, "NMOS");
    assert.equal(n.models[0]?.type, "NMOS");
    const kinds = n.directives.map((d) => d.kind);
    assert.ok(kinds.includes(".tran"));
    assert.ok(kinds.includes(".ac"));
    assert.ok(kinds.includes(".param"));
    assert.ok(kinds.includes(".step"));
    assert.ok(kinds.includes(".meas"));
    assert.deepEqual(
      n.includes.map((i) => i.path),
      ["sub.cir", "mylib.lib"],
    );
  });

  it("joins continuation lines beginning with +", () => {
    const n = parse("t\nM1 d g s b NMOS L=1u\n+ W=10u AD=1p\n");
    const m = n.devices[0];
    assert.equal(m?.params.W, "10u");
    assert.equal(m?.params.AD, "1p");
  });

  it("treats * lines and ; trailing text as comments", () => {
    const n = parse("t\n* a comment\nR1 a b 1k ; inline comment\n");
    assert.equal(n.devices.length, 1);
    assert.equal(n.devices[0]?.value, "1k");
  });

  it("records a diagnostic with 1-based line number for an unparseable line and continues", () => {
    const n = parse("t\n?garbage\nR1 a b 1k\n");
    assert.equal(n.devices.length, 1);
    const diag = n.diagnostics.find((d) => d.line === 2);
    assert.ok(diag);
    assert.match(diag.text, /garbage/);
  });

  it("is case-insensitive for device letters and directives", () => {
    const n = parse("t\nr1 a b 1k\n.TRAN 1n 1m\n");
    assert.equal(n.devices[0]?.kind, "R");
    assert.ok(n.directives.some((d) => d.kind === ".tran"));
  });
});

describe("netlist validate", () => {
  it("flags the absence of a ground node", () => {
    const n = parse("t\nR1 a b 1k\nR2 b c 1k\n");
    const issues = validate(n);
    assert.ok(issues.some((i) => i.rule === "no-ground"));
  });

  it("flags a node connected to only one device", () => {
    const n = parse("t\nV1 in 0 1\nR1 in out 1k\n");
    const issues = validate(n);
    const single = issues.filter((i) => i.rule === "single-connection");
    assert.ok(single.some((i) => i.message.includes("out")));
  });

  it("flags duplicate instance names", () => {
    const n = parse("t\nV1 in 0 1\nR1 in 0 1k\nR1 in 0 2k\n");
    const issues = validate(n);
    assert.ok(issues.some((i) => i.rule === "duplicate-name" && i.message.includes("R1")));
  });

  it("flags a device referencing a missing model", () => {
    const n = parse("t\nV1 in 0 1\nM1 in in 0 0 NMOS\n");
    const issues = validate(n);
    assert.ok(issues.some((i) => i.rule === "missing-model" && i.message.includes("NMOS")));
  });

  it("flags an X instance referencing a missing subcircuit", () => {
    const n = parse("t\nV1 in 0 1\nX1 in 0 missing\n");
    const issues = validate(n);
    assert.ok(issues.some((i) => i.rule === "missing-subckt" && i.message.includes("missing")));
  });

  it("passes a well-formed circuit with ground and known model", () => {
    const text = ["t", "V1 in 0 1", "R1 in out 1k", "R2 out 0 1k", ""].join("\n");
    const n = parse(text);
    const issues = validate(n);
    assert.ok(!issues.some((i) => i.severity === "error"));
    assert.ok(!issues.some((i) => i.rule === "no-ground"));
  });
});

describe("netlist emit", () => {
  it("round-trips a simple netlist's devices", () => {
    const text = ["My ckt", "V1 in 0 SIN(0 1 1k)", "R1 in out 1k", "M1 d g s b NMOS L=1u W=10u", ".tran 1n 1m", ".end"].join("\n");
    const n = parse(text);
    const out = emit(n);
    const back = parse(out);
    assert.equal(back.devices.length, n.devices.length);
    assert.equal(back.devices[0]?.value, "SIN(0 1 1k)");
    const m = back.devices.find((d) => d.name === "M1");
    assert.equal(m?.params.W, "10u");
    assert.ok(back.directives.some((d) => d.kind === ".tran"));
  });
});
