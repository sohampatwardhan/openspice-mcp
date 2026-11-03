/**
 * The only module that spawns and signals processes. Children are spawned
 * detached and `shell: false`, tracked here, and killed as process groups on
 * shutdown (Requirement 8.2, 8.6). The full simulation runner (task 8) layers a
 * run directory and timeout classification on top of `runProcess`; this module
 * owns spawning, tracking, output capture, and `stopAll`.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Grace period between SIGTERM and SIGKILL when stopping a tracked child. */
export const KILL_GRACE_MS = 5_000;

interface Entry {
  child: ChildProcess;
  exited: boolean;
  killTimer: NodeJS.Timeout | undefined;
}

const live = new Set<Entry>();

/** Signal the process group `child` leads, falling back to the child alone. */
export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // not a group leader, or already gone
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

/** Number of tracked children still running. */
export function liveChildren(): number {
  return live.size;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Largest number of bytes captured per stream before further output is dropped. */
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class SpawnError extends Error {
  override name = "SpawnError";
  constructor(
    message: string,
    readonly code: "ENOENT" | "EACCES" | "OTHER",
  ) {
    super(message);
  }
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * Run `bin` with a fixed argv (never a shell) in its own tracked process group,
 * with a hard timeout (SIGTERM, then SIGKILL after the grace period) and a
 * per-stream output cap. Resolves with the outcome for any process that
 * started; rejects with a `SpawnError` when the binary is missing or unusable.
 */
export function runProcess(bin: string, argv: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(bin, argv, {
        shell: false,
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...(opts.env ?? process.env), NO_COLOR: "1" },
        windowsHide: true,
        detached: true,
      });
    } catch (err) {
      reject(new SpawnError(`failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`, "OTHER"));
      return;
    }

    const entry: Entry = { child, exited: false, killTimer: undefined };
    live.add(entry);
    const retire = () => {
      entry.exited = true;
      if (entry.killTimer) clearTimeout(entry.killTimer);
      live.delete(entry);
    };

    const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const stdout = collector(cap);
    const stderr = collector(cap);
    child.stdout?.on("data", stdout.push);
    child.stderr?.on("data", stderr.push);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      entry.killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
      entry.killTimer.unref();
    }, opts.timeoutMs);
    timer.unref();

    child.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      retire();
      const code = err.code === "ENOENT" ? "ENOENT" : err.code === "EACCES" ? "EACCES" : "OTHER";
      reject(new SpawnError(`failed to start ${bin}: ${err.message}`, code));
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      retire();
      resolvePromise({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

/**
 * Stop every tracked child: SIGTERM now, SIGKILL to any still running after
 * `graceMs`. Resolves once all have exited or shortly after the SIGKILL.
 */
export async function stopAll(graceMs: number = KILL_GRACE_MS): Promise<void> {
  const entries = [...live];
  for (const entry of entries) killGroup(entry.child, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (live.size > 0 && Date.now() < deadline) await sleep(25);
  for (const entry of [...live]) killGroup(entry.child, "SIGKILL");
  const after = Date.now() + 500;
  while (live.size > 0 && Date.now() < after) await sleep(25);
}

function collector(cap: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push: (chunk: Buffer) => {
      if (size >= cap) return;
      const room = cap - size;
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(piece);
      size += piece.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
