import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ToolError } from "./errors.js";

export class RootsError extends Error {
  override name = "RootsError";
}

/**
 * Parse OPENSPICE_ROOTS: comma-separated absolute directories, stored as real
 * paths. Unset or blank means the single root `fallback` (OPENSPICE_CWD or the
 * process cwd). `/`, missing paths, and non-directories are refused.
 */
export function parseRoots(raw: string | undefined, fallback: string): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const list = entries.length === 0 ? [resolve(fallback)] : entries;
  const roots: string[] = [];
  for (const entry of list) {
    if (!isAbsolute(entry)) throw new RootsError(`${JSON.stringify(entry)} is not an absolute path`);
    let real: string;
    try {
      real = realpathSync(entry);
    } catch {
      throw new RootsError(`${JSON.stringify(entry)} does not exist`);
    }
    if (!statSync(real).isDirectory()) throw new RootsError(`${JSON.stringify(entry)} is not a directory`);
    if (real === sep || dirname(real) === real) throw new RootsError(`${JSON.stringify(entry)} resolves to the filesystem root`);
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

/** True when `path` is `root` or below it. Both must be normalized absolute paths. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The directories the server may read, write, and run in (Requirement 8). */
export class Roots {
  constructor(readonly list: string[]) {}

  /** The first root: the default working directory for relative paths and run dirs. */
  get primary(): string {
    const first = this.list[0];
    if (first === undefined) throw new Error("no roots configured");
    return first;
  }

  contains(realPath: string): boolean {
    return this.list.some((root) => isInside(root, realPath));
  }

  /**
   * Resolve an existing path with realpath and accept it only inside a root.
   * Relative paths resolve against `base` (default: the primary root).
   */
  async resolveInside(path: string, base: string = this.primary): Promise<string> {
    const absolute = resolve(base, path);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw outside(path, "does not exist");
    }
    if (!this.contains(real)) throw outside(path);
    return real;
  }

  /**
   * Resolve a write target that may not exist yet. The target's nearest existing
   * ancestor directory is resolved with `realpath` and must be inside a root, so
   * writing never escapes the roots through a symlinked ancestor or a path whose
   * parents do not exist yet. An existing final component that is a symlink is
   * refused outright: a write must land on the named path, never silently follow
   * a link (even one whose target is inside the roots).
   */
  async resolveForWrite(path: string, base: string = this.primary): Promise<string> {
    const absolute = resolve(base, path);

    // A final component that already exists as a symlink is not a safe write target.
    let link;
    try {
      link = await lstat(absolute);
    } catch {
      link = null;
    }
    if (link !== null && link.isSymbolicLink()) {
      throw outside(path, "write target is a symlink");
    }

    // Walk up to the nearest existing ancestor and confine it to the roots.
    let ancestor = dirname(absolute);
    const trailing: string[] = [basename(absolute)];
    // Stop at the filesystem root; a non-existent chain up to `/` is outside.
    for (;;) {
      if (existsSync(ancestor)) break;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw outside(path, "no existing ancestor directory");
      trailing.unshift(basename(ancestor));
      ancestor = parent;
    }
    const realAncestor = await this.resolveInside(ancestor);
    return resolve(realAncestor, ...trailing);
  }

  /**
   * Resolve a write target inside the roots and refuse to clobber an existing file
   * unless `overwrite` is set (Requirement 8.3). Returns the resolved absolute path.
   */
  async ensureWritable(path: string, overwrite: boolean, base: string = this.primary): Promise<string> {
    const target = await this.resolveForWrite(path, base);
    if (!overwrite && existsSync(target)) {
      throw new ToolError("PATH_EXISTS", `${JSON.stringify(path)} already exists; set overwrite to replace it`, { path: target });
    }
    return target;
  }

  /** Create a fresh per-run working directory inside the primary root and return its real path. */
  async makeRunDir(prefix = "run"): Promise<string> {
    const base = join(this.primary, ".openspice", "runs");
    await mkdir(base, { recursive: true });
    const name = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const dir = join(base, name);
    await mkdir(dir, { recursive: true });
    return realpathSync(dir);
  }

  /** The directory snapshots for undo are written to, created on demand, inside the primary root. */
  snapshotDir(): string {
    const dir = join(this.primary, ".openspice", "snapshots");
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  }
}

function outside(path: string, reason = "outside every root"): ToolError {
  return new ToolError("PATH_OUTSIDE_ROOTS", `${JSON.stringify(path)} is not inside OPENSPICE_ROOTS (${reason})`, {
    path,
    reason,
  });
}
