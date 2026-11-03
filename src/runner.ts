/**
 * The ngspice simulation runner (Requirement 6). Ties the compatibility layer,
 * the `.step` emulator, the fixed argv, and the tracked child module into one
 * run: prepare a per-run directory, write the per-run `.spiceinit` (so
 * `ngbehavior=lt` is set before the deck is parsed and the user's global config
 * is never touched), build a deck whose `.control` block runs the analysis and
 * writes the rawfile (the path that also lets `.meas` run in batch mode;
 * verified against ngspice 44.2, see docs/compatibility.md), spawn ngspice,
 * enforce the timeout, classify the exit into success / `SIM_FAILED` /
 * `SIM_TIMEOUT`, read the raw(s) and log, and leave no process running.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { controlRunArgv } from "./argv.js";
import { runProcess, SpawnError, stopAll } from "./children.js";
import { prepareCompat, type Translation } from "./compat.js";
import { ToolError } from "./errors.js";
import type { Directive, Netlist } from "./netlist.js";
import { emit } from "./netlist.js";
import type { Roots } from "./paths.js";
import { parseMeas, readRaw, type Measurement, type RawFile } from "./raw.js";
import { assembleStepped, buildControlBlock, parseStepDirectives, type BoundSweep, type SteppedResult } from "./steps.js";

/** Analysis directives whose argument becomes the ngspice control-block command. */
const ANALYSIS_DIRECTIVES = new Set([".tran", ".ac", ".dc", ".op", ".noise", ".tf", ".disto", ".pz", ".sens", ".four"]);

export interface Analysis {
  /** The directive, lower-case with the dot (e.g. `.tran`). */
  directive: string;
  /** The ngspice control command without the dot (e.g. `tran 1u 1m`, `op`). */
  command: string;
  line: number;
}

/** Find the first analysis directive and turn it into a control-block command (Requirement 6.1). */
export function analysisFromNetlist(netlist: Netlist): Analysis | null {
  for (const directive of netlist.directives) {
    const kind = directive.kind.toLowerCase();
    if (!ANALYSIS_DIRECTIVES.has(kind)) continue;
    const bare = kind.slice(1);
    const command = directive.args.trim() === "" ? bare : `${bare} ${directive.args.trim()}`;
    return { directive: kind, command, line: directive.line };
  }
  return null;
}

/** Directives the control block drives itself, stripped from the emitted deck body. */
const CONTROL_OWNED = new Set([".tran", ".ac", ".dc", ".op", ".noise", ".tf", ".disto", ".pz", ".sens", ".four", ".step", ".meas"]);

export interface DeckOptions {
  /** Bare rawfile name the control block writes (resolved in the run dir). */
  rawName: string;
  /** Bound `.step` sweeps; empty for a plain run. */
  sweeps: BoundSweep[];
}

/**
 * Build the deck the runner feeds ngspice: the netlist body with analysis and
 * `.step`/`.meas` directives removed, followed by a `.control` block that runs
 * the analysis (looping for `.step`) and writes the rawfile. `.meas` directives
 * are re-inserted in the deck body so ngspice runs them during the control run.
 */
export function buildRunDeck(netlist: Netlist, opts: DeckOptions): string {
  const analysis = analysisFromNetlist(netlist);
  const command = analysis?.command ?? "op";

  // Emit the deck without control-owned directives, but keep .meas lines in the
  // body (ngspice evaluates them against the run the control block performs).
  const meas = netlist.directives.filter((d) => d.kind.toLowerCase() === ".meas");
  const stripped: Netlist = {
    ...netlist,
    directives: netlist.directives.filter((d) => !CONTROL_OWNED.has(d.kind.toLowerCase())),
  };
  const body = emit(stripped).replace(/\n\.end\n?$/, "\n");

  const measLines = meas.map((d: Directive) => `${d.kind} ${d.args}`.trimEnd());

  let control: string;
  if (opts.sweeps.length > 0) {
    // Emulate the first sweep (nested sweeps are a later extension).
    const sweep = opts.sweeps[0] as BoundSweep;
    control = buildControlBlock(sweep, { analysis: command, rawName: opts.rawName });
  } else {
    control = [".control", `${command}`, `write ${opts.rawName} all`, ".endc"].join("\n");
  }

  return [body.trimEnd(), ...measLines, control, ".end", ""].join("\n");
}

export interface RunOptions {
  roots: Roots;
  ngspiceBin: string;
  timeoutMs: number;
  /** Extra environment for the child (test fixtures use this). */
  extraEnv?: Record<string, string>;
  /** Maps a `.step` param name to the device instance to alter (for value sweeps). */
  stepDevice?: Record<string, string>;
}

export interface RunResult {
  status: "ok";
  rawPath: string;
  logPath: string;
  runDir: string;
  /** Parsed single-run rawfile (the first step for a swept run). */
  raw: RawFile;
  /** The full stepped result when a `.step` was emulated, else null. */
  stepped: SteppedResult | null;
  measurements: Measurement[];
  translations: Translation[];
  log: string;
}

/** Bind parsed `.step` sweeps to the device they alter (or a param), per `stepDevice`. */
function bindSweeps(netlist: Netlist, stepDevice: Record<string, string> | undefined): BoundSweep[] {
  const map = stepDevice ?? {};
  return parseStepDirectives(netlist).map((sweep) => {
    const device = map[sweep.param] ?? null;
    return { param: sweep.param, device, values: sweep.values };
  });
}

/**
 * Run an ngspice simulation under LTspice compatibility (Requirement 6, 15).
 * Throws `UNSUPPORTED_LTSPICE_FEATURE` (via the compat layer),
 * `BACKEND_NOT_FOUND`, `SIM_TIMEOUT`, `SIM_FAILED`, or `RAW_PARSE_FAILED`.
 */
export async function runSimulation(netlist: Netlist, opts: RunOptions): Promise<RunResult> {
  const prep = prepareCompat(netlist);
  const sweeps = bindSweeps(netlist, opts.stepDevice);

  const runDir = await opts.roots.makeRunDir("sim");
  const rawName = "out.raw";
  const rawPath = join(runDir, rawName);
  const logPath = join(runDir, "out.log");
  const deckPath = join(runDir, "deck.cir");

  // The per-run .spiceinit sets ngbehavior before the deck is parsed; ngspice
  // reads it from the run dir (its cwd), never the user's global config.
  await writeFile(join(runDir, ".spiceinit"), prep.spiceinit, "utf8");
  await writeFile(deckPath, buildRunDeck(netlist, { rawName, sweeps }), "utf8");

  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.extraEnv ?? {}) };
  let run;
  try {
    run = await runProcess(opts.ngspiceBin, controlRunArgv({ deck: deckPath, logOut: logPath }), {
      cwd: runDir,
      timeoutMs: opts.timeoutMs,
      env,
    });
  } catch (err) {
    if (err instanceof SpawnError && (err.code === "ENOENT" || err.code === "EACCES")) {
      throw new ToolError("BACKEND_NOT_FOUND", `ngspice could not be started (${opts.ngspiceBin}): ${err.message}`, {
        bin: opts.ngspiceBin,
      });
    }
    throw err;
  }

  const log = await readLogSafe(logPath, run.stdout, run.stderr);

  if (run.timedOut) {
    await stopAll();
    throw new ToolError("SIM_TIMEOUT", `simulation exceeded ${opts.timeoutMs} ms and was terminated`, {
      timeoutMs: opts.timeoutMs,
      logTail: tail(log),
    });
  }
  if (run.exitCode !== 0 || /Simulation interrupted due to error|fatal error|aborted/i.test(log)) {
    throw new ToolError("SIM_FAILED", `ngspice exited ${run.exitCode ?? "with a signal"}`, {
      exitCode: run.exitCode,
      signal: run.signal,
      logTail: tail(log),
    });
  }

  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(rawPath);
  } catch {
    throw new ToolError("SIM_FAILED", "ngspice reported success but wrote no rawfile", { rawPath, logTail: tail(log) });
  }

  const stepped = sweeps.length > 0 ? assembleStepped(rawBytes) : null;
  const raw = stepped !== null ? (stepped.perStep[0] as RawFile) : readRaw(rawBytes);
  const measurements = parseMeas(log);

  return {
    status: "ok",
    rawPath,
    logPath,
    runDir,
    raw,
    stepped,
    measurements,
    translations: prep.translations,
    log,
  };
}

/** Read the log file; fall back to captured stdout/stderr when it is absent. */
async function readLogSafe(logPath: string, stdout: string, stderr: string): Promise<string> {
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return `${stdout}\n${stderr}`;
  }
}

/** Keep the last ~8k characters of a log for an error detail. */
function tail(log: string): string {
  const max = 8_000;
  return log.length <= max ? log : log.slice(log.length - max);
}

// Ensure makeRunDir's parent exists even if the roots helper changes.
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
