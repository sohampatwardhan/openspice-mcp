import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { ToolError } from "../src/errors.js";
import { exportWaveforms, parseMeas, rawInfo, readRaw, summarize } from "../src/raw.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "..", "test", "fixtures", "raw");
function fixture(name: string): Buffer {
  return readFileSync(join(fixtures, name));
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "openspice-raw-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("readRaw ngspice binary transient", () => {
  const raw = readRaw(fixture("test_tran_bin.raw"));

  it("detects the format, flags, and variables", () => {
    assert.equal(raw.format, "ngspice-binary");
    assert.equal(raw.complex, false);
    assert.equal(raw.pointCount, 67);
    assert.deepEqual(
      raw.variables.map((v) => v.name),
      ["time", "v(in)", "v(out)", "i(v1)"],
    );
    assert.equal(raw.variables[0]?.kind, "time");
    assert.equal(raw.variables[1]?.kind, "voltage");
  });

  it("exposes real sample values for a variable", () => {
    const vin = raw.values("v(in)");
    assert.equal(vin.length, 67);
    assert.equal(vin[0], 0);
    assert.ok(vin.some((x) => x > 0));
  });

  it("summarizes min/max/final and downsamples", () => {
    const sum = summarize(raw, ["v(out)"], 10);
    const out = sum.variables[0];
    assert.equal(out?.name, "v(out)");
    assert.ok(out && out.max >= out.min);
    assert.ok(out && out.samples.length <= 10);
    assert.equal(sum.pointCount, 67);
  });
});

describe("readRaw ngspice ascii transient", () => {
  const raw = readRaw(fixture("test_tran_ascii.raw"));

  it("parses the same shape as the binary file", () => {
    assert.equal(raw.format, "ngspice-ascii");
    assert.equal(raw.pointCount, 67);
    assert.equal(raw.variables.length, 4);
  });

  it("matches the binary file's values within tolerance", () => {
    const bin = readRaw(fixture("test_tran_bin.raw"));
    const a = bin.values("v(out)");
    const b = raw.values("v(out)");
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.ok(Math.abs((a[i] ?? 0) - (b[i] ?? 0)) < 1e-9, `point ${i}`);
    }
  });
});

describe("readRaw ngspice ac complex", () => {
  const raw = readRaw(fixture("test_ac_bin.raw"));

  it("detects complex data and point count", () => {
    assert.equal(raw.complex, true);
    assert.equal(raw.pointCount, 3);
  });

  it("returns magnitude and phase alongside real/imag", () => {
    const sum = summarize(raw, ["v(out)"], 10);
    const out = sum.variables[0];
    assert.ok(out?.complexSamples);
    const first = out?.complexSamples?.[0];
    assert.ok(first);
    assert.equal(typeof first.magnitude, "number");
    assert.equal(typeof first.phase, "number");
    // magnitude == hypot(re, im)
    assert.ok(Math.abs(first.magnitude - Math.hypot(first.re, first.im)) < 1e-12);
  });
});

describe("readRaw LTspice-style binary", () => {
  const raw = readRaw(fixture("test_ltspice_bin.raw"));

  it("detects the LTspice format and mixed-width traces", () => {
    assert.equal(raw.format, "ltspice-binary");
    assert.equal(raw.pointCount, 4);
    assert.deepEqual(
      raw.variables.map((v) => v.name),
      ["time", "V(out)", "I(R1)"],
    );
  });

  it("reads the float64 time axis and float32 traces", () => {
    const t = raw.values("time");
    assert.deepEqual(t, [0, 1e-9, 2e-9, 3e-9]);
    const vout = raw.values("V(out)");
    assert.ok(Math.abs((vout[2] ?? 0) - 0.5) < 1e-6);
  });
});

describe("rawInfo", () => {
  it("returns metadata only, without sample arrays", () => {
    const raw = readRaw(fixture("test_tran_bin.raw"));
    const info = rawInfo(raw);
    assert.equal(info.format, "ngspice-binary");
    assert.equal(info.pointCount, 67);
    assert.equal(info.complex, false);
    assert.equal(info.variables.length, 4);
    assert.ok(!("samples" in (info.variables[0] as object)));
  });
});

describe("exportWaveforms", () => {
  it("writes a CSV with a header row and one row per point", () => {
    const raw = readRaw(fixture("test_tran_bin.raw"));
    const path = join(tmp, "out.csv");
    const res = exportWaveforms(raw, ["time", "v(out)"], path, "csv");
    assert.equal(res.path, path);
    const text = readFileSync(path, "utf8");
    const lines = text.trim().split("\n");
    assert.equal(lines[0], "time,v(out)");
    assert.equal(lines.length, 68); // header + 67 points
  });
});

describe("parseMeas", () => {
  it("parses ngspice .meas name/value pairs from a log", () => {
    const log = ["Doing analysis...", "vmax = 1.234560e+00", "trise=2.5e-09 targ= 1 trig= 2", "irrelevant line"].join("\n");
    const meas = parseMeas(log);
    const byName = Object.fromEntries(meas.map((m) => [m.name, m.value]));
    assert.ok(Math.abs((byName.vmax ?? 0) - 1.23456) < 1e-6);
    assert.ok(Math.abs((byName.trise ?? 0) - 2.5e-9) < 1e-18);
  });

  it("parses the real ngspice meas format with a trailing at= field", () => {
    const log = ["vmax                =  7.564548e-01 at=  3.631465e-04", "vmin                =  -7.074454e-01 at=  1.875147e-03"].join("\n");
    const meas = parseMeas(log);
    const byName = Object.fromEntries(meas.map((m) => [m.name, m.value]));
    assert.ok(Math.abs((byName.vmax ?? 0) - 0.7564548) < 1e-6);
    assert.ok(Math.abs((byName.vmin ?? 0) + 0.7074454) < 1e-6);
  });

  it("ignores ngspice memory/statistics lines that look like name = number", () => {
    // These appear in every batch-mode ngspice log and must not be reported as measurements.
    const log = [
      "Stack = 0 bytes.",
      "Shared ngspice pages = 10.660 MB.",
      "Library pages = 1.988 MB.",
      "Maximum ngspice program size =   21.668 MB.",
      "Current ngspice program size =   12.555 MB.",
      "No. of Data Rows : 41",
      "vmax = 1.0e+00",
    ].join("\n");
    const meas = parseMeas(log);
    const names = meas.map((m) => m.name);
    assert.deepEqual(names, ["vmax"], `expected only vmax, got ${JSON.stringify(names)}`);
  });
});

describe("readRaw failures", () => {
  it("throws RAW_PARSE_FAILED on an unknown header", () => {
    assert.throws(() => readRaw(Buffer.from("not a rawfile at all")), (e: unknown) => e instanceof ToolError && e.code === "RAW_PARSE_FAILED");
  });

  it("throws RAW_PARSE_FAILED on a truncated binary payload", () => {
    const bytes = fixture("test_tran_bin.raw");
    const idx = bytes.indexOf(Buffer.from("Binary:\n"));
    const truncated = bytes.subarray(0, idx + "Binary:\n".length + 16);
    assert.throws(() => readRaw(truncated), (e: unknown) => e instanceof ToolError && e.code === "RAW_PARSE_FAILED");
  });
});
