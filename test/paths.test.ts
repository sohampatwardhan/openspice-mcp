import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import { ConfigError, loadConfig } from "../src/config.js";
import { ToolError } from "../src/errors.js";
import { Roots, RootsError, parseRoots } from "../src/paths.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "openspice-paths-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const root = join(tmp, "work");
const sibling = join(tmp, "work-other");
const outside = join(tmp, "outside");
for (const dir of [root, sibling, outside, join(root, "src")]) mkdirSync(dir, { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "x");
writeFileSync(join(sibling, "b.ts"), "x");
writeFileSync(join(tmp, "file.txt"), "x");
writeFileSync(join(root, "existing.cir"), "x");
writeFileSync(join(outside, "target.cir"), "x");
symlinkSync(outside, join(root, "escape"));
symlinkSync(join(root, "src"), join(outside, "into-root"));
// A symlink inside the roots whose final component points at a file outside.
symlinkSync(join(outside, "target.cir"), join(root, "link-out.cir"));
// A symlink inside the roots whose final component points at a file inside.
symlinkSync(join(root, "existing.cir"), join(root, "link-in.cir"));

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    return err instanceof ToolError ? err.code : String(err);
  }
}

describe("parseRoots", () => {
  it("defaults to the fallback directory, as a real path", () => {
    assert.deepEqual(parseRoots(undefined, root), [root]);
  });

  it("splits a comma list and stores real paths", () => {
    assert.deepEqual(parseRoots(` ${root} , ${join(outside, "into-root")} `, tmp), [root, join(root, "src")]);
  });

  it("refuses /, relative paths, missing paths, and files", () => {
    for (const raw of ["/", "relative/dir", join(tmp, "missing"), join(tmp, "file.txt")]) {
      assert.throws(() => parseRoots(raw, tmp), RootsError, raw);
    }
  });

  it("makes loadConfig fail with OPENSPICE_ROOTS in the message", () => {
    assert.throws(
      () => loadConfig({ OPENSPICE_CWD: tmp, OPENSPICE_ROOTS: "/" }),
      (err: unknown) => err instanceof ConfigError && err.message.includes("OPENSPICE_ROOTS"),
    );
  });
});

describe("Roots.resolveInside", () => {
  const roots = new Roots([root]);

  it("accepts the root and paths inside it", async () => {
    assert.equal(await roots.resolveInside(root), root);
    assert.equal(await roots.resolveInside(join(root, "src", "a.ts")), join(root, "src", "a.ts"));
  });

  it("resolves relative paths against the base", async () => {
    assert.equal(await roots.resolveInside("src/a.ts", root), join(root, "src", "a.ts"));
  });

  it("refuses a sibling that shares the name prefix", async () => {
    assert.equal(await code(roots.resolveInside(join(sibling, "b.ts"))), "PATH_OUTSIDE_ROOTS");
  });

  it("refuses a symlink that points outside", async () => {
    assert.equal(await code(roots.resolveInside(join(root, "escape"))), "PATH_OUTSIDE_ROOTS");
  });

  it("accepts a symlink outside that points into a root", async () => {
    assert.equal(await roots.resolveInside(join(outside, "into-root")), join(root, "src"));
  });

  it("refuses .. traversal and missing paths", async () => {
    assert.equal(await code(roots.resolveInside(join(root, "..", "outside"))), "PATH_OUTSIDE_ROOTS");
    assert.equal(await code(roots.resolveInside(join(root, "missing.txt"))), "PATH_OUTSIDE_ROOTS");
  });

  it("resolves a new file's parent for writes", async () => {
    assert.equal(await roots.resolveForWrite(join(root, "src", "new.json")), join(root, "src", "new.json"));
    assert.equal(await code(roots.resolveForWrite(join(outside, "new.json"))), "PATH_OUTSIDE_ROOTS");
    assert.equal(await code(roots.resolveForWrite(join(root, "escape", "new.json"))), "PATH_OUTSIDE_ROOTS");
  });

  it("walks up to the nearest existing ancestor for a new nested path", async () => {
    assert.equal(await roots.resolveForWrite(join(root, "src", "a", "b", "c.json")), join(root, "src", "a", "b", "c.json"));
    assert.equal(await code(roots.resolveForWrite(join(outside, "a", "b", "c.json"))), "PATH_OUTSIDE_ROOTS");
    assert.equal(await code(roots.resolveForWrite(join(root, "escape", "a", "b", "c.json"))), "PATH_OUTSIDE_ROOTS");
  });

  it("rejects writing through an existing symlink final component that escapes the roots", async () => {
    assert.equal(await code(roots.resolveForWrite(join(root, "link-out.cir"))), "PATH_OUTSIDE_ROOTS");
  });

  it("rejects writing through an existing symlink even when its target is inside the roots", async () => {
    // Writing must target the named path, never silently follow a symlink.
    assert.equal(await code(roots.resolveForWrite(join(root, "link-in.cir"))), "PATH_OUTSIDE_ROOTS");
  });
});

describe("Roots.ensureWritable", () => {
  const roots = new Roots([root]);

  it("accepts a new target inside the roots", async () => {
    assert.equal(await roots.ensureWritable(join(root, "src", "fresh.cir"), false), join(root, "src", "fresh.cir"));
  });

  it("refuses to clobber an existing file unless overwrite is set", async () => {
    assert.equal(await code(roots.ensureWritable(join(root, "existing.cir"), false)), "PATH_EXISTS");
    assert.equal(await roots.ensureWritable(join(root, "existing.cir"), true), join(root, "existing.cir"));
  });

  it("still enforces the roots on a write target", async () => {
    assert.equal(await code(roots.ensureWritable(join(outside, "x.cir"), true)), "PATH_OUTSIDE_ROOTS");
  });
});

describe("Roots run and snapshot dirs", () => {
  const roots = new Roots([root]);

  it("makeRunDir creates a fresh directory inside the primary root", async () => {
    const a = await roots.makeRunDir();
    const b = await roots.makeRunDir();
    assert.ok(existsSync(a) && existsSync(b));
    assert.notEqual(a, b);
    assert.equal(await roots.resolveInside(a), a);
  });

  it("snapshotDir creates a directory inside the primary root", async () => {
    const dir = roots.snapshotDir();
    assert.ok(existsSync(dir));
    assert.equal(await roots.resolveInside(dir), dir);
    assert.equal(dirname(dirname(dir)), root);
  });
});
