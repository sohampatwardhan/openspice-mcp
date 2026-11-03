/**
 * `.raw` reader (Requirement 7, 10). Sniffs ngspice Berkeley binary/ASCII and
 * LTspice binary rawfiles, detecting precision and the `Flags:` line from the
 * header rather than assuming. Exposes the variable list, point count, real vs
 * complex, step structure, per-variable summaries with downsampling, complex
 * magnitude/phase, metadata-only info, CSV/ASCII export, and `.meas` log
 * parsing. Truncation or an unknown header raises `RAW_PARSE_FAILED`.
 */

import { writeFileSync } from "node:fs";

import { LIMITS } from "./config.js";
import { ToolError } from "./errors.js";

export type RawFormat = "ngspice-binary" | "ngspice-ascii" | "ltspice-binary";

export interface Variable {
  index: number;
  name: string;
  /** The ngspice/LTspice variable "type" column (time, voltage, current, frequency, ...). */
  kind: string;
}

export interface ComplexSample {
  re: number;
  im: number;
  magnitude: number;
  phase: number;
}

/** A parsed rawfile. Sample arrays are materialised on demand through `values`/`complexValues`. */
export interface RawFile {
  format: RawFormat;
  title: string;
  plotname: string;
  flags: string[];
  complex: boolean;
  pointCount: number;
  variables: Variable[];
  /** Step structure when the run was `.step`-swept (not yet populated by a single run). */
  steps: { count: number; values: number[] } | null;
  /** Real sample array for a variable name (magnitude for complex data). */
  values(name: string): number[];
  /** Complex sample array for a variable name; empty for real data. */
  complexValues(name: string): ComplexSample[];
}

interface Header {
  title: string;
  plotname: string;
  flags: string[];
  complex: boolean;
  numVars: number;
  numPoints: number;
  variables: Variable[];
  /** Byte offset in the buffer just past the `Binary:`/`Values:` terminator. */
  dataOffset: number;
  /** The terminator keyword, `Binary` or `Values`. */
  terminator: "Binary" | "Values";
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  throw new ToolError("RAW_PARSE_FAILED", message, details);
}

/** Decode the ASCII (or UTF-16LE) header portion of a rawfile and locate the data. */
function readHeader(bytes: Buffer): { header: Header; utf16: boolean } {
  const utf16 = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  // Decode the header region to parse fields; for UTF-16 decode as UTF-16LE,
  // otherwise latin1 keeps byte offsets 1:1 with characters.
  const headerText = utf16 ? bytes.toString("utf16le") : bytes.toString("latin1");
  const normalised = headerText.replace(/\r\n|\r/g, "\n");

  const binIdx = normalised.indexOf("Binary:");
  const valIdx = normalised.indexOf("Values:");
  if (binIdx < 0 && valIdx < 0) fail("not a SPICE rawfile: no Binary:/Values: terminator in header");
  const terminator: "Binary" | "Values" = valIdx >= 0 && (binIdx < 0 || valIdx < binIdx) ? "Values" : "Binary";

  // Compute the byte offset of the data that follows the terminator line. The
  // terminator is followed by a newline (CRLF for LTspice, LF for ngspice).
  let dataOffset = -1;
  for (const eol of utf16 ? ["\r\n", "\n"] : ["\n"]) {
    const probe = Buffer.from(`${terminator}:${eol}`, utf16 ? "utf16le" : "utf8");
    const idx = bytes.indexOf(probe);
    if (idx >= 0) {
      dataOffset = idx + probe.length;
      break;
    }
  }
  if (dataOffset < 0) fail("rawfile terminator line is malformed");

  const field = (name: string): string | null => {
    const re = new RegExp(`^${name}:\\s*(.*)$`, "mi");
    const m = re.exec(normalised);
    return m ? (m[1] ?? "").trim() : null;
  };

  const flagsLine = field("Flags") ?? "";
  const flags = flagsLine.split(/\s+/).filter((f) => f !== "");
  const complex = flags.includes("complex");
  const numVars = Number(field("No. Variables"));
  const numPoints = Number(field("No. Points"));
  if (!Number.isFinite(numVars) || numVars <= 0) fail("rawfile header is missing a valid No. Variables");
  if (!Number.isFinite(numPoints) || numPoints < 0) fail("rawfile header is missing a valid No. Points");

  // Parse the Variables: block.
  const varsBlockStart = normalised.indexOf("Variables:");
  if (varsBlockStart < 0) fail("rawfile header has no Variables: block");
  const varsSection = normalised.slice(varsBlockStart + "Variables:".length, normalised.indexOf(`${terminator}:`));
  const variables: Variable[] = [];
  for (const line of varsSection.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const cols = trimmed.split(/\s+/);
    const index = Number(cols[0]);
    const name = cols[1] ?? "";
    const kind = cols[2] ?? "";
    if (!Number.isFinite(index) || name === "") continue;
    variables.push({ index, name, kind });
  }
  if (variables.length !== numVars) {
    fail(`rawfile declares ${numVars} variables but the Variables: block lists ${variables.length}`, {
      declared: numVars,
      found: variables.length,
    });
  }

  return {
    header: {
      title: field("Title") ?? "",
      plotname: field("Plotname") ?? "",
      flags,
      complex,
      numVars,
      numPoints,
      variables,
      dataOffset,
      terminator: terminator as "Binary" | "Values",
    },
    utf16,
  };
}

function complexOf(re: number, im: number): ComplexSample {
  return { re, im, magnitude: Math.hypot(re, im), phase: Math.atan2(im, re) };
}

/** Read a rawfile buffer into a `RawFile` (Requirement 7.1). */
export function readRaw(bytes: Buffer): RawFile {
  const { header, utf16 } = readHeader(bytes);
  const { numVars, numPoints, complex } = header;

  // Per-variable column arrays.
  const real: number[][] = header.variables.map(() => []);
  const cplx: ComplexSample[][] = header.variables.map(() => []);

  if (header.terminator === "Values") {
    parseAsciiValues(bytes, header, real, cplx);
  } else if (utf16) {
    parseLtspiceBinary(bytes, header, real, cplx);
  } else {
    parseNgspiceBinary(bytes, header, real, cplx);
  }

  const format: RawFormat = utf16 ? "ltspice-binary" : header.terminator === "Values" ? "ngspice-ascii" : "ngspice-binary";

  const indexByName = new Map<string, number>();
  header.variables.forEach((v, i) => indexByName.set(v.name.toLowerCase(), i));

  const resolve = (name: string): number => {
    const i = indexByName.get(name.toLowerCase());
    if (i === undefined) throw new ToolError("RAW_PARSE_FAILED", `no variable named ${JSON.stringify(name)} in the rawfile`);
    return i;
  };

  return {
    format,
    title: header.title,
    plotname: header.plotname,
    flags: header.flags,
    complex,
    pointCount: numPoints,
    variables: header.variables,
    steps: null,
    values(name: string): number[] {
      const i = resolve(name);
      if (complex) return (cplx[i] ?? []).map((c) => c.magnitude);
      return real[i] ?? [];
    },
    complexValues(name: string): ComplexSample[] {
      const i = resolve(name);
      return cplx[i] ?? [];
    },
  };
}

/** ngspice/LTspice binary real: detect float32 vs float64 from the payload size. */
function detectRealWidth(payloadBytes: number, numVars: number, numPoints: number): 4 | 8 {
  if (numPoints === 0) return 8;
  const perPoint = payloadBytes / numPoints;
  const width = perPoint / numVars;
  if (width === 8) return 8;
  if (width === 4) return 4;
  fail(`binary payload size ${payloadBytes} does not match ${numPoints} points x ${numVars} variables at 4 or 8 bytes`, {
    payloadBytes,
    numPoints,
    numVars,
  });
}

function parseNgspiceBinary(bytes: Buffer, header: Header, real: number[][], cplx: ComplexSample[][]): void {
  const { numVars, numPoints, complex, dataOffset } = header;
  const payload = bytes.length - dataOffset;
  if (complex) {
    const need = numPoints * numVars * 16;
    if (payload < need) fail(`truncated complex payload: have ${payload} bytes, need ${need}`, { have: payload, need });
    let off = dataOffset;
    for (let p = 0; p < numPoints; p++) {
      for (let v = 0; v < numVars; v++) {
        const re = bytes.readDoubleLE(off);
        const im = bytes.readDoubleLE(off + 8);
        off += 16;
        (cplx[v] as ComplexSample[]).push(complexOf(re, im));
      }
    }
    return;
  }
  const width = detectRealWidth(payload, numVars, numPoints);
  const need = numPoints * numVars * width;
  if (payload < need) fail(`truncated binary payload: have ${payload} bytes, need ${need}`, { have: payload, need });
  let off = dataOffset;
  for (let p = 0; p < numPoints; p++) {
    for (let v = 0; v < numVars; v++) {
      const value = width === 8 ? bytes.readDoubleLE(off) : bytes.readFloatLE(off);
      off += width;
      (real[v] as number[]).push(value);
    }
  }
}

/** LTspice real transient: float64 time axis (variable 0), float32 for the rest. */
function parseLtspiceBinary(bytes: Buffer, header: Header, real: number[][], cplx: ComplexSample[][]): void {
  const { numVars, numPoints, complex, dataOffset } = header;
  if (complex) {
    // Complex LTspice runs store float64 pairs; reuse the ngspice complex path.
    parseNgspiceBinary(bytes, header, real, cplx);
    return;
  }
  const perPoint = 8 + (numVars - 1) * 4;
  const need = numPoints * perPoint;
  const payload = bytes.length - dataOffset;
  if (payload < need) fail(`truncated LTspice payload: have ${payload} bytes, need ${need}`, { have: payload, need });
  let off = dataOffset;
  for (let p = 0; p < numPoints; p++) {
    for (let v = 0; v < numVars; v++) {
      if (v === 0) {
        (real[v] as number[]).push(bytes.readDoubleLE(off));
        off += 8;
      } else {
        (real[v] as number[]).push(bytes.readFloatLE(off));
        off += 4;
      }
    }
  }
}

function parseAsciiValues(bytes: Buffer, header: Header, real: number[][], cplx: ComplexSample[][]): void {
  const { numVars, numPoints, complex, dataOffset } = header;
  const text = bytes.toString("latin1").slice(dataOffset);
  // Tokenise into numbers (complex "re,im" become two tokens). Point indices are
  // the first token on a point's first line; we rely purely on value ordering.
  const tokens = text.split(/\s+/).filter((t) => t !== "");
  // Each point: a leading point-index integer, then numVars values.
  let ti = 0;
  for (let p = 0; p < numPoints; p++) {
    // Skip the point index token.
    if (ti >= tokens.length) fail(`truncated ASCII values: ran out at point ${p}`, { point: p });
    ti++;
    for (let v = 0; v < numVars; v++) {
      if (ti >= tokens.length) fail(`truncated ASCII values: ran out at point ${p} variable ${v}`, { point: p, variable: v });
      const token = tokens[ti] as string;
      ti++;
      if (complex) {
        const [reStr, imStr] = token.split(",");
        (cplx[v] as ComplexSample[]).push(complexOf(Number(reStr), Number(imStr)));
      } else {
        (real[v] as number[]).push(Number(token));
      }
    }
  }
}

export interface VariableSummary {
  name: string;
  kind: string;
  min: number;
  max: number;
  final: number;
  /** Time-domain approximations; null for complex data. */
  mean: number | null;
  peakToPeak: number | null;
  samples: number[];
  complexSamples?: ComplexSample[];
}

export interface Summary {
  format: RawFormat;
  complex: boolean;
  pointCount: number;
  variables: VariableSummary[];
}

/** Evenly downsample to at most `maxPoints` samples, always keeping first and last. */
function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints || maxPoints <= 0) return arr.slice();
  const out: T[] = [];
  const stride = (arr.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) {
    const idx = Math.round(i * stride);
    out.push(arr[Math.min(idx, arr.length - 1)] as T);
  }
  return out;
}

/** Per-variable summary with bounded, downsampled samples (Requirement 7.2, 7.4). */
export function summarize(raw: RawFile, vars: string[], maxPoints: number = LIMITS.defaultMaxPoints): Summary {
  const limit = Math.min(Math.max(1, Math.floor(maxPoints)), LIMITS.maxPoints);
  const names = vars.length > 0 ? vars : raw.variables.map((v) => v.name);
  const variables: VariableSummary[] = names.map((name) => {
    const kind = raw.variables.find((v) => v.name.toLowerCase() === name.toLowerCase())?.kind ?? "";
    const real = raw.values(name);
    const min = real.length > 0 ? Math.min(...real) : 0;
    const max = real.length > 0 ? Math.max(...real) : 0;
    const finalValue = real.length > 0 ? (real[real.length - 1] as number) : 0;
    const summary: VariableSummary = {
      name,
      kind,
      min,
      max,
      final: finalValue,
      mean: raw.complex ? null : real.length > 0 ? real.reduce((a, b) => a + b, 0) / real.length : 0,
      peakToPeak: raw.complex ? null : max - min,
      samples: downsample(real, limit),
    };
    if (raw.complex) summary.complexSamples = downsample(raw.complexValues(name), limit);
    return summary;
  });
  return { format: raw.format, complex: raw.complex, pointCount: raw.pointCount, variables };
}

export interface RawInfo {
  format: RawFormat;
  title: string;
  plotname: string;
  flags: string[];
  complex: boolean;
  pointCount: number;
  variables: Variable[];
  steps: { count: number; values: number[] } | null;
}

/** Metadata only, no sample arrays (Requirement 10.2). */
export function rawInfo(raw: RawFile): RawInfo {
  return {
    format: raw.format,
    title: raw.title,
    plotname: raw.plotname,
    flags: raw.flags,
    complex: raw.complex,
    pointCount: raw.pointCount,
    variables: raw.variables,
    steps: raw.steps,
  };
}

export interface ExportResult {
  path: string;
  format: "csv" | "ascii";
  rows: number;
  columns: string[];
}

/** Write selected variables to CSV or whitespace ASCII (Requirement 7, 10.3). The caller confines `path`. */
export function exportWaveforms(raw: RawFile, vars: string[], path: string, format: "csv" | "ascii" = "csv"): ExportResult {
  const names = vars.length > 0 ? vars : raw.variables.map((v) => v.name);
  const sep = format === "csv" ? "," : "\t";
  const columns = raw.complex ? names.flatMap((n) => [`${n}:re`, `${n}:im`]) : names;
  const lines: string[] = [columns.join(sep)];
  const n = raw.pointCount;
  if (raw.complex) {
    const cols = names.map((name) => raw.complexValues(name));
    for (let p = 0; p < n; p++) {
      const row: string[] = [];
      for (const col of cols) {
        const s = col[p];
        row.push(String(s?.re ?? ""), String(s?.im ?? ""));
      }
      lines.push(row.join(sep));
    }
  } else {
    const cols = names.map((name) => raw.values(name));
    for (let p = 0; p < n; p++) {
      lines.push(cols.map((col) => String(col[p] ?? "")).join(sep));
    }
  }
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return { path, format, rows: n, columns };
}

export interface Measurement {
  name: string;
  value: number;
}

/**
 * Parse ngspice `.meas` results from a log. ngspice prints lines like
 * `name = 1.234e+00 ...` or `name=1.234e+00`; the first number on such a line is
 * the measurement value (Requirement 7.5).
 */
export function parseMeas(log: string): Measurement[] {
  const out: Measurement[] = [];
  const seen = new Set<string>();
  // `name = <number>` possibly followed by more fields (e.g. ngspice's `at=` column).
  const re = /^\s*([A-Za-z_][\w()]*)\s*=\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*(\S*)/;
  // ngspice's batch-mode log prints memory/size statistics in the same
  // `Name = <number> <unit>` shape (e.g. `Stack = 0 bytes.`, `... = 12.555 MB.`).
  // A measurement value is never immediately followed by a size unit, so reject those.
  const sizeUnit = /^(?:bytes?|pages?|[kKmMgG]?i?[bB])\b/;
  for (const line of log.split(/\r\n|\r|\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const trailing = m[3] ?? "";
    if (trailing !== "" && sizeUnit.test(trailing)) continue;
    const name = (m[1] ?? "").toLowerCase();
    const value = Number(m[2]);
    if (!Number.isFinite(value) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value });
  }
  return out;
}
