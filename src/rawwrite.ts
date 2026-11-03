/**
 * LTspice-compatible `.raw` writer (Requirement 18.2, 18.3, 18.4). Converts an
 * ngspice result (as parsed by `raw.readRaw`) into an LTspice binary rawfile so
 * the result also opens in LTspice, while the caller keeps ngspice's original
 * beside it. Fidelity is the gate: the written bytes are re-read with our own
 * parser and compared (variables, point count, values within tolerance). If a
 * faithful file cannot be produced, the writer declines with a diagnostic rather
 * than emitting a file LTspice would reject, so the caller returns the
 * ngspice-native artifact (Requirement 18.4).
 *
 * LTspice conventions used here (documented, e.g. PyLTSpice; none copied):
 *   - UTF-16LE header with a BOM and CRLF line endings.
 *   - A `Flags:` line carrying real/complex/double/stepped/forward.
 *   - Real transient: the first variable (time axis) is float64, the remaining
 *     traces are float32.
 *   - Complex (.ac): every value is a float64 (real, imag) pair, like ngspice.
 * Every detail the design marked uncertain is tagged in `uncertain` and pinned
 * by the re-read round-trip rather than asserted against a real LTspice file
 * (LTspice is not available on this host; see docs/compatibility.md).
 */

import { readRaw, type RawFile } from "./raw.js";

export interface LtspiceRawResult {
  /** The LTspice-compatible rawfile bytes (valid only when `verified`). */
  bytes: Buffer;
  /** True when a round-trip re-read reproduced the source within tolerance. */
  verified: boolean;
  /** Set when the writer declined or verification failed; the caller keeps ngspice's raw. */
  diagnostic: string | null;
  /** Uncertain LTspice-format details the writer relied on, for the caller to surface. */
  uncertain: string[];
}

/** Uncertain format details, tagged per the design's fidelity notes. */
const UNCERTAIN: string[] = [
  "LTspice .raw header encoding (UTF-16LE assumed; some builds may use UTF-8)",
  "per-analysis trace widths (float64 time + float32 traces assumed for a real transient; double/stepped/.ac differ)",
  "exact Flags: token set and spelling",
];

/** Compose the LTspice UTF-16LE header for the given plot, with a single BOM and CRLF endings. */
function buildHeader(raw: RawFile, flags: string[], numPoints: number): Buffer {
  const lines = [
    `Title: ${raw.title || "* OpenSPICE"}`,
    `Date: ${new Date().toUTCString()}`,
    `Plotname: ${raw.plotname || "Transient Analysis"}`,
    `Flags: ${flags.join(" ")}`,
    `No. Variables: ${raw.variables.length}`,
    `No. Points: ${numPoints}`,
    "Variables:",
  ];
  for (const v of raw.variables) lines.push(`\t${v.index}\t${v.name}\t${v.kind}`);
  lines.push("Binary:");
  // A single UTF-16LE BOM, CRLF line endings, and a CRLF after the terminator.
  const text = "\ufeff" + lines.join("\r\n") + "\r\n";
  return Buffer.from(text, "utf16le");
}

/** Build the payload for a real run: float64 for the first (axis) variable, float32 for the rest. */
function realPayload(raw: RawFile, numPoints: number): Buffer {
  const numVars = raw.variables.length;
  const cols = raw.variables.map((v) => raw.values(v.name));
  const perPoint = 8 + (numVars - 1) * 4;
  const payload = Buffer.alloc(numPoints * perPoint);
  let off = 0;
  for (let p = 0; p < numPoints; p++) {
    for (let v = 0; v < numVars; v++) {
      const value = cols[v]?.[p] ?? 0;
      if (v === 0) {
        payload.writeDoubleLE(value, off);
        off += 8;
      } else {
        payload.writeFloatLE(value, off);
        off += 4;
      }
    }
  }
  return payload;
}

/** Build the payload for a complex run: float64 (re, im) pairs, like ngspice/LTspice double. */
function complexPayload(raw: RawFile, numPoints: number): Buffer {
  const numVars = raw.variables.length;
  const cols = raw.variables.map((v) => raw.complexValues(v.name));
  const payload = Buffer.alloc(numPoints * numVars * 16);
  let off = 0;
  for (let p = 0; p < numPoints; p++) {
    for (let v = 0; v < numVars; v++) {
      const s = cols[v]?.[p];
      payload.writeDoubleLE(s?.re ?? 0, off);
      payload.writeDoubleLE(s?.im ?? 0, off + 8);
      off += 16;
    }
  }
  return payload;
}

/** Absolute/relative tolerance comparison for a sample value (float32 traces lose precision). */
function close(a: number, b: number, rel = 1e-5, abs = 1e-9): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= Math.max(abs, rel * Math.max(Math.abs(a), Math.abs(b)));
}

/** Re-read the written bytes and confirm they reproduce the source (Requirement 18.3). */
function verifyRoundTrip(source: RawFile, bytes: Buffer): string | null {
  let back: RawFile;
  try {
    back = readRaw(bytes);
  } catch (err) {
    return `re-reading the written LTspice raw failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (back.pointCount !== source.pointCount) return `point count changed (${source.pointCount} -> ${back.pointCount})`;
  const sourceNames = source.variables.map((v) => v.name).join(",");
  const backNames = back.variables.map((v) => v.name).join(",");
  if (sourceNames !== backNames) return `variable list changed (${sourceNames} -> ${backNames})`;

  for (const v of source.variables) {
    if (source.complex) {
      const a = source.complexValues(v.name);
      const b = back.complexValues(v.name);
      for (let i = 0; i < a.length; i++) {
        if (!close(a[i]?.re ?? 0, b[i]?.re ?? 0) || !close(a[i]?.im ?? 0, b[i]?.im ?? 0)) {
          return `complex values for ${v.name} differ at point ${i}`;
        }
      }
    } else {
      const a = source.values(v.name);
      const b = back.values(v.name);
      // Non-axis traces are float32; use a looser relative tolerance for them.
      const isAxis = v.index === 0;
      const rel = isAxis ? 1e-9 : 1e-4;
      for (let i = 0; i < a.length; i++) {
        if (!close(a[i] ?? 0, b[i] ?? 0, rel, 1e-6)) return `values for ${v.name} differ at point ${i}`;
      }
    }
  }
  return null;
}

/**
 * Write an LTspice-compatible rawfile from an ngspice result and verify it by
 * re-reading (Requirement 18.2, 18.3). On any fidelity problem it returns
 * `verified: false` with a diagnostic instead of throwing, so the caller keeps
 * the ngspice-native artifact (Requirement 18.4).
 */
export function writeLtspiceRaw(raw: RawFile): LtspiceRawResult {
  const numPoints = raw.pointCount;
  const flags: string[] = [];
  flags.push(raw.complex ? "complex" : "real");
  if (raw.complex) flags.push("double");
  flags.push("forward");
  if (raw.steps !== null) flags.push("stepped");

  let bytes: Buffer;
  try {
    const header = buildHeader(raw, flags, numPoints);
    const payload = raw.complex ? complexPayload(raw, numPoints) : realPayload(raw, numPoints);
    bytes = Buffer.concat([header, payload]);
  } catch (err) {
    return {
      bytes: Buffer.alloc(0),
      verified: false,
      diagnostic: `could not build an LTspice raw: ${err instanceof Error ? err.message : String(err)}`,
      uncertain: UNCERTAIN,
    };
  }

  const problem = verifyRoundTrip(raw, bytes);
  if (problem !== null) {
    return { bytes, verified: false, diagnostic: `LTspice raw failed its round-trip fidelity check: ${problem}`, uncertain: UNCERTAIN };
  }
  return { bytes, verified: true, diagnostic: null, uncertain: UNCERTAIN };
}
