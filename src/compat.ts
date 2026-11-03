/**
 * LTspice compatibility layer (Requirement 15). Builds the per-run
 * `.spiceinit` control settings that put ngspice into LTspice mode
 * (`set ngbehavior=lt`, with the `ltps`/`ltpsa` variants when PSpice-style
 * libraries appear), and inspects a parsed netlist for LTspice-only constructs:
 * the safe ones are translated and recorded, the rest raise
 * `UNSUPPORTED_LTSPICE_FEATURE` naming the construct and its 1-based line.
 *
 * It never touches the user's global `~/.spiceinit`: the settings here are
 * written by the runner into a file inside the freshly created per-run
 * directory, which ngspice reads as its local config (verified against ngspice
 * 44.2; see docs/compatibility.md). Items the design marked uncertain were
 * checked against the real engine and pinned by the compatibility corpus.
 */

import { ToolError } from "./errors.js";
import type { Device, Directive, Netlist } from "./netlist.js";

/** A construct we translated for ngspice, kept as a diagnostic the caller surfaces. */
export interface Translation {
  /** The construct name (device kind/name or directive keyword). */
  construct: string;
  /** 1-based source line, when known. */
  line: number | null;
  /** What we did, in a sentence. */
  message: string;
}

/** The outcome of preparing a netlist for an ngspice run under LTspice mode. */
export interface CompatPrep {
  /** Contents of the per-run `.spiceinit` the runner writes into the run dir. */
  spiceinit: string;
  /** ngbehavior mode token actually used (`lt`, `ltps`, or `ltpsa`). */
  mode: "lt" | "ltps" | "ltpsa";
  /** Safe translations applied, each recorded for the caller. */
  translations: Translation[];
}

/**
 * Directive keywords that have no ngspice equivalent and cannot be translated;
 * raising an unsupported error is the only correct action (design compat table,
 * certainty high). `.step` is excluded here because it is emulated (task 10).
 */
const UNSUPPORTED_DIRECTIVES = new Set([".machine", ".net", ".wave"]);

/**
 * LTspice `.options` keys ngspice ignores or names differently; dropped with a
 * recorded note rather than failing (design compat table, certainty medium).
 */
const DROPPED_OPTION_KEYS = new Set(["plotwinsize", "numdgt", "measdgt", "nomarch"]);

/**
 * A-device special functions (LTspice `A` devices) ngspice does not have. Any
 * `A`-prefixed device is unsupported (design compat table, certainty high).
 */
export const COMPAT_UNSUPPORTED: readonly string[] = [
  "A-devices (DIFFSCHMITT, SAMPLEHOLD, MODULATE, ...)",
  ".machine state machines",
  ".net network parameters",
  ".wave WAV export",
  "encrypted/proprietary vendor .lib models",
];

/** True when the netlist pulls in a PSpice-style library (selects the ltpsa variant). */
function usesPspiceLibraries(netlist: Netlist): boolean {
  return netlist.includes.some((inc) => /pspice|\.lib$/i.test(inc.path) && /pspice/i.test(inc.path));
}

/** Build the per-run `.spiceinit` body. `libKinds` flags any PSpice-style libs seen. */
export function spiceinitContents(libKinds: string[]): string {
  const mode = libKinds.some((k) => /pspice/i.test(k)) ? "ltpsa" : "lt";
  return [
    "* OpenSPICE per-run compatibility settings. Never the user's global config.",
    `set ngbehavior=${mode}`,
    "",
  ].join("\n");
}

function unsupported(construct: string, line: number | null, detail: string): never {
  throw new ToolError(
    "UNSUPPORTED_LTSPICE_FEATURE",
    `${construct}${line !== null ? ` on line ${line}` : ""}: ${detail}`,
    { construct, line, detail },
  );
}

/** Detect LTspice-only device constructs, translating or rejecting each (Requirement 15.2, 15.3). */
function inspectDevices(devices: Device[], translations: Translation[]): void {
  for (const device of devices) {
    if (device.kind === "A") {
      unsupported(
        `A-device ${device.name}`,
        device.line,
        "LTspice special-function A-devices (e.g. DIFFSCHMITT, SAMPLEHOLD, MODULATE) have no ngspice equivalent; " +
          "supply an equivalent subcircuit built from supported primitives instead",
      );
    }
    // Rser/Cpar instance params on L/C/V: lt-mode support is partial; warn.
    if ((device.kind === "L" || device.kind === "C" || device.kind === "V") && ("rser" in lower(device.params) || "cpar" in lower(device.params))) {
      translations.push({
        construct: device.name,
        line: device.line,
        message: `${device.name}: LTspice Rser/Cpar instance parameters are passed through to ngspice lt mode, whose support is partial; verify the result`,
      });
    }
  }
}

function lower(params: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k.toLowerCase()] = v;
  return out;
}

/** Detect LTspice-only directives, translating or rejecting each (Requirement 15.2, 15.3). */
function inspectDirectives(directives: Directive[], translations: Translation[]): void {
  for (const directive of directives) {
    const kind = directive.kind.toLowerCase();
    if (UNSUPPORTED_DIRECTIVES.has(kind)) {
      unsupported(
        kind,
        directive.line,
        `${kind} has no ngspice equivalent in LTspice compatibility mode and cannot be translated safely`,
      );
    }
    if (kind === ".options") {
      const dropped = directive.args
        .split(/\s+/)
        .map((tok) => tok.split("=")[0]?.toLowerCase() ?? "")
        .filter((key) => DROPPED_OPTION_KEYS.has(key));
      if (dropped.length > 0) {
        translations.push({
          construct: ".options",
          line: directive.line,
          message: `.options ${dropped.join(", ")} is LTspice-specific and dropped for ngspice (no equivalent setting)`,
        });
      }
    }
  }
}

/** Reject encrypted/proprietary vendor libraries, which ngspice cannot read (Requirement 15.5). */
function inspectIncludes(netlist: Netlist): void {
  for (const inc of netlist.includes) {
    if (/\.(enc|encrypted)$/i.test(inc.path) || /encrypted/i.test(inc.path)) {
      unsupported(
        `${inc.kind} ${inc.path}`,
        inc.line,
        "encrypted/proprietary vendor model libraries cannot be read or run by ngspice; supply an open user model instead",
      );
    }
  }
}

/**
 * Prepare a parsed netlist for an ngspice run under LTspice compatibility mode:
 * choose the `ngbehavior` variant, build the per-run `.spiceinit`, and inspect
 * for unsupported constructs (Requirement 15). `.step` is left in place for the
 * step emulator (task 10); this layer does not reject it.
 */
export function prepareCompat(netlist: Netlist): CompatPrep {
  const translations: Translation[] = [];
  inspectIncludes(netlist);
  inspectDevices(netlist.devices, translations);
  for (const sub of netlist.subckts) inspectDevices(sub.devices, translations);
  inspectDirectives(netlist.directives, translations);

  const pspice = usesPspiceLibraries(netlist);
  const libKinds = pspice ? ["pspice"] : [];
  const mode = pspice ? "ltpsa" : "lt";
  return { spiceinit: spiceinitContents(libKinds), mode, translations };
}
