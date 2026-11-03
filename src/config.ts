/**
 * Server configuration, read once from the environment at startup. Invalid
 * values are rejected up front, so tool calls never run with a half-valid
 * configuration. `src/index.ts` exits with code 2 on a ConfigError.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { parseRoots, RootsError } from "./paths.js";

export interface Config {
  /** Real paths of the directories the server may read, write, and run in. The first is the default. */
  roots: string[];
  /** Default root when OPENSPICE_ROOTS is unset. */
  cwd: string;
  /** Path or name of the ngspice binary. */
  ngspiceBin: string;
  /** Whether plotting tools may render image files. */
  allowPlots: boolean;
  /** Optional directory holding the user's installed LTspice help, read only when inside a root-allowed location. */
  ltspiceHelpDir: string | null;
  /** Extra directories searched for `.asy` symbols, in order. */
  symbolPath: string[];
  /** Optional native LTspice backend (Windows x64 only), off by default. */
  enableLtspice: boolean;
  ltspiceBin: string | null;
  /** Optional LTspice MCP bridge proxy (Windows x64 only), off by default. */
  enableBridge: boolean;
  bridgeBin: string | null;
  /** Optional Wine binary used to run a Windows LTspice off Windows (never required). */
  wineBin: string | null;
  /** How long a single simulation may run before its process group is killed. */
  simTimeoutMs: number;
}

/** Fixed limits from the design's configuration section. */
export const LIMITS = {
  /** Largest file the server will read before refusing with CONTENT_TOO_LARGE. */
  maxFileBytes: 16 * 1024 * 1024,
  /** Largest inline netlist/schematic text accepted on a tool call. */
  maxInlineChars: 4 * 1024 * 1024,
  /** Downsampled sample points returned per waveform variable by default. */
  defaultMaxPoints: 2_000,
  /** Hard ceiling on requested sample points per variable. */
  maxPoints: 200_000,
  /** Characters of log tail returned with a simulation error. */
  logTailChars: 8_000,
} as const;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cwd = resolveCwd(env.OPENSPICE_CWD);
  let roots: string[];
  try {
    roots = parseRoots(env.OPENSPICE_ROOTS, cwd);
  } catch (err) {
    if (err instanceof RootsError) throw new ConfigError(`OPENSPICE_ROOTS: ${err.message}`);
    throw err;
  }
  return {
    roots,
    cwd,
    ngspiceBin: (env.OPENSPICE_NGSPICE_BIN ?? "").trim() || "ngspice",
    allowPlots: parseBooleanFlag("OPENSPICE_ALLOW_PLOTS", env.OPENSPICE_ALLOW_PLOTS),
    ltspiceHelpDir: parseOptionalAbsoluteDir("OPENSPICE_LTSPICE_HELP_DIR", env.OPENSPICE_LTSPICE_HELP_DIR),
    symbolPath: parseAbsoluteDirList("OPENSPICE_SYMBOL_PATH", env.OPENSPICE_SYMBOL_PATH),
    enableLtspice: parseBooleanFlag("OPENSPICE_ENABLE_LTSPICE", env.OPENSPICE_ENABLE_LTSPICE),
    ltspiceBin: parseOptionalPath(env.OPENSPICE_LTSPICE_BIN),
    enableBridge: parseBooleanFlag("OPENSPICE_ENABLE_BRIDGE", env.OPENSPICE_ENABLE_BRIDGE),
    bridgeBin: parseOptionalPath(env.OPENSPICE_BRIDGE_BIN),
    wineBin: parseOptionalPath(env.OPENSPICE_WINE_BIN),
    simTimeoutMs: parseMilliseconds("OPENSPICE_SIM_TIMEOUT_MS", env.OPENSPICE_SIM_TIMEOUT_MS) ?? 120_000,
  };
}

/** Unset or blank uses `process.cwd()`. A set value must be an existing directory. */
function resolveCwd(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return process.cwd();
  if (!isAbsolute(trimmed)) throw new ConfigError(`OPENSPICE_CWD must be an absolute path, got ${JSON.stringify(raw)}`);
  const cwd = resolve(trimmed);
  let info;
  try {
    info = statSync(cwd);
  } catch {
    throw new ConfigError(`OPENSPICE_CWD does not exist: ${JSON.stringify(cwd)}`);
  }
  if (!info.isDirectory()) throw new ConfigError(`OPENSPICE_CWD is not a directory: ${JSON.stringify(cwd)}`);
  return cwd;
}

/** Unset or blank is null; a set value is trimmed and returned verbatim (resolved at spawn time). */
function parseOptionalPath(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  return value === "" ? null : value;
}

/** Unset or blank is null; a set value must be an existing absolute directory. */
function parseOptionalAbsoluteDir(name: string, raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (!isAbsolute(value)) throw new ConfigError(`${name} must be an absolute path, got ${JSON.stringify(raw)}`);
  let info;
  try {
    info = statSync(value);
  } catch {
    throw new ConfigError(`${name} does not exist: ${JSON.stringify(value)}`);
  }
  if (!info.isDirectory()) throw new ConfigError(`${name} is not a directory: ${JSON.stringify(value)}`);
  return resolve(value);
}

/** A comma- (or OS path-separator-) separated list of existing absolute directories. Blank is empty. */
function parseAbsoluteDirList(name: string, raw: string | undefined): string[] {
  const entries = (raw ?? "")
    .split(/[,:;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!isAbsolute(entry)) throw new ConfigError(`${name} entries must be absolute paths, got ${JSON.stringify(entry)}`);
    let info;
    try {
      info = statSync(entry);
    } catch {
      throw new ConfigError(`${name} entry does not exist: ${JSON.stringify(entry)}`);
    }
    if (!info.isDirectory()) throw new ConfigError(`${name} entry is not a directory: ${JSON.stringify(entry)}`);
    const real = resolve(entry);
    if (!dirs.includes(real)) dirs.push(real);
  }
  return dirs;
}

/** Unset or blank is null. A set value must be a positive integer number of milliseconds. */
function parseMilliseconds(name: string, raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ConfigError(`${name} must be a positive integer (milliseconds), got ${JSON.stringify(raw)}`);
  }
  return Number(value);
}

/** Empty means false. `1` / `true` / `yes` (any case) mean true; `0` / `false` / `no` mean false. */
function parseBooleanFlag(name: string, raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "0" || value === "false" || value === "no") return false;
  if (value === "1" || value === "true" || value === "yes") return true;
  throw new ConfigError(`${name} must be 1, true, yes, 0, false, or no, got ${JSON.stringify(raw)}`);
}
