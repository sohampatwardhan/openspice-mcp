import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { liveChildren } from "../src/children.js";
import { ToolError } from "../src/errors.js";
import { parse } from "../src/netlist.js";
import { Roots } from "../src/paths.js";
import { analysisFromNetlist, buildRunDeck, runSimulation } from "../src/runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "..", "..", "test", "fixtures", "fake-ngspice.mjs");
const realBin = "/usr/bin/ngspice";
const hasReal = existsSync(realBin);

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "openspice-runner-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

function rootsIn(): Roots {
  return new Roots([tmp]);
}

describe("analysisFromNetlist", () => {
  it("extracts a .tran analysis command", () => {
    const n = parse("rc\nV1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end\n");
    assert.equal(analysisFromNetlist(n)?.command, "tran 1u 1m");
  });

  it("extracts an .op analysis command", () => {
    const n = parse("t\nV1 in 0 1\nR1 in 0 1k\n.op\n.end\n");
    assert.equal(analysisFromNetlist(n)?.command, "op");
  });

  it("returns null when there is no analysis directive", () => {
    const n = parse("t\nV1 in 0 1\nR1 in 0 1k\n.end\n");
    assert.equal(analysisFromNetlist(n), null);
  });
});

describe("buildRunDeck", () => {
  it("wraps a plain run in a control block that writes the raw", () => {
    const n = parse("rc\nV1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end\n");
    const deck = buildRunDeck(n, { rawName: "out.raw", sweeps: [] });
    assert.match(deck, /\.control/);
    assert.match(deck, /\brun\b|\btran\b/);
    assert.match(deck, /write out\.raw/);
    // The native analysis directive is removed; the control block drives it.
    assert.doesNotMatch(deck, /^\.tran/m);
  });

  it("emits a stepped control loop when a .step is present", () => {
    const n = parse("div\nV1 in 0 1\nR1 in out 1k\nR2 out 0 1k\n.step param r list 1k 2k\n.op\n.end\n");
    const sweeps = [{ param: "r", device: "R1", values: ["1k", "2k"] }];
    const deck = buildRunDeck(n, { rawName: "out.raw", sweeps });
    assert.match(deck, /foreach/);
    assert.match(deck, /set appendwrite/);
    // The native .step directive is removed.
    assert.doesNotMatch(deck, /^\.step/m);
  });
});

describe("runSimulation (fake ngspice)", () => {
  it("runs a netlist and returns the parsed raw and log", async () => {
    const n = parse("rc\nV1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end\n");
    const result = await runSimulation(n, {
      roots: rootsIn(),
      ngspiceBin: fakeBin,
      timeoutMs: 15_000,
    });
    assert.equal(result.status, "ok");
    assert.ok(result.raw);
    assert.ok(result.rawPath && existsSync(result.rawPath));
    assert.ok(result.logPath && existsSync(result.logPath));
    assert.equal(liveChildren(), 0);
  });

  it("classifies a nonzero exit as SIM_FAILED", async () => {
    const n = parse("rc\nV1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end\n");
    await assert.rejects(
      runSimulation(n, {
        roots: rootsIn(),
        ngspiceBin: fakeBin,
        timeoutMs: 15_000,
        extraEnv: { FAKE_NGSPICE_EXIT: "1" },
      }),
      (err: unknown) => err instanceof ToolError && err.code === "SIM_FAILED",
    );
    assert.equal(liveChildren(), 0);
  });

  it("classifies a hung run as SIM_TIMEOUT and leaves no child running", async () => {
    const n = parse("rc\nV1 in 0 1\nR1 in 0 1k\n.tran 1u 1m\n.end\n");
    await assert.rejects(
      runSimulation(n, {
        roots: rootsIn(),
        ngspiceBin: fakeBin,
        timeoutMs: 300,
        extraEnv: { FAKE_NGSPICE_HANG: "1" },
      }),
      (err: unknown) => err instanceof ToolError && err.code === "SIM_TIMEOUT",
    );
    // Give stopAll a moment, then assert nothing lingers.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(liveChildren(), 0);
  });
});

describe("runSimulation (real ngspice 44.2)", { skip: !hasReal }, () => {
  it("runs a real transient under lt compatibility mode", async () => {
    const n = parse("rc\nV1 in 0 PULSE(0 1 0 1n 1n 1m 2m)\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 2m\n.end\n");
    const result = await runSimulation(n, { roots: rootsIn(), ngspiceBin: realBin, timeoutMs: 30_000 });
    assert.equal(result.status, "ok");
    assert.ok(result.raw && result.raw.pointCount > 10);
    // v(out) is an RC charge: bounded in [0, 1).
    const vout = result.raw.values("v(out)");
    assert.ok(Math.max(...vout) > 0 && Math.max(...vout) < 1);
    // lt mode must have actually engaged.
    const log = readFileSync(result.logPath, "utf8");
    assert.match(log, /Compatibility modes selected:\s*lt/);
    assert.equal(liveChildren(), 0);
  });

  it("emulates a .step resistor sweep into a stepped result", async () => {
    const n = parse("div\nV1 in 0 1\nR1 in out 1k\nR2 out 0 1k\n.step param rl list 1k 2k 4k\n.op\n.end\n");
    const result = await runSimulation(n, { roots: rootsIn(), ngspiceBin: realBin, timeoutMs: 30_000, stepDevice: { rl: "R1" } });
    assert.equal(result.status, "ok");
    assert.ok(result.stepped && result.stepped.count === 3);
    const vout = result.stepped.perStep.map((raw) => raw.values("v(out)")[0] ?? NaN);
    // Divider: 0.5, 1/3, 0.2 for rl = 1k, 2k, 4k.
    assert.ok(Math.abs((vout[0] ?? 0) - 0.5) < 1e-3);
    assert.ok(Math.abs((vout[1] ?? 0) - 1 / 3) < 1e-3);
    assert.ok(Math.abs((vout[2] ?? 0) - 0.2) < 1e-3);
    assert.equal(liveChildren(), 0);
  });

  it("runs a .meas and parses the measurement from the log", async () => {
    const n = parse(
      "rc\nV1 in 0 PULSE(0 1 0 1n 1n 1m 2m)\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 2m\n.meas tran vmax MAX v(out)\n.end\n",
    );
    const result = await runSimulation(n, { roots: rootsIn(), ngspiceBin: realBin, timeoutMs: 30_000 });
    assert.equal(result.status, "ok");
    assert.ok(result.measurements.some((m) => m.name === "vmax" && m.value > 0.5 && m.value < 0.7));
    assert.equal(liveChildren(), 0);
  });
});
