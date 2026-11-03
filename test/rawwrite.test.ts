import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readRaw } from "../src/raw.js";
import { writeLtspiceRaw } from "../src/rawwrite.js";

/** Build a small real-transient RawFile-like object from in-repo arrays. */
function ngspiceTransient(): Buffer {
  // Header for an ngspice Berkeley binary real transient, float64 payload.
  const header =
    "Title: rc\n" +
    "Date: Tue Nov  3 00:00:00 2026\n" +
    "Plotname: Transient Analysis\n" +
    "Flags: real\n" +
    "No. Variables: 3\n" +
    "No. Points: 4\n" +
    "Variables:\n" +
    "\t0\ttime\ttime\n" +
    "\t1\tv(out)\tvoltage\n" +
    "\t2\ti(v1)\tcurrent\n" +
    "Binary:\n";
  const points = [
    [0, 0, 0],
    [1e-6, 0.25, -2.5e-4],
    [2e-6, 0.5, -5.0e-4],
    [3e-6, 0.75, -7.5e-4],
  ];
  const payload = Buffer.alloc(points.length * 3 * 8);
  let off = 0;
  for (const p of points) {
    for (const v of p) {
      payload.writeDoubleLE(v, off);
      off += 8;
    }
  }
  return Buffer.concat([Buffer.from(header, "utf8"), payload]);
}

describe("writeLtspiceRaw", () => {
  it("writes a UTF-16LE header LTspice-style raw that our reader round-trips", () => {
    const raw = readRaw(ngspiceTransient());
    const out = writeLtspiceRaw(raw);
    assert.equal(out.verified, true);
    assert.ok(out.bytes.length > 0);

    // The header is UTF-16LE (BOM 0xFF 0xFE) with the LTspice conventions.
    assert.equal(out.bytes[0], 0xff);
    assert.equal(out.bytes[1], 0xfe);
    const head = out.bytes.subarray(0, out.bytes.indexOf(Buffer.from("Binary:", "utf16le"))).toString("utf16le");
    assert.match(head, /Flags:.*\breal\b/);

    // Re-reading the written bytes reproduces the variables, point count, and values.
    const back = readRaw(out.bytes);
    assert.equal(back.format, "ltspice-binary");
    assert.equal(back.pointCount, 4);
    assert.deepEqual(
      back.variables.map((v) => v.name),
      ["time", "v(out)", "i(v1)"],
    );
    const time = back.values("time");
    assert.ok(Math.abs((time[3] ?? 0) - 3e-6) < 1e-12);
    const vout = back.values("v(out)");
    // v(out) is stored float32; compare within float32 precision.
    assert.ok(Math.abs((vout[2] ?? 0) - 0.5) < 1e-5);
  });

  it("reports the uncertain field tags it relied on", () => {
    const raw = readRaw(ngspiceTransient());
    const out = writeLtspiceRaw(raw);
    assert.ok(Array.isArray(out.uncertain) && out.uncertain.length > 0);
  });

  it("writes and round-trips a complex (.ac) run as float64 pairs", () => {
    const header =
      "Title: ac\nDate: x\nPlotname: AC Analysis\nFlags: complex\nNo. Variables: 2\nNo. Points: 2\nVariables:\n\t0\tfrequency\tfrequency\n\t1\tv(out)\tvoltage\nBinary:\n";
    const p = Buffer.alloc(2 * 2 * 16);
    p.writeDoubleLE(1, 0);
    p.writeDoubleLE(0, 8);
    p.writeDoubleLE(0.5, 16);
    p.writeDoubleLE(-0.25, 24);
    p.writeDoubleLE(10, 32);
    p.writeDoubleLE(0, 40);
    p.writeDoubleLE(0.25, 48);
    p.writeDoubleLE(-0.5, 56);
    const raw = readRaw(Buffer.concat([Buffer.from(header, "utf8"), p]));
    const out = writeLtspiceRaw(raw);
    assert.equal(out.verified, true);
    const back = readRaw(out.bytes);
    assert.equal(back.complex, true);
    const v = back.complexValues("v(out)")[1];
    assert.ok(v && Math.abs(v.re - 0.25) < 1e-12 && Math.abs(v.im + 0.5) < 1e-12);
  });

  it("never throws and returns a well-formed result; a decline carries a diagnostic", () => {
    const raw = readRaw(ngspiceTransient());
    const out = writeLtspiceRaw(raw);
    // Invariant: verified implies no diagnostic, a decline implies a diagnostic.
    if (out.verified) {
      assert.equal(out.diagnostic, null);
      assert.ok(out.bytes.length > 0);
    } else {
      assert.ok(out.diagnostic && out.diagnostic.length > 0);
    }
  });
});
