/**
 * LTspice `.asc` schematic and `.asy` symbol reader (Requirement 3), plus the
 * schematic-to-netlist converter (Requirement 4, in `./ascnet.ts`-free form here).
 *
 * LTspice files are line-based with a keyword grammar. Encoding varies by build
 * (UTF-16LE with a BOM historically, UTF-8 more recently) and lines end CRLF;
 * `decodeText` sniffs the encoding from a BOM / null-byte heuristic and reports
 * which it used. Keywords the reader does not model are retained as raw entries
 * with a diagnostic rather than dropped (Requirement 3.4).
 */

/** How the bytes were decoded, reported back to the caller (Requirement 3.3). */
export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be";

export interface DecodeResult {
  text: string;
  encoding: Encoding;
}

/** A placed component on an `.asc` sheet. */
export interface Component {
  symbol: string;
  instName: string | null;
  value: string | null;
  x: number;
  y: number;
  /** Rotation in degrees (0/90/180/270). */
  rotation: number;
  /** True when the orientation is mirrored (LTspice `M<deg>`). */
  mirror: boolean;
  /** Every SYMATTR key/value for the component. */
  attributes: Record<string, string>;
}

export interface Wire {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A FLAG/IOPIN net label. The net `0` is ground. */
export interface Flag {
  x: number;
  y: number;
  net: string;
}

/** An on-sheet TEXT directive: `spice` for `!...`, `comment` for `;...`. */
export interface SheetDirective {
  kind: "spice" | "comment";
  text: string;
  x: number;
  y: number;
}

/** A keyword line the reader does not model, kept verbatim (Requirement 3.4). */
export interface RawEntry {
  keyword: string;
  text: string;
  line: number;
}

export interface Diagnostic {
  line: number;
  text: string;
  reason: string;
}

export interface Schematic {
  version: string | null;
  sheet: { index: number; width: number; height: number } | null;
  components: Component[];
  wires: Wire[];
  flags: Flag[];
  directives: SheetDirective[];
  raw: RawEntry[];
  diagnostics: Diagnostic[];
  encoding: Encoding;
}

/** A pin on a symbol, carrying its SPICE order and coordinates. */
export interface Pin {
  name: string;
  order: number;
  x: number;
  y: number;
}

/** A drawing primitive on a symbol (LINE/RECTANGLE/CIRCLE/ARC/...). */
export interface Primitive {
  kind: string;
  args: string;
}

export interface Symbol {
  symbolType: string | null;
  pins: Pin[];
  primitives: Primitive[];
  attributes: Record<string, string>;
  raw: RawEntry[];
  diagnostics: Diagnostic[];
}

/** Decode `.asc`/`.asy` bytes, sniffing the encoding and normalising to LF (Requirement 3.3). */
export function decodeText(bytes: Buffer): DecodeResult {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: normalise(bytes.subarray(2).toString("utf16le")), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: normalise(swap16(bytes.subarray(2)).toString("utf16le")), encoding: "utf-16be" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: normalise(bytes.subarray(3).toString("utf8")), encoding: "utf-8-bom" };
  }
  // No BOM: detect UTF-16LE by a run of ASCII bytes interleaved with nulls.
  if (looksUtf16le(bytes)) {
    return { text: normalise(bytes.toString("utf16le")), encoding: "utf-16le" };
  }
  return { text: normalise(bytes.toString("utf8")), encoding: "utf-8" };
}

function normalise(text: string): string {
  return text.replace(/\r\n|\r/g, "\n");
}

function swap16(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  if (out.length % 2 === 1) return out;
  for (let i = 0; i + 1 < out.length; i += 2) {
    const t = out[i] ?? 0;
    out[i] = out[i + 1] ?? 0;
    out[i + 1] = t;
  }
  return out;
}

/** Heuristic for a BOM-less UTF-16LE file: ASCII code points stored as `XX 00`. */
function looksUtf16le(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return false;
  let nullHigh = 0;
  const sample = Math.min(bytes.length, 64);
  for (let i = 0; i + 1 < sample; i += 2) {
    if (bytes[i + 1] === 0x00 && (bytes[i] ?? 0) !== 0x00) nullHigh++;
  }
  return nullHigh >= sample / 4;
}

/** Parse an LTspice symbol orientation token (`R0`, `R90`, `M0`, `M270`, ...). */
function parseOrientation(token: string | undefined): { rotation: number; mirror: boolean } {
  if (token === undefined) return { rotation: 0, mirror: false };
  const match = /^([RM])(\d+)$/i.exec(token);
  if (!match) return { rotation: 0, mirror: false };
  return { rotation: Number(match[2]), mirror: (match[1] ?? "R").toUpperCase() === "M" };
}

function num(token: string | undefined): number {
  const value = Number(token);
  return Number.isFinite(value) ? value : 0;
}

/** Read an `.asc` schematic (Requirement 3.1). */
export function readAsc(bytes: Buffer): Schematic {
  const { text, encoding } = decodeText(bytes);
  const schematic: Schematic = {
    version: null,
    sheet: null,
    components: [],
    wires: [],
    flags: [],
    directives: [],
    raw: [],
    diagnostics: [],
    encoding,
  };

  let current: Component | null = null;
  const commit = () => {
    if (current !== null) {
      schematic.components.push(current);
      current = null;
    }
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = i + 1;
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    const tokens = trimmed.split(/\s+/);
    const keyword = tokens[0] ?? "";

    switch (keyword.toUpperCase()) {
      case "VERSION":
        commit();
        schematic.version = tokens.slice(1).join(" ");
        break;
      case "SHEET":
        commit();
        schematic.sheet = { index: num(tokens[1]), width: num(tokens[2]), height: num(tokens[3]) };
        break;
      case "WIRE":
        commit();
        schematic.wires.push({ x1: num(tokens[1]), y1: num(tokens[2]), x2: num(tokens[3]), y2: num(tokens[4]) });
        break;
      case "FLAG":
      case "IOPIN":
        commit();
        schematic.flags.push({ x: num(tokens[1]), y: num(tokens[2]), net: tokens[3] ?? "" });
        break;
      case "SYMBOL": {
        commit();
        const orient = parseOrientation(tokens[4]);
        current = {
          symbol: tokens[1] ?? "",
          instName: null,
          value: null,
          x: num(tokens[2]),
          y: num(tokens[3]),
          rotation: orient.rotation,
          mirror: orient.mirror,
          attributes: {},
        };
        break;
      }
      case "SYMATTR": {
        if (current === null) {
          schematic.raw.push({ keyword, text: trimmed, line });
          schematic.diagnostics.push({ line, text: trimmed, reason: "SYMATTR with no preceding SYMBOL" });
          break;
        }
        const key = tokens[1] ?? "";
        const value = trimmed.slice(trimmed.indexOf(key) + key.length).trim();
        current.attributes[key] = value;
        if (key === "InstName") current.instName = value;
        if (key === "Value") current.value = value;
        break;
      }
      case "TEXT": {
        commit();
        schematic.directives.push(parseText(trimmed, num(tokens[1]), num(tokens[2])));
        break;
      }
      default:
        commit();
        schematic.raw.push({ keyword, text: trimmed, line });
        schematic.diagnostics.push({ line, text: trimmed, reason: `unmodelled .asc keyword ${JSON.stringify(keyword)}` });
    }
  }
  commit();
  return schematic;
}

/** Parse a TEXT line's payload after the position/justify/size prefix. */
function parseText(trimmed: string, x: number, y: number): SheetDirective {
  // TEXT <x> <y> <Justify> <Size> <!|;><payload>
  const bang = trimmed.indexOf("!");
  const semi = trimmed.indexOf(";");
  if (bang >= 0 && (semi < 0 || bang < semi)) {
    return { kind: "spice", text: trimmed.slice(bang + 1).trim(), x, y };
  }
  if (semi >= 0) {
    return { kind: "comment", text: trimmed.slice(semi + 1).trim(), x, y };
  }
  return { kind: "comment", text: "", x, y };
}

/** Read an `.asy` symbol file (Requirement 3.2): pins in SPICE order, primitives, attributes. */
export function readAsy(bytes: Buffer): Symbol {
  const { text } = decodeText(bytes);
  const sym: Symbol = {
    symbolType: null,
    pins: [],
    primitives: [],
    attributes: {},
    raw: [],
    diagnostics: [],
  };

  interface PartialPin {
    x: number;
    y: number;
    name: string | null;
    order: number | null;
  }
  let pin: PartialPin | null = null;
  const commitPin = () => {
    if (pin !== null) {
      sym.pins.push({ name: pin.name ?? String(sym.pins.length + 1), order: pin.order ?? sym.pins.length + 1, x: pin.x, y: pin.y });
      pin = null;
    }
  };

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = i + 1;
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    const tokens = trimmed.split(/\s+/);
    const keyword = tokens[0] ?? "";

    switch (keyword.toUpperCase()) {
      case "VERSION":
        break;
      case "SYMBOLTYPE":
        commitPin();
        sym.symbolType = tokens[1] ?? null;
        break;
      case "LINE":
      case "RECTANGLE":
      case "CIRCLE":
      case "ARC":
      case "TEXT":
      case "WINDOW":
      case "ARROW":
        commitPin();
        sym.primitives.push({ kind: keyword.toUpperCase(), args: tokens.slice(1).join(" ") });
        break;
      case "PIN":
        commitPin();
        pin = { x: num(tokens[1]), y: num(tokens[2]), name: null, order: null };
        break;
      case "PINATTR": {
        if (pin === null) {
          sym.raw.push({ keyword, text: trimmed, line });
          sym.diagnostics.push({ line, text: trimmed, reason: "PINATTR with no preceding PIN" });
          break;
        }
        const attr = tokens[1] ?? "";
        const value = tokens.slice(2).join(" ");
        if (attr === "PinName") pin.name = value;
        else if (attr === "SpiceOrder") pin.order = num(value);
        break;
      }
      case "SYMATTR": {
        commitPin();
        const key = tokens[1] ?? "";
        sym.attributes[key] = tokens.slice(2).join(" ");
        break;
      }
      default:
        commitPin();
        sym.raw.push({ keyword, text: trimmed, line });
        sym.diagnostics.push({ line, text: trimmed, reason: `unmodelled .asy keyword ${JSON.stringify(keyword)}` });
    }
  }
  commitPin();
  sym.pins.sort((a, b) => a.order - b.order);
  return sym;
}
