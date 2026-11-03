/**
 * `.asc` generator with round-trip verification (Requirement 5, 11, 18.1). Takes
 * a structured circuit description and lays it out on an LTspice sheet with
 * deterministic grid placement and orthogonal wire routing, places ground flags
 * on `0`/`GND` and net-label flags on every named net, writes the analysis and
 * other directives as on-sheet `!` TEXT lines, and emits LTspice-openable `.asc`
 * bytes. An inconsistent description is rejected up front with
 * `GENERATE_INVALID`.
 *
 * The generated geometry is never trusted: the bytes are fed back through the
 * real `.asc`->netlist converter (`ascnet.toNetlist` over `readAsc`), and the
 * resulting device set and net connectivity are compared against the intended
 * circuit. A match returns `verified: true` with counts; a mismatch returns
 * `verified: false` with diffs, and in strict mode throws `GENERATE_UNVERIFIED`
 * (Requirement 11). The round trip uses the same converter the server exposes,
 * so a schematic is never presented as verified on unverified geometry.
 *
 * Encoding: LTspice reads both UTF-8 and UTF-16LE `.asc` files and the current
 * build tends toward UTF-8; the writer emits UTF-8 with CRLF line endings (the
 * LTspice convention) and records which encoding it used. The exact per-build
 * preference is marked uncertain in the design and pinned by the corpus.
 */

import { readAsc } from "./asc.js";
import { toNetlist } from "./ascnet.js";
import { ToolError } from "./errors.js";
import { emit, type Device, type Directive, type Netlist } from "./netlist.js";
import { builtinSymbols, SymbolResolver, type Symbol } from "./symbols.js";

/** A device in a circuit description fed to the generator. */
export interface CircuitDevice {
  /** Device letter: R, C, L, V, I, D, Q, M, X, ... */
  kind: string;
  /** Instance name (e.g. `R1`). */
  name: string;
  /** Connected nets in SPICE pin order. Ground is `0` (or `GND`). */
  nodes: string[];
  /** Value for a passive/source (`1k`, `AC 1`, `SINE(...)`), when applicable. */
  value?: string | null;
  /** Model/subcircuit name for a model-based device, when applicable. */
  model?: string | null;
}

/** A structured circuit the generator turns into an `.asc`. */
export interface Circuit {
  title: string;
  devices: CircuitDevice[];
  /** On-sheet SPICE directives (`.ac ...`, `.tran ...`, `.param ...`), without the leading `!`. */
  directives: string[];
}

export interface GenerateOptions {
  /** When true, a round-trip mismatch throws `GENERATE_UNVERIFIED` instead of returning diffs. */
  strict?: boolean;
}

export interface GenerateResult {
  /** The LTspice-openable `.asc` bytes. */
  bytes: Buffer;
  /** The encoding the bytes were written in (UTF-8). */
  encoding: "utf-8";
  /** An equivalent SPICE netlist for the same circuit. */
  netlistText: string;
  /** True when the round trip reproduced the intended device set and connectivity. */
  verified: boolean;
  /** Device and connectivity differences found by the round trip (empty when verified). */
  diffs: string[];
  /** Counts the caller can surface. */
  counts: { devices: number; nets: number };
}

/** Maps a device letter to the builtin symbol whose pin order matches SPICE node order. */
const SYMBOL_FOR_KIND: Record<string, string> = {
  R: "res",
  C: "cap",
  L: "ind",
  V: "voltage",
  I: "current",
  D: "diode",
  Q: "npn",
  M: "nmos",
};

/** Device letters whose trailing value names a model rather than a plain value. */
const MODEL_KINDS = new Set(["Q", "J", "Z", "M", "D"]);

const GRID = 16;
/** Horizontal spacing between device columns (a multiple of the grid). */
const COLUMN_PITCH = 160;
/** The y of each device's symbol origin. */
const DEVICE_Y = 64;
/** Each net gets a horizontal rail at this y plus an index offset. */
const RAIL_TOP = 320;
const RAIL_PITCH = 48;

/** Validate the description for internal consistency (Requirement 5.4 -> GENERATE_INVALID). */
function validateCircuit(circuit: Circuit): void {
  const invalid = (message: string, details: Record<string, unknown> = {}): never => {
    throw new ToolError("GENERATE_INVALID", message, details);
  };
  if (circuit.devices.length === 0) invalid("circuit has no devices");
  const seen = new Set<string>();
  for (const device of circuit.devices) {
    if (device.name.trim() === "") invalid("a device has an empty name", { device });
    const key = device.name.toLowerCase();
    if (seen.has(key)) invalid(`duplicate instance name ${JSON.stringify(device.name)}`, { name: device.name });
    seen.add(key);
    if (device.kind.trim() === "") invalid(`device ${JSON.stringify(device.name)} has no kind`, { name: device.name });
    const expected = expectedPinCount(device.kind);
    if (device.nodes.length < expected) {
      invalid(`device ${JSON.stringify(device.name)} needs ${expected} nodes but has ${device.nodes.length}`, {
        name: device.name,
        expected,
        got: device.nodes.length,
      });
    }
    for (const net of device.nodes) {
      if (net.trim() === "") invalid(`device ${JSON.stringify(device.name)} has an empty net name`, { name: device.name });
    }
  }
}

/** Minimum pin count a device kind needs to be placed and routed. */
function expectedPinCount(kind: string): number {
  const name = SYMBOL_FOR_KIND[kind.toUpperCase()];
  if (name !== undefined) return (builtinSymbols[name]?.pins.length ?? 2);
  // Unknown / block devices: at least two terminals so routing has something to do.
  return 2;
}

/** The symbol used to place a device, or null when the kind has no builtin symbol. */
function symbolForDevice(kind: string): { name: string; sym: Symbol } | null {
  const name = SYMBOL_FOR_KIND[kind.toUpperCase()];
  if (name === undefined) return null;
  const sym = builtinSymbols[name];
  return sym === undefined ? null : { name, sym };
}

function isGround(net: string): boolean {
  return net === "0" || net.toLowerCase() === "gnd";
}

interface AscLine {
  text: string;
}

/**
 * Lay out and emit the `.asc`. Each device occupies its own column; every pin is
 * routed orthogonally (down, then across) to a per-net horizontal rail, and each
 * net carries a single FLAG (ground on `0`/`GND`, a net label otherwise).
 */
function layout(circuit: Circuit): { lines: string[]; nets: string[] } {
  const lines: string[] = ["Version 4"];

  // Collect nets in first-seen order for stable rail assignment.
  const nets: string[] = [];
  for (const device of circuit.devices) {
    for (const net of device.nodes) {
      if (!nets.includes(net)) nets.push(net);
    }
  }
  const railY = new Map<string, number>();
  nets.forEach((net, i) => railY.set(net, RAIL_TOP + i * RAIL_PITCH));

  const wires: string[] = [];
  const flags: string[] = [];
  const symbols: string[] = [];

  // A device column stride; sheet width is sized to fit all columns and rails.
  const leftMargin = 96;
  circuit.devices.forEach((device, col) => {
    const originX = leftMargin + col * COLUMN_PITCH;
    const originY = DEVICE_Y;
    const resolved = symbolForDevice(device.kind);

    if (resolved !== null) {
      symbols.push(`SYMBOL ${resolved.name} ${originX} ${originY} R0`);
      symbols.push(`SYMATTR InstName ${device.name}`);
      const attr = MODEL_KINDS.has(device.kind.toUpperCase()) ? (device.model ?? null) : (device.value ?? null);
      if (attr !== null && attr !== "") symbols.push(`SYMATTR Value ${attr}`);

      resolved.sym.pins.forEach((pin, pinIndex) => {
        const net = device.nodes[pinIndex];
        if (net === undefined) return;
        routePinToRail(originX + pin.x, originY + pin.y, net, railY, wires);
      });
    } else {
      // No builtin symbol (e.g. an X subcircuit instance): place the component
      // under its own symbol name so the file opens in LTspice with the right
      // part, and route its terminals using a generic footprint. Because that
      // symbol is not in the bundled set, the round trip cannot resolve its pin
      // order and the verifier reports the connectivity as unconfirmed.
      const symbolName = device.model ?? device.name;
      symbols.push(`SYMBOL ${symbolName} ${originX} ${originY} R0`);
      symbols.push(`SYMATTR InstName ${device.name}`);
      const attr = device.value ?? null;
      if (attr !== null && attr !== "") symbols.push(`SYMATTR Value ${attr}`);
      // Route terminals on the grid so the pins have wires even though the
      // symbol geometry is unknown; two terminals is the minimum enforced above.
      device.nodes.forEach((net, pinIndex) => {
        routePinToRail(originX + GRID, originY + pinIndex * 96, net, railY, wires);
      });
    }
  });

  // One FLAG per net, placed at the left end of its rail.
  const railLeftX = leftMargin - GRID;
  for (const net of nets) {
    const y = railY.get(net) as number;
    flags.push(`FLAG ${railLeftX} ${y} ${isGround(net) ? "0" : net}`);
  }

  const width = Math.max(880, leftMargin + circuit.devices.length * COLUMN_PITCH + 160);
  const height = Math.max(680, RAIL_TOP + nets.length * RAIL_PITCH + 96);
  lines.push(`SHEET 1 ${width} ${height}`);
  lines.push(...wires, ...flags, ...symbols);
  return { lines, nets };
}

/**
 * Route one pin to its net rail with orthogonal segments: a vertical drop from
 * the pin to the rail's y, then a horizontal run to the rail's left end. The
 * rail itself is the horizontal wire the flag sits on; the first pin on a net
 * draws it. Points are shared exactly so the converter's union-find joins them.
 */
function routePinToRail(px: number, py: number, net: string, railY: Map<string, number>, wires: string[]): void {
  const y = railY.get(net) as number;
  const railLeftX = 96 - GRID;
  // Vertical drop from the pin down to the rail level.
  if (py !== y) wires.push(`WIRE ${px} ${py} ${px} ${y}`);
  // Horizontal run from the pin's column to the rail's left end.
  if (px !== railLeftX) wires.push(`WIRE ${px} ${y} ${railLeftX} ${y}`);
}

/** Build the equivalent netlist for the circuit (Requirement 5.6). */
function toEquivalentNetlist(circuit: Circuit): Netlist {
  const devices: Device[] = circuit.devices.map((d) => ({
    kind: d.kind.toUpperCase(),
    name: d.name,
    nodes: [...d.nodes],
    value: MODEL_KINDS.has(d.kind.toUpperCase()) ? null : (d.value ?? null),
    model: MODEL_KINDS.has(d.kind.toUpperCase()) ? (d.model ?? null) : (d.kind.toUpperCase() === "X" ? (d.model ?? null) : null),
    params: {},
    raw: "",
    line: 0,
  }));
  const directives: Directive[] = circuit.directives.map((text) => {
    const match = /^(\.[a-z]+)\s*(.*)$/i.exec(text.trim());
    return { kind: (match?.[1] ?? text).toLowerCase(), args: match?.[2] ?? "", raw: text, line: 0 };
  });
  return {
    title: circuit.title === "" ? "* generated" : circuit.title,
    devices,
    models: [],
    subckts: [],
    includes: [],
    directives,
    diagnostics: [],
  };
}

/** Emit the directive TEXT lines, stacked below the sheet rails. */
function directiveLines(circuit: Circuit, startY: number): string[] {
  const out: string[] = [];
  circuit.directives.forEach((text, i) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    out.push(`TEXT 96 ${startY + i * 32} Left 2 !${trimmed}`);
  });
  return out;
}

/** The intended connectivity: for each device, its name and the multiset of nets, normalised. */
function intendedSignature(circuit: Circuit): Map<string, string> {
  const sig = new Map<string, string>();
  for (const device of circuit.devices) {
    sig.set(device.name.toLowerCase(), device.nodes.map((n) => (isGround(n) ? "0" : n)).join("|"));
  }
  return sig;
}

/**
 * Round-trip the generated bytes through the real converter and compare device
 * set and per-device net connectivity against the intended circuit
 * (Requirement 11). Returns the diffs (empty when verified).
 */
async function roundTrip(circuit: Circuit, bytes: Buffer): Promise<string[]> {
  const diffs: string[] = [];
  const schematic = readAsc(bytes);
  const converted = await toNetlist(schematic, new SymbolResolver([]));

  const intended = intendedSignature(circuit);
  const got = new Map<string, string>();
  for (const device of converted.netlist.devices) {
    got.set(device.name.toLowerCase(), device.nodes.map((n) => (isGround(n) ? "0" : n)).join("|"));
  }

  for (const [name, sig] of intended) {
    const back = got.get(name);
    if (back === undefined) {
      diffs.push(`device ${name} is missing after round trip`);
      continue;
    }
    if (back !== sig) diffs.push(`device ${name} connectivity changed: intended [${sig}] but got [${back}]`);
  }
  for (const name of got.keys()) {
    if (!intended.has(name)) diffs.push(`device ${name} appeared after round trip but was not intended`);
  }
  // Any converter warning about an unresolved symbol means the geometry's
  // connectivity could not be confirmed.
  for (const warning of converted.warnings) {
    if (/unknown symbol|cannot resolve/i.test(warning)) diffs.push(`round trip warning: ${warning}`);
  }
  return diffs;
}

/** Generate an LTspice-openable `.asc` and verify it by round trip (Requirement 5, 11, 18.1). */
export async function generateAsc(circuit: Circuit, options: GenerateOptions = {}): Promise<GenerateResult> {
  validateCircuit(circuit);

  const { lines, nets } = layout(circuit);
  const dirStartY = RAIL_TOP + nets.length * RAIL_PITCH + 48;
  const all = [...lines, ...directiveLines(circuit, dirStartY)];
  // LTspice convention: CRLF line endings, trailing CRLF.
  const text = all.join("\r\n") + "\r\n";
  const bytes = Buffer.from(text, "utf8");

  const netlistText = emit(toEquivalentNetlist(circuit));

  const diffs = await roundTrip(circuit, bytes);
  const verified = diffs.length === 0;
  if (!verified && options.strict === true) {
    throw new ToolError("GENERATE_UNVERIFIED", `the generated schematic did not round-trip to the intended connectivity`, { diffs });
  }

  return {
    bytes,
    encoding: "utf-8",
    netlistText,
    verified,
    diffs,
    counts: { devices: circuit.devices.length, nets: nets.length },
  };
}
