/**
 * ngspice probe (Requirement 1). Resolves the configured binary (an absolute
 * path, or a bare name looked up on PATH), runs `ngspice --version` through the
 * tracked child module with a fixed argv and no shell, parses the version, and
 * reports whether that version meets the minimum for LTspice compatibility mode
 * (`set ngbehavior=lt`). The minimum is stated as 34 and marked uncertain, per
 * the design: the exact first release of each `lt`/`ltpsa` variant is not
 * confirmed here, so the probe reports the found version and the caveat.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { versionArgv } from "./argv.js";
import { runProcess, SpawnError } from "./children.js";

/** Minimum ngspice version believed to support `ngbehavior=lt` (uncertain; verify per host). */
export const COMPAT_MODE_MIN_VERSION = 34;

/** Human-readable note about the compatibility-mode minimum and its uncertainty. */
export const COMPAT_MODE_NOTE =
  "ngspice 34+ is the stated minimum for LTspice compatibility mode (set ngbehavior=lt); " +
  "this floor is uncertain and should be verified against the ngspice manual for the host version.";

export interface NgspiceProbe {
  found: boolean;
  /** Resolved absolute path, or null when not found. */
  path: string | null;
  /** The configured binary name/path as given. */
  configured: string;
  version: string | null;
  /** Whether the detected version meets COMPAT_MODE_MIN_VERSION. Null when unknown. */
  supportsCompatMode: boolean | null;
  /** Install hint when the binary is missing. */
  installHint: string | null;
  warnings: string[];
}

export interface ProbeOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Install hint shown when ngspice is not on the host. */
export const NGSPICE_INSTALL_HINT =
  "ngspice was not found. Install it (e.g. `apt install ngspice`, `brew install ngspice`, or from https://ngspice.sourceforge.io) " +
  "or set OPENSPICE_NGSPICE_BIN to its path.";

/** Pull the first `ngspice-<version>` or bare version from a banner line. */
export function parseNgspiceVersion(text: string): string | null {
  const tagged = /ngspice[-\s]+v?(\d+(?:\.\d+)*)/i.exec(text);
  if (tagged) return tagged[1] ?? null;
  const bare = /\b(\d+(?:\.\d+)+)\b/.exec(text);
  return bare ? bare[1] ?? null : null;
}

/** The major version number as an integer, for the compat-mode comparison. */
function majorOf(version: string): number {
  const first = version.split(".")[0] ?? "";
  const n = Number(first);
  return Number.isFinite(n) ? n : 0;
}

/** Resolve a binary: an absolute/relative path if it exists, else a PATH lookup. */
export function resolveBinary(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (bin.includes("/") || isAbsolute(bin)) {
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      return null;
    }
  }
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d !== "");
  const names = process.platform === "win32" ? [bin, `${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep searching
      }
    }
  }
  return null;
}

/** Probe ngspice: resolve, read `--version`, and assess compat-mode support (Requirement 1). */
export async function probeNgspice(bin: string, opts: ProbeOptions): Promise<NgspiceProbe> {
  const env = opts.env ?? process.env;
  const warnings: string[] = [];
  const resolved = resolveBinary(bin, env);
  if (resolved === null) {
    return {
      found: false,
      path: null,
      configured: bin,
      version: null,
      supportsCompatMode: null,
      installHint: NGSPICE_INSTALL_HINT,
      warnings: [NGSPICE_INSTALL_HINT],
    };
  }

  let version: string | null = null;
  try {
    const result = await runProcess(resolved, versionArgv(), { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 15_000, env });
    version = parseNgspiceVersion(`${result.stdout}\n${result.stderr}`);
    if (version === null) warnings.push("ngspice ran but its version could not be parsed from the --version output");
  } catch (err) {
    if (err instanceof SpawnError && (err.code === "ENOENT" || err.code === "EACCES")) {
      return {
        found: false,
        path: null,
        configured: bin,
        version: null,
        supportsCompatMode: null,
        installHint: NGSPICE_INSTALL_HINT,
        warnings: [NGSPICE_INSTALL_HINT],
      };
    }
    warnings.push(`ngspice --version failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let supportsCompatMode: boolean | null = null;
  if (version !== null) {
    supportsCompatMode = majorOf(version) >= COMPAT_MODE_MIN_VERSION;
    if (!supportsCompatMode) {
      warnings.push(
        `ngspice ${version} is older than the ${COMPAT_MODE_MIN_VERSION}+ believed required for LTspice compatibility mode; ${COMPAT_MODE_NOTE}`,
      );
    }
  }

  return {
    found: true,
    path: resolved,
    configured: bin,
    version,
    supportsCompatMode,
    installHint: null,
    warnings,
  };
}
