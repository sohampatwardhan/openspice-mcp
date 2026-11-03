/**
 * The only place an ngspice (or optional-extra) command vector is built. No
 * shell, no caller-supplied free-form flags (Requirement 8.2). Each builder
 * returns a fixed argv; paths are already resolved and confined by the caller.
 */

export class ArgvError extends Error {
  override name = "ArgvError";
}

/** `ngspice --version`: used by the probe to read the version string. */
export function versionArgv(): string[] {
  return ["--version"];
}

export interface BatchRunSpec {
  /** The prepared deck file to simulate. */
  deck: string;
  /** Where ngspice writes the `.raw` result. */
  rawOut: string;
  /** Where ngspice writes the log. */
  logOut: string;
}

/**
 * `ngspice -b -r <raw> -o <log> <deck>`: a non-interactive batch run writing a
 * rawfile and a log. The per-run compatibility `.spiceinit`/control block is
 * applied by the runner (task 8) through the deck and the run directory, not a
 * free-form flag here.
 */
export function batchRunArgv(spec: BatchRunSpec): string[] {
  for (const [name, value] of Object.entries(spec)) {
    if (typeof value !== "string" || value === "") throw new ArgvError(`batchRunArgv: ${name} must be a non-empty path`);
    if (value.startsWith("-")) throw new ArgvError(`batchRunArgv: ${name} must not start with '-' (got ${JSON.stringify(value)})`);
  }
  return ["-b", "-r", spec.rawOut, "-o", spec.logOut, spec.deck];
}
