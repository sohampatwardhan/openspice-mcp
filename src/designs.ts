/**
 * The in-memory open-designs session (Requirement 9, 10 association). A design
 * is a file inside the roots — an LTspice schematic (`.asc`/`.asy`) or a SPICE
 * netlist (`.cir`/`.net`/`.sp`) — recorded with a stable id, its resolved path,
 * its kind, its detected encoding, and whether it is the active design.
 *
 *   - open: resolve inside the roots, detect kind, record (or re-activate an
 *     already-open path), and mark it active.
 *   - getContent / setContent: read the current text and encoding; write new
 *     content only after it validates (a netlist/schematic parse error means no
 *     write, Requirement 9.6), preserving a schematic's original encoding and
 *     CRLF line endings (Requirement 18.1). An optional snapshot of the prior
 *     content is taken before the write.
 *   - restore: put the most recent snapshot back.
 *   - listChanged(cursor): report which designs changed since a cursor.
 *   - setResult / lastResult: associate a design with its latest `.raw`/`.log`
 *     (Requirement 10.1).
 *
 * Validation and encoding reuse the netlist parser and the `.asc` reader; this
 * module owns only session state and the confined file IO.
 */

import { readFile, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { extname, join } from "node:path";

import { decodeText, encodeText, readAsc, readAsy, type Encoding } from "./asc.js";
import { ToolError } from "./errors.js";
import { parse } from "./netlist.js";
import type { Roots } from "./paths.js";

/** Whether a design is a schematic or a netlist. */
export type DesignKind = "schematic" | "netlist";

/** A publicly listed open design. */
export interface DesignInfo {
  id: string;
  path: string;
  kind: DesignKind;
  active: boolean;
}

/** The `.raw`/`.log` produced by a design's most recent run (Requirement 10.1). */
export interface DesignResult {
  rawPath: string;
  logPath: string;
  runDir: string;
}

export interface SetOptions {
  /** Take a snapshot of the prior content before writing (Requirement 9.5). */
  snapshot?: boolean;
}

export interface SetResult {
  /** True when the new content validated and was written. */
  written: boolean;
  /** Set when validation failed; the file is then unchanged (Requirement 9.6). */
  diagnostic: string | null;
  /** The snapshot id taken before the write, when one was requested. */
  snapshotId: string | null;
}

export interface GetResult {
  text: string;
  encoding: Encoding;
}

export interface RestoreResult {
  restored: boolean;
  diagnostic: string | null;
}

export interface ChangedEntry {
  id: string;
  path: string;
  /** Monotonic change sequence number the change was recorded at. */
  at: number;
}

export interface ListChangedResult {
  changed: ChangedEntry[];
  /** The latest cursor; pass it back to see only newer changes. */
  cursor: number;
}

interface DesignState {
  id: string;
  path: string;
  kind: DesignKind;
  encoding: Encoding;
  /** The most recent snapshot bytes for undo, or null. */
  snapshot: { id: string; bytes: Buffer } | null;
  /** The latest run result, or null. */
  result: DesignResult | null;
  /** The change sequence number of this design's last open/set/restore. */
  changedAt: number;
}

/** Netlist file extensions recognised as a design (Requirement 2, 9). */
const NETLIST_EXTENSIONS = new Set([".cir", ".net", ".sp", ".spi", ".ckt"]);
/** Schematic/symbol extensions recognised as a design. */
const SCHEMATIC_EXTENSIONS = new Set([".asc", ".asy"]);

export class Designs {
  private readonly byId = new Map<string, DesignState>();
  private readonly byPath = new Map<string, string>();
  private activeId: string | null = null;
  private seq = 0;
  private idCounter = 0;

  constructor(private readonly roots: Roots) {}

  /** Open (or re-activate) a design by path inside the roots and mark it active (Requirement 9.1). */
  async open(path: string): Promise<DesignInfo> {
    const resolved = await this.roots.resolveInside(path);
    const existingId = this.byPath.get(resolved);
    if (existingId !== undefined) {
      this.touch(existingId);
      this.activeId = existingId;
      return this.info(existingId);
    }

    const kind = kindForPath(resolved);
    const bytes = await readFile(resolved);
    const encoding = detectEncoding(resolved, bytes);
    const id = `design-${++this.idCounter}`;
    const state: DesignState = { id, path: resolved, kind, encoding, snapshot: null, result: null, changedAt: ++this.seq };
    this.byId.set(id, state);
    this.byPath.set(resolved, id);
    this.activeId = id;
    return this.info(id);
  }

  /** Every open design, with the active one flagged (Requirement 9.2). */
  list(): DesignInfo[] {
    return [...this.byId.keys()].map((id) => this.info(id));
  }

  /** The active design, or null when none is active (Requirement 9.2). */
  active(): DesignInfo | null {
    return this.activeId === null ? null : this.info(this.activeId);
  }

  /** Current text and detected encoding of a design (Requirement 9.3). */
  async getContent(id: string): Promise<GetResult> {
    const state = this.require(id);
    this.activeId = id;
    const bytes = await readFile(state.path);
    if (state.kind === "schematic") {
      const decoded = decodeText(bytes);
      return { text: decoded.text, encoding: decoded.encoding };
    }
    return { text: bytes.toString("utf8"), encoding: "utf-8" };
  }

  /**
   * Validate and write new content for a design (Requirement 9.4, 9.6). A
   * schematic is re-encoded to its original encoding with CRLF; a netlist is
   * written UTF-8. A parse/validation error returns a diagnostic and leaves the
   * file untouched.
   */
  async setContent(id: string, content: string, opts: SetOptions = {}): Promise<SetResult> {
    const state = this.require(id);
    this.activeId = id;

    const invalid = validateContent(state.kind, content);
    if (invalid !== null) return { written: false, diagnostic: invalid, snapshotId: null };

    let snapshotId: string | null = null;
    if (opts.snapshot === true) {
      const prior = await readFile(state.path);
      snapshotId = `snap-${state.id}-${++this.seq}`;
      const file = join(this.roots.snapshotDir(), `${snapshotId}${extname(state.path)}`);
      writeFileSync(file, prior);
      state.snapshot = { id: snapshotId, bytes: prior };
    }

    const bytes = state.kind === "schematic" ? encodeText(content, state.encoding) : Buffer.from(content, "utf8");
    await writeFile(state.path, bytes);
    this.touch(id);
    return { written: true, diagnostic: null, snapshotId };
  }

  /** Restore the most recent snapshot for a design (Requirement 9.5). */
  async restore(id: string): Promise<RestoreResult> {
    const state = this.require(id);
    this.activeId = id;
    if (state.snapshot === null) return { restored: false, diagnostic: "no snapshot has been taken for this design" };
    await writeFile(state.path, state.snapshot.bytes);
    this.touch(id);
    return { restored: true, diagnostic: null };
  }

  /** Designs changed since `cursor`, with the latest cursor to pass back (Requirement 9, list_changed). */
  listChanged(cursor: number): ListChangedResult {
    const changed: ChangedEntry[] = [];
    for (const state of this.byId.values()) {
      if (state.changedAt > cursor) changed.push({ id: state.id, path: state.path, at: state.changedAt });
    }
    changed.sort((a, b) => a.at - b.at);
    return { changed, cursor: this.seq };
  }

  /** True when a design with this id is open. */
  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Associate a design with its latest run result (Requirement 10.1). */
  setResult(id: string, result: DesignResult): void {
    this.require(id).result = result;
  }

  /** The design's latest run result, or null when it has not been simulated. */
  lastResult(id: string): DesignResult | null {
    return this.require(id).result;
  }

  private info(id: string): DesignInfo {
    const state = this.require(id);
    return { id: state.id, path: state.path, kind: state.kind, active: this.activeId === id };
  }

  private require(id: string): DesignState {
    const state = this.byId.get(id);
    if (state === undefined) throw new ToolError("DESIGN_NOT_FOUND", `no open design with id ${JSON.stringify(id)}`, { id });
    return state;
  }

  private touch(id: string): void {
    const state = this.byId.get(id);
    if (state !== undefined) state.changedAt = ++this.seq;
  }
}

/** Decide a design's kind from its extension; default to netlist for an unknown extension. */
function kindForPath(path: string): DesignKind {
  const ext = extname(path).toLowerCase();
  if (SCHEMATIC_EXTENSIONS.has(ext)) return "schematic";
  if (NETLIST_EXTENSIONS.has(ext)) return "netlist";
  return "netlist";
}

/** Detect the encoding of a design's bytes: schematics sniff like `.asc`, netlists are UTF-8. */
function detectEncoding(path: string, bytes: Buffer): Encoding {
  if (kindForPath(path) === "schematic") return decodeText(bytes).encoding;
  return "utf-8";
}

/**
 * Validate new content for a design kind (Requirement 9.4). Returns a diagnostic
 * string when the content is not a valid file of that kind, or null when it is.
 *
 *   - netlist: any per-line parse diagnostic (an unparseable line, a device with
 *     no nodes, an unrecognised directive) counts as a parse error.
 *   - schematic: the reader is lenient and preserves unmodelled keywords, so a
 *     file is rejected only when it has diagnostics *and* no recognised
 *     structure (no version, sheet, component, wire, or flag) — i.e. it is not a
 *     schematic at all.
 */
function validateContent(kind: DesignKind, content: string): string | null {
  if (kind === "netlist") {
    const netlist = parse(content);
    const first = netlist.diagnostics[0];
    if (first !== undefined) return `line ${first.line}: ${first.reason} (${JSON.stringify(first.text)})`;
    return null;
  }
  // Schematic. Try the richer `.asc` reader first; `.asy` falls back to the symbol reader.
  const bytes = Buffer.from(content, "utf8");
  const asc = readAsc(bytes);
  const hasStructure =
    asc.version !== null || asc.sheet !== null || asc.components.length > 0 || asc.wires.length > 0 || asc.flags.length > 0;
  if (hasStructure) return null;
  const sym = readAsy(bytes);
  if (sym.pins.length > 0 || sym.primitives.length > 0 || sym.symbolType !== null) return null;
  if (asc.diagnostics.length > 0 || content.trim() !== "") {
    return "content is not a recognisable LTspice schematic or symbol (no VERSION/SHEET/SYMBOL/WIRE/FLAG)";
  }
  return null;
}
