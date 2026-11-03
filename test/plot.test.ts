import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { readRaw } from "../src/raw.js";
import { renderPlot } from "../src/plot.js";

const tmp = mkdtempSync(join(tmpdir(), "openspice-plot-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A tiny real transient rawfile: time + v(out), two points. */
function tinyRaw(): ReturnType<typeof readRaw> {
  const header =
    "Title: * plot\n" +
    "Date: now\n" +
    "Plotname: Transient Analysis\n" +
    "Flags: real\n" +
    "No. Variables: 2\n" +
    "No. Points: 3\n" +
    "Variables:\n" +
    "\t0\ttime\ttime\n" +
    "\t1\tv(out)\tvoltage\n" +
    "Binary:\n";
  const payload = Buffer.alloc(3 * 2 * 8);
  const pts = [
    [0, 0],
    [1e-6, 0.5],
    [2e-6, 1.0],
  ];
  let off = 0;
  for (const [t, v] of pts) {
    payload.writeDoubleLE(t as number, off);
    payload.writeDoubleLE(v as number, off + 8);
    off += 16;
  }
  return readRaw(Buffer.concat([Buffer.from(header, "utf8"), payload]));
}

describe("renderPlot", () => {
  it("writes an SVG when plotting is enabled", () => {
    const raw = tinyRaw();
    const out = join(tmp, "plot.svg");
    const result = renderPlot(raw, ["v(out)"], out, { allowPlots: true });
    assert.equal(result.written, true);
    assert.equal(result.path, out);
    assert.equal(result.diagnostic, null);
    assert.ok(existsSync(out));
    const svg = readFileSync(out, "utf8");
    assert.match(svg, /<svg/);
    assert.match(svg, /<polyline/);
    assert.match(svg, /v\(out\)/);
  });

  it("returns a diagnostic and writes nothing when plotting is disabled", () => {
    const raw = tinyRaw();
    const out = join(tmp, "disabled.svg");
    const result = renderPlot(raw, ["v(out)"], out, { allowPlots: false });
    assert.equal(result.written, false);
    assert.equal(result.path, null);
    assert.ok(result.diagnostic && /plotting is disabled/i.test(result.diagnostic));
    assert.equal(existsSync(out), false);
  });

  it("reports a diagnostic for a complex (.ac) raw rather than plotting magnitude silently", () => {
    const raw = tinyRaw();
    const out = join(tmp, "unknown-var.svg");
    const result = renderPlot(raw, ["v(nope)"], out, { allowPlots: true });
    assert.equal(result.written, false);
    assert.ok(result.diagnostic && /v\(nope\)/.test(result.diagnostic));
  });
});
