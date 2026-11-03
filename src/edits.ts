/**
 * Netlist text helpers (Requirement 12). Each helper edits netlist *text* and
 * returns the edited text (or an absent-target diagnostic); none ever runs a
 * simulation. Edits are line-based so the rest of the deck, including comments
 * and formatting, is preserved: new directives are inserted just before the
 * final `.end` (or appended when there is none), and an existing directive for
 * the same target is replaced in place.
 */

import { parse } from "./netlist.js";

/** The outcome of a text helper: the (possibly) edited text and whether it changed. */
export interface EditResult {
  /** The edited netlist text, or the original when `changed` is false. */
  text: string;
  /** True when the helper altered the text. */
  changed: boolean;
  /** Set when the target was absent or the request was inconsistent; text is then unchanged. */
  diagnostic: string | null;
}

/** A `.meas` specification for `addMeas`. */
export interface MeasSpec {
  /** The analysis the measurement runs under (`tran`, `ac`, `dc`, `op`, `noise`). */
  analysis: string;
  /** The measurement result name. */
  name: string;
  /** The measurement expression after the name (e.g. `FIND v(out) AT=1m`, `MAX v(out)`). */
  expr: string;
}

/** A `.step` specification for `addStep`. */
export interface StepSpec {
  /** The parameter name swept. */
  param: string;
  /** The list of values to sweep. */
  values: string[];
  /** The default `.param` value (used when the parameter is first defined). */
  default: string;
}

/** A parameterize request for `parameterize`. */
export interface ParamSpec {
  /** The device instance whose value is replaced (e.g. `R1`). */
  device: string;
  /** The parameter name to introduce. */
  name: string;
}

function unchanged(text: string, diagnostic: string): EditResult {
  return { text, changed: false, diagnostic };
}

/** Split text into lines while remembering whether it ended with a trailing newline. */
function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const trailingNewline = /\n$/.test(text);
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/** The index of the last `.end` line (not `.ends`), or -1 when there is none. */
function endIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*\.end\s*$/i.test(lines[i] ?? "")) return i;
  }
  return -1;
}

/** Insert `directive` just before the final `.end`, or append it when there is none. */
function insertBeforeEnd(lines: string[], directive: string): string[] {
  const at = endIndex(lines);
  const copy = [...lines];
  if (at < 0) copy.push(directive);
  else copy.splice(at, 0, directive);
  return copy;
}

/**
 * Insert or update a `.meas` directive (Requirement 12.1). A `.meas` with the
 * same analysis and name is replaced in place; otherwise the new directive is
 * inserted before `.end`. Never simulates.
 */
export function addMeas(text: string, spec: MeasSpec): EditResult {
  const analysis = spec.analysis.trim();
  const name = spec.name.trim();
  const expr = spec.expr.trim();
  if (analysis === "" || name === "" || expr === "") {
    return unchanged(text, "addMeas needs a non-empty analysis, name, and expression");
  }
  const directive = `.meas ${analysis} ${name} ${expr}`;
  const { lines, trailingNewline } = splitLines(text);

  // Replace an existing `.meas <analysis> <name> ...` (case-insensitive).
  const re = new RegExp(`^\\s*\\.meas(?:ure)?\\s+${escapeRe(analysis)}\\s+${escapeRe(name)}\\b`, "i");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) {
      const copy = [...lines];
      copy[i] = directive;
      return { text: joinLines(copy, trailingNewline), changed: true, diagnostic: null };
    }
  }

  return { text: joinLines(insertBeforeEnd(lines, directive), trailingNewline), changed: true, diagnostic: null };
}

/**
 * Insert or update a `.step` sweep plus its `.param` default (Requirement 12.2).
 * An existing `.step param <param> ...` is replaced in place; the `.param`
 * default is added only when the parameter is not already defined. Never
 * simulates.
 */
export function addStep(text: string, spec: StepSpec): EditResult {
  const param = spec.param.trim();
  const values = spec.values.map((v) => v.trim()).filter((v) => v !== "");
  if (param === "") return unchanged(text, "addStep needs a parameter name");
  if (values.length === 0) return unchanged(text, `addStep for ${JSON.stringify(spec.param)} needs at least one value`);

  const stepDirective = `.step param ${param} list ${values.join(" ")}`;
  const { lines, trailingNewline } = splitLines(text);

  // Replace an existing `.step param <param> ...`.
  const stepRe = new RegExp(`^\\s*\\.step\\s+param\\s+${escapeRe(param)}\\b`, "i");
  let replaced = false;
  let out = lines.map((line) => {
    if (!replaced && stepRe.test(line)) {
      replaced = true;
      return stepDirective;
    }
    return line;
  });

  // Add the `.param` default only when the parameter is not already defined.
  const hasParam = lines.some((line) => new RegExp(`^\\s*\\.param\\b[^\\n]*\\b${escapeRe(param)}\\s*=`, "i").test(line));
  if (!hasParam) out = insertBeforeEnd(out, `.param ${param}=${spec.default.trim()}`);
  if (!replaced) out = insertBeforeEnd(out, stepDirective);

  return { text: joinLines(out, trailingNewline), changed: true, diagnostic: null };
}

/**
 * Replace a device's literal value with a `{name}` reference and add a
 * `.param name=<value>` carrying the original value as the default
 * (Requirement 12.3). An absent device, or one with no scalar value (a
 * model-based device), yields a diagnostic and leaves the text unchanged.
 */
export function parameterize(text: string, spec: ParamSpec): EditResult {
  const device = spec.device.trim();
  const name = spec.name.trim();
  if (device === "" || name === "") return unchanged(text, "parameterize needs a device and a parameter name");

  const netlist = parse(text);
  const target = netlist.devices.find((d) => d.name.toLowerCase() === device.toLowerCase());
  if (target === undefined) return unchanged(text, `device ${JSON.stringify(device)} is not present in the netlist`);
  if (target.value === null || target.value.trim() === "") {
    return unchanged(text, `device ${JSON.stringify(device)} has no scalar value to parameterize`);
  }
  const originalValue = target.value.trim();

  const { lines, trailingNewline } = splitLines(text);
  const deviceRe = new RegExp(`^(\\s*${escapeRe(target.name)}\\s+)([\\s\\S]*)$`, "i");
  let changedLine = false;
  const out = lines.map((line) => {
    if (changedLine) return line;
    const match = deviceRe.exec(line);
    if (match === null) return line;
    changedLine = true;
    // Replace the first occurrence of the value token in the device's argument tail.
    const head = match[1] ?? "";
    const tail = match[2] ?? "";
    const replacedTail = replaceFirstToken(tail, originalValue, `{${name}}`);
    return `${head}${replacedTail}`;
  });
  if (!changedLine) {
    // The parser saw the device but no raw line matched (e.g. a continuation); be safe.
    return unchanged(text, `could not locate the source line for device ${JSON.stringify(device)}`);
  }

  const withParam = insertBeforeEnd(out, `.param ${name}=${originalValue}`);
  return { text: joinLines(withParam, trailingNewline), changed: true, diagnostic: null };
}

/** Replace the first whole-token occurrence of `token` in `haystack` with `replacement`. */
function replaceFirstToken(haystack: string, token: string, replacement: string): string {
  const re = new RegExp(`(^|\\s)${escapeRe(token)}(?=\\s|$)`);
  return haystack.replace(re, (_m, lead: string) => `${lead}${replacement}`);
}

/** Escape a string for use as a literal inside a RegExp. */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
