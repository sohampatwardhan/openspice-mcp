/**
 * `.step` emulation and stepped-raw assembly (Requirement 6.3, 7.3). ngspice has
 * no native `.step` (verified against ngspice 44.2: a `.step` directive fails
 * with `unimplemented dot command '.step'` even under lt mode; see
 * docs/compatibility.md). This module expands an LTspice `.step` into an ngspice
 * `.control` loop (`foreach` over the step values, `alter` the swept device or
 * parameter, `run`/analysis, `write` with `set appendwrite`), and splits the
 * resulting file of concatenated rawfile sections back into one section per step
 * so the reader can key results by step index.
 */

import { readRaw, type RawFile } from "./raw.js";
import type { Directive, Netlist } from "./netlist.js";

/** A single `.step` sweep expanded into the concrete values it visits. */
export interface StepSweep {
  /** The swept name: a `.param` name, or a device name for a device sweep. */
  param: string;
  /** Concrete values visited, in order, as written tokens (e.g. `1k`). */
  values: string[];
  /** 1-based source line of the `.step` directive. */
  line: number;
}

/** What the control loop alters each iteration, and the analysis it runs. */
export interface ControlPlan {
  /** The ngspice analysis command run per step (`op`, `tran 1u 1m`, `ac dec 10 1 1meg`, ...). */
  analysis: string;
  /** Where the loop writes the appended stepped rawfile (a bare filename in the run dir). */
  rawName: string;
}

/** A sweep bound to the concrete device/param the control loop will `alter`/`let`. */
export interface BoundSweep {
  param: string;
  /** Device instance name when the sweep targets a device value, else null. */
  device: string | null;
  values: string[];
}

/** SI suffixes LTspice/ngspice accept on numeric tokens, for linear-sweep expansion. */
const SI: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};

/** Parse a SPICE numeric token (with an optional SI suffix) to a number, or null. */
export function parseSiNumber(token: string): number | null {
  const m = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)(t|g|meg|k|m|u|n|p|f)?/i.exec(token.trim());
  if (!m) return null;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  return suffix === "" ? base : base * (SI[suffix] ?? 1);
}

/** Format a number back to a plain decimal/exponent token ngspice accepts. */
function formatNumber(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return n.toPrecision(12).replace(/\.?0+$/, "").replace(/(\.\d*?)0+e/, "$1e");
}

/**
 * Parse `.step` directives into concrete value lists (Requirement 6.3). Handles
 * `.step param <name> list v1 v2 ...` and the linear `.step param <name> start
 * stop step` form. Device sweeps (`.step <dev> <param> ...`) keep the first
 * token as the swept name.
 */
export function parseStepDirectives(netlist: Netlist): StepSweep[] {
  const out: StepSweep[] = [];
  for (const directive of netlist.directives) {
    if (directive.kind.toLowerCase() !== ".step") continue;
    const sweep = parseOneStep(directive);
    if (sweep !== null) out.push(sweep);
  }
  return out;
}

function parseOneStep(directive: Directive): StepSweep | null {
  const tokens = directive.args.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return null;
  // Optional leading sweep kind: `param`, `dec`, `oct`, `lin`, or a device name.
  let i = 0;
  let param: string;
  if (tokens[i]?.toLowerCase() === "param") {
    i++;
    param = tokens[i++] ?? "";
  } else {
    param = tokens[i++] ?? "";
  }
  if (param === "") return null;

  const rest = tokens.slice(i);
  if (rest[0]?.toLowerCase() === "list") {
    return { param, values: rest.slice(1), line: directive.line };
  }
  // Linear: start stop step
  if (rest.length === 3) {
    const start = parseSiNumber(rest[0] ?? "");
    const stop = parseSiNumber(rest[1] ?? "");
    const step = parseSiNumber(rest[2] ?? "");
    if (start !== null && stop !== null && step !== null && step !== 0) {
      const values: string[] = [];
      const ascending = stop >= start;
      for (let v = start; ascending ? v <= stop + step * 1e-9 : v >= stop - step * 1e-9; v += ascending ? Math.abs(step) : -Math.abs(step)) {
        values.push(formatNumber(Number(v.toPrecision(12))));
        if (values.length > 100_000) break;
      }
      return { param, values, line: directive.line };
    }
  }
  // Fall back to treating everything after the name as discrete values.
  return { param, values: rest, line: directive.line };
}

/**
 * Build the ngspice `.control` block that emulates one sweep (Requirement 6.3).
 * A device sweep alters the device value directly; a parameter sweep alters the
 * parameter so expressions referencing it re-evaluate. `set appendwrite` makes
 * each `write` append a full rawfile section, which `splitRawSections` later
 * separates per step.
 */
export function buildControlBlock(sweep: BoundSweep, plan: ControlPlan): string {
  const lines = [".control", "set appendwrite"];
  const varName = "x_step";
  lines.push(`foreach ${varName} ${sweep.values.join(" ")}`);
  if (sweep.device !== null) {
    lines.push(`  alter ${sweep.device} $${varName}`);
  } else {
    lines.push(`  alterparam ${sweep.param}=$${varName}`);
    lines.push("  reset");
  }
  lines.push(`  ${plan.analysis}`);
  lines.push(`  write ${plan.rawName} all`);
  lines.push("end");
  lines.push(".endc");
  return lines.join("\n");
}

/**
 * Split a file of concatenated Berkeley rawfile sections into one buffer per
 * section. ngspice with `set appendwrite` writes a complete header-and-payload
 * section per `write` with no separator between them (verified against ngspice
 * 44.2: the next section's `Title:` directly follows the previous payload), so a
 * `Title:` scan alone is unsafe because the byte sequence can occur inside a
 * binary payload. Each section is length-driven instead: parse its header,
 * compute the payload size from the point and variable counts and the detected
 * width, and advance exactly that far. A plain single-run rawfile yields one
 * section. ASCII (`Values:`) sections fall back to the next `Title:` boundary.
 */
export function splitRawSections(bytes: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const section = measureSection(bytes, offset);
    if (section === null) {
      // Could not measure (unexpected): return what we have, plus the remainder.
      if (offset === 0) return [bytes];
      parts.push(bytes.subarray(offset));
      break;
    }
    parts.push(bytes.subarray(offset, section.end));
    if (section.end <= offset) break;
    offset = section.end;
  }
  return parts.length === 0 ? [bytes] : parts;
}

/** Locate the end byte offset of the rawfile section starting at `start`. */
function measureSection(bytes: Buffer, start: number): { end: number } | null {
  // Decode a bounded header window as latin1 (1:1 with bytes) to read fields.
  const window = bytes.subarray(start, Math.min(bytes.length, start + 64 * 1024)).toString("latin1");
  const binIdx = window.indexOf("Binary:\n");
  const valIdx = window.indexOf("Values:\n");
  const useBinary = binIdx >= 0 && (valIdx < 0 || binIdx < valIdx);
  if (!useBinary) {
    // ASCII section: advance to the next Title: boundary (or end of file).
    const next = bytes.indexOf(Buffer.from("Title:", "latin1"), start + 1);
    return { end: next < 0 ? bytes.length : next };
  }
  const numVars = Number(/No\. Variables:\s*(\d+)/i.exec(window)?.[1] ?? "");
  const numPoints = Number(/No\. Points:\s*(\d+)/i.exec(window)?.[1] ?? "");
  const flagsLine = /Flags:\s*(.*)/i.exec(window)?.[1] ?? "";
  const complex = /\bcomplex\b/i.test(flagsLine);
  if (!Number.isFinite(numVars) || !Number.isFinite(numPoints) || numVars <= 0) return null;
  const dataStart = start + binIdx + "Binary:\n".length;
  const remaining = bytes.length - dataStart;
  // Detect per-value width from the full remaining payload is ambiguous across
  // concatenated sections; use the documented ngspice default of float64, and
  // fall back to float32 only if a float64 section would overrun the buffer.
  const width = chooseWidth(remaining, numPoints, numVars, complex);
  const perValue = complex ? width * 2 : width;
  const payload = numPoints * numVars * perValue;
  return { end: dataStart + payload };
}

/** ngspice default is float64; fall back to float32 only if float64 would overrun. */
function chooseWidth(remaining: number, numPoints: number, numVars: number, complex: boolean): 4 | 8 {
  const factor = complex ? 2 : 1;
  const need64 = numPoints * numVars * 8 * factor;
  if (need64 <= remaining) return 8;
  return 4;
}

/** A stepped result: the per-step parsed rawfiles plus the step index table. */
export interface SteppedResult {
  /** One parsed rawfile per step, in step order. */
  perStep: RawFile[];
  /** Number of steps. */
  count: number;
}

/**
 * Assemble a stepped result from an appended rawfile (Requirement 7.3): split
 * into sections and parse each. A single-section file is treated as one step.
 */
export function assembleStepped(bytes: Buffer): SteppedResult {
  const sections = splitRawSections(bytes);
  const perStep = sections.map((section) => readRaw(section));
  return { perStep, count: perStep.length };
}
