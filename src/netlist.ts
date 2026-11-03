/**
 * SPICE netlist parser, validator, and emitter (Requirement 2). Pure text in,
 * structured model out, with per-line diagnostics. `.include`/`.lib` references
 * are recorded verbatim; the tool layer resolves and confines them to the roots.
 *
 * The grammar is the common SPICE/LTspice line form: the first line is the
 * title, `*` lines and `;`/inline comments are dropped, a `+` line continues the
 * previous one, device lines begin with a letter naming the device kind, and
 * `.`-directives carry analyses, models, params, and includes. Devices inside a
 * `.subckt`/`.ends` block are kept with the subcircuit, not the top level.
 */

/** A single device instance line (R1, V1, M1, X1, ...). */
export interface Device {
  /** Upper-case device letter: R, C, L, V, I, D, Q, M, J, X, E, F, G, H, B, S, W, K, T, ... */
  kind: string;
  /** Instance name exactly as written (e.g. `R1`). */
  name: string;
  /** Connected nodes in written order. */
  nodes: string[];
  /** The value token for a two-terminal passive/source, when the trailing token is not a model. */
  value: string | null;
  /** The referenced model or subcircuit name, when present. */
  model: string | null;
  /** `key=value` parameters parsed from the line. */
  params: Record<string, string>;
  /** Raw device line (continuations joined). */
  raw: string;
  /** 1-based source line of the device's first physical line. */
  line: number;
}

/** A `.model name type (params...)` statement. */
export interface ModelStatement {
  name: string;
  type: string;
  params: Record<string, string>;
  raw: string;
  line: number;
}

/** A `.subckt name ports... ... .ends` block. */
export interface Subckt {
  name: string;
  ports: string[];
  devices: Device[];
  models: ModelStatement[];
  raw: string;
  line: number;
}

/** A `.include`/`.lib` reference, recorded verbatim (resolution happens at the tool layer). */
export interface IncludeRef {
  /** `.include` or `.lib`. */
  kind: ".include" | ".lib";
  /** The referenced file path as written. */
  path: string;
  /** For `.lib`, the optional section name. */
  section: string | null;
  line: number;
}

/** A control/analysis directive (`.tran`, `.ac`, `.op`, `.dc`, `.noise`, `.step`, `.meas`, `.param`, ...). */
export interface Directive {
  /** Lower-case directive keyword including the dot (e.g. `.tran`). */
  kind: string;
  /** The directive text after the keyword. */
  args: string;
  raw: string;
  line: number;
}

/** A per-line parse diagnostic: a line we could not classify, kept non-fatal. */
export interface Diagnostic {
  line: number;
  text: string;
  reason: string;
}

/** The structured netlist returned by `parse`. */
export interface Netlist {
  title: string;
  devices: Device[];
  models: ModelStatement[];
  subckts: Subckt[];
  includes: IncludeRef[];
  directives: Directive[];
  diagnostics: Diagnostic[];
}

/** A validation finding (Requirement 2.5): structural issues, never mutating the netlist. */
export interface ValidationIssue {
  rule: "no-ground" | "single-connection" | "floating-node" | "duplicate-name" | "missing-model" | "missing-subckt";
  severity: "error" | "warning";
  message: string;
}

interface PhysicalLine {
  text: string;
  line: number;
}

/** Fold `+` continuation lines into their logical line, recording the starting line number. */
function logicalLines(text: string): PhysicalLine[] {
  const rawLines = text.split(/\r\n|\r|\n/);
  const out: PhysicalLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const current = rawLines[i] ?? "";
    if (current.startsWith("+")) {
      const prev = out[out.length - 1];
      const cont = current.slice(1).trim();
      if (prev !== undefined) {
        prev.text = `${prev.text} ${cont}`.trim();
        continue;
      }
      // A continuation with nothing before it: keep it as its own line.
      out.push({ text: cont, line: i + 1 });
      continue;
    }
    out.push({ text: current, line: i + 1 });
  }
  return out;
}

/** Strip an inline `;` comment and trailing whitespace. (`$` comments are left to callers.) */
function stripInlineComment(text: string): string {
  const semi = text.indexOf(";");
  return (semi >= 0 ? text.slice(0, semi) : text).trimEnd();
}

/** Split a line into whitespace-separated tokens, preserving `(...)` groups as single tokens. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/** Pull `key=value` tokens out of a token list, returning the remaining positional tokens and the params. */
function extractParams(tokens: string[]): { positional: string[]; params: Record<string, string> } {
  const positional: string[] = [];
  const params: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      params[key] = value;
    } else {
      positional.push(token);
    }
  }
  return { positional, params };
}

/** How many leading positional tokens (after the instance name) are node connections, by device kind. */
const NODE_COUNTS: Record<string, number> = {
  R: 2,
  C: 2,
  L: 2,
  V: 2,
  I: 2,
  D: 2,
  E: 4,
  G: 4,
  F: 2,
  H: 2,
  B: 2,
  S: 4,
  W: 2,
  Q: 3,
  J: 3,
  Z: 3,
  M: 4,
};

/** Device letters whose trailing positional token names a model/subckt rather than a value. */
const MODEL_DEVICES = new Set(["Q", "J", "Z", "M", "D", "S", "W"]);

function parseDevice(text: string, line: number): Device {
  const tokens = tokenize(text);
  const name = tokens[0] ?? "";
  const kind = name.charAt(0).toUpperCase();
  const rest = tokens.slice(1);
  const { positional, params } = extractParams(rest);

  if (kind === "X") {
    // X<name> node* subckt : the last positional token is the subcircuit name.
    const model = positional.length > 0 ? (positional[positional.length - 1] ?? null) : null;
    const nodes = positional.slice(0, Math.max(0, positional.length - 1));
    return { kind, name, nodes, value: null, model, params, raw: text, line };
  }

  const nodeCount = NODE_COUNTS[kind] ?? 2;
  const nodes = positional.slice(0, nodeCount);
  const tail = positional.slice(nodeCount);
  let value: string | null = null;
  let model: string | null = null;
  if (MODEL_DEVICES.has(kind)) {
    model = tail[0] ?? null;
  } else {
    value = tail.length > 0 ? tail.join(" ") : null;
  }
  return { kind, name, nodes, value, model, params, raw: text, line };
}

function parseModel(text: string, line: number): ModelStatement {
  // .model name type (p1=v1 p2=v2) | .model name type p1=v1
  const body = text.replace(/^\.model\s+/i, "");
  const tokens = tokenize(body);
  const name = tokens[0] ?? "";
  let type = tokens[1] ?? "";
  // The type may be followed immediately by a parenthesised param group, e.g. NMOS(level=1).
  const paren = type.indexOf("(");
  let paramText = tokens.slice(2).join(" ");
  if (paren >= 0) {
    paramText = `${type.slice(paren)} ${paramText}`.trim();
    type = type.slice(0, paren);
  }
  const cleaned = paramText.replace(/[()]/g, " ").trim();
  const { params } = extractParams(tokenize(cleaned));
  return { name, type: type.toUpperCase(), params, raw: text, line };
}

function parseInclude(kind: ".include" | ".lib", text: string, line: number): IncludeRef {
  const body = text.replace(/^\.\w+\s+/i, "");
  const tokens = tokenize(body);
  const first = tokens[0] ?? "";
  const path = first.replace(/^["']|["']$/g, "");
  const section = kind === ".lib" && tokens.length > 1 ? (tokens[1] ?? null) : null;
  return { kind, path, section, line };
}

/** Parse a SPICE netlist (path content or inline text) into the structured model (Requirement 2). */
export function parse(text: string): Netlist {
  const netlist: Netlist = {
    title: "",
    devices: [],
    models: [],
    subckts: [],
    includes: [],
    directives: [],
    diagnostics: [],
  };

  const lines = logicalLines(text);
  let titleTaken = false;
  let subckt: Subckt | null = null;

  for (let idx = 0; idx < lines.length; idx++) {
    const entry = lines[idx];
    if (entry === undefined) continue;
    const { line } = entry;
    const trimmed = entry.text.trim();

    if (!titleTaken) {
      // The first physical line is the title, even when blank or comment-like.
      netlist.title = trimmed;
      titleTaken = true;
      continue;
    }

    if (trimmed === "" || trimmed.startsWith("*")) continue;
    const content = stripInlineComment(trimmed);
    if (content === "") continue;

    const lower = content.toLowerCase();

    if (lower.startsWith(".subckt")) {
      const tokens = tokenize(content.replace(/^\.subckt\s+/i, ""));
      const name = tokens[0] ?? "";
      const ports = tokens.slice(1).filter((t) => t.indexOf("=") < 0);
      subckt = { name, ports, devices: [], models: [], raw: content, line };
      continue;
    }
    if (lower.startsWith(".ends") || lower === ".end") {
      if (lower.startsWith(".ends") && subckt !== null) {
        netlist.subckts.push(subckt);
        subckt = null;
      }
      continue;
    }

    if (content.startsWith(".")) {
      if (lower.startsWith(".model")) {
        const model = parseModel(content, line);
        if (subckt !== null) subckt.models.push(model);
        else netlist.models.push(model);
        continue;
      }
      if (lower.startsWith(".include") || lower.startsWith(".inc ")) {
        netlist.includes.push(parseInclude(".include", content, line));
        continue;
      }
      if (lower.startsWith(".lib")) {
        netlist.includes.push(parseInclude(".lib", content, line));
        continue;
      }
      const match = /^(\.[a-z]+)\s*(.*)$/i.exec(content);
      if (match) {
        netlist.directives.push({ kind: (match[1] ?? "").toLowerCase(), args: match[2] ?? "", raw: content, line });
      } else {
        netlist.diagnostics.push({ line, text: content, reason: "unrecognized directive" });
      }
      continue;
    }

    // A device line begins with a letter.
    if (/^[A-Za-z]/.test(content)) {
      const device = parseDevice(content, line);
      if (device.nodes.length === 0 && device.value === null && device.model === null) {
        netlist.diagnostics.push({ line, text: content, reason: "device line has no nodes" });
        continue;
      }
      if (subckt !== null) subckt.devices.push(device);
      else netlist.devices.push(device);
      continue;
    }

    netlist.diagnostics.push({ line, text: content, reason: "line does not start with a device letter or a directive" });
  }

  if (subckt !== null) netlist.subckts.push(subckt);
  return netlist;
}

/** Validate structural properties without modifying the netlist (Requirement 2.5). */
export function validate(netlist: Netlist): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Node degree across top-level devices.
  const degree = new Map<string, number>();
  for (const device of netlist.devices) {
    for (const node of device.nodes) {
      degree.set(node, (degree.get(node) ?? 0) + 1);
    }
  }

  const hasGround = degree.has("0") || degree.has("gnd") || degree.has("GND");
  if (!hasGround && netlist.devices.length > 0) {
    issues.push({ rule: "no-ground", severity: "error", message: "no ground node (0) found in the netlist" });
  }

  for (const [node, count] of degree) {
    if (node === "0" || node.toLowerCase() === "gnd") continue;
    if (count < 2) {
      issues.push({
        rule: "single-connection",
        severity: "warning",
        message: `node ${JSON.stringify(node)} is connected to only one device`,
      });
    }
  }

  // Duplicate instance names (top-level).
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const device of netlist.devices) {
    const key = device.name.toLowerCase();
    if (seen.has(key) && !reported.has(key)) {
      issues.push({ rule: "duplicate-name", severity: "error", message: `duplicate instance name ${JSON.stringify(device.name)}` });
      reported.add(key);
    }
    seen.add(key);
  }

  // Missing models and subcircuits.
  const modelNames = new Set<string>();
  for (const model of netlist.models) modelNames.add(model.name.toLowerCase());
  const subcktNames = new Set<string>();
  for (const sub of netlist.subckts) subcktNames.add(sub.name.toLowerCase());

  for (const device of netlist.devices) {
    if (device.kind === "X") {
      if (device.model !== null && !subcktNames.has(device.model.toLowerCase())) {
        issues.push({ rule: "missing-subckt", severity: "warning", message: `${device.name} references undefined subcircuit ${JSON.stringify(device.model)}` });
      }
    } else if (MODEL_DEVICES.has(device.kind) && device.model !== null && !modelNames.has(device.model.toLowerCase())) {
      issues.push({ rule: "missing-model", severity: "warning", message: `${device.name} references undefined model ${JSON.stringify(device.model)}` });
    }
  }

  return issues;
}

/** Emit a netlist back to text. Device order and directives are preserved; not a byte round-trip. */
export function emit(netlist: Netlist): string {
  const lines: string[] = [netlist.title];
  for (const include of netlist.includes) {
    lines.push(include.kind === ".lib" && include.section !== null ? `.lib ${include.path} ${include.section}` : `${include.kind} ${include.path}`);
  }
  for (const model of netlist.models) lines.push(emitModel(model));
  for (const sub of netlist.subckts) {
    lines.push(`.subckt ${sub.name} ${sub.ports.join(" ")}`.trimEnd());
    for (const model of sub.models) lines.push(emitModel(model));
    for (const device of sub.devices) lines.push(emitDevice(device));
    lines.push(".ends");
  }
  for (const device of netlist.devices) lines.push(emitDevice(device));
  for (const directive of netlist.directives) lines.push(`${directive.kind} ${directive.args}`.trimEnd());
  lines.push(".end");
  return `${lines.join("\n")}\n`;
}

function emitDevice(device: Device): string {
  const parts = [device.name, ...device.nodes];
  if (device.model !== null) parts.push(device.model);
  if (device.value !== null) parts.push(device.value);
  for (const [key, value] of Object.entries(device.params)) parts.push(`${key}=${value}`);
  return parts.join(" ");
}

function emitModel(model: ModelStatement): string {
  const params = Object.entries(model.params)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  return `.model ${model.name} ${model.type}${params === "" ? "" : ` (${params})`}`;
}
