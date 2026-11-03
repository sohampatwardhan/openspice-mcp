import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { Designs } from "../src/designs.js";
import { ToolError } from "../src/errors.js";
import { Roots } from "../src/paths.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "openspice-designs-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const NETLIST = ["rc", "V1 in 0 1", "R1 in out 1k", "C1 out 0 1u", ".tran 1u 1m", ".end", ""].join("\n");
const ASC_UTF16 = ["Version 4", "SHEET 1 880 680", "SYMBOL res 128 80 R0", "SYMATTR InstName R1", "SYMATTR Value 1k", "FLAG 144 240 0", ""].join("\r\n");

function freshRoot(): { roots: Roots; dir: string } {
  const dir = realpathSync(mkdtempSync(join(tmp, "root-")));
  return { roots: new Roots([dir]), dir };
}

describe("Designs.open and list", () => {
  it("opens a netlist, marks it active, and lists it", async () => {
    const { roots, dir } = freshRoot();
    writeFileSync(join(dir, "a.cir"), NETLIST);
    const designs = new Designs(roots);
    const opened = await designs.open("a.cir");
    assert.equal(opened.kind, "netlist");
    assert.equal(opened.active, true);
    const list = designs.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, opened.id);
    assert.equal(designs.active()?.id, opened.id);
  });

  it("detects a schematic by extension and switches the active design on a second open", async () => {
    const { roots, dir } = freshRoot();
    writeFileSync(join(dir, "a.cir"), NETLIST);
    writeFileSync(join(dir, "b.asc"), Buffer.from("\ufeff" + ASC_UTF16, "utf16le"));
    const designs = new Designs(roots);
    const a = await designs.open("a.cir");
    const b = await designs.open("b.asc");
    assert.equal(b.kind, "schematic");
    assert.equal(designs.active()?.id, b.id);
    assert.notEqual(a.id, b.id);
    // Re-opening a returns the same id and re-activates it.
    const a2 = await designs.open("a.cir");
    assert.equal(a2.id, a.id);
    assert.equal(designs.active()?.id, a.id);
  });

  it("rejects an unknown id with DESIGN_NOT_FOUND", async () => {
    const { roots } = freshRoot();
    const designs = new Designs(roots);
    await assert.rejects(() => designs.getContent("nope"), (err: unknown) => err instanceof ToolError && err.code === "DESIGN_NOT_FOUND");
    await assert.rejects(() => designs.setContent("nope", "x"), (err: unknown) => err instanceof ToolError && err.code === "DESIGN_NOT_FOUND");
    await assert.rejects(() => designs.restore("nope"), (err: unknown) => err instanceof ToolError && err.code === "DESIGN_NOT_FOUND");
  });
});

describe("Designs.getContent and setContent", () => {
  it("returns content and encoding, and writes validated new content", async () => {
    const { roots, dir } = freshRoot();
    writeFileSync(join(dir, "a.cir"), NETLIST);
    const designs = new Designs(roots);
    const opened = await designs.open("a.cir");
    const got = await designs.getContent(opened.id);
    assert.equal(got.encoding, "utf-8");
    assert.match(got.text, /R1 in out 1k/);

    const edited = NETLIST.replace("1k", "2k");
    const res = await designs.setContent(opened.id, edited);
    assert.equal(res.diagnostic, null);
    assert.equal(res.written, true);
    assert.match(readFileSync(join(dir, "a.cir"), "utf8"), /R1 in out 2k/);
    const after = await designs.getContent(opened.id);
    assert.match(after.text, /2k/);
  });

  it("rejects invalid netlist content without writing (Requirement 9.6)", async () => {
    const { roots, dir } = freshRoot();
    writeFileSync(join(dir, "a.cir"), NETLIST);
    const designs = new Designs(roots);
    const opened = await designs.open("a.cir");
    const before = readFileSync(join(dir, "a.cir"));
    const res = await designs.setContent(opened.id, "rc\n@@@ not a device or directive\n.end\n");
    assert.ok(res.diagnostic !== null);
    assert.equal(res.written, false);
    // File byte-for-byte unchanged.
    assert.deepEqual(readFileSync(join(dir, "a.cir")), before);
  });

  it("preserves a .asc file's original encoding and CRLF on write", async () => {
    const { roots, dir } = freshRoot();
    const bytes = Buffer.from("\ufeff" + ASC_UTF16, "utf16le");
    writeFileSync(join(dir, "b.asc"), bytes);
    const designs = new Designs(roots);
    const opened = await designs.open("b.asc");
    const got = await designs.getContent(opened.id);
    assert.equal(got.encoding, "utf-16le");

    const edited = got.text.replace("1k", "4k7");
    const res = await designs.setContent(opened.id, edited);
    assert.equal(res.written, true);
    const written = readFileSync(join(dir, "b.asc"));
    // Still UTF-16LE with a BOM and CRLF line endings.
    assert.equal(written[0], 0xff);
    assert.equal(written[1], 0xfe);
    const decoded = written.subarray(2).toString("utf16le");
    assert.match(decoded, /4k7/);
    assert.match(decoded, /\r\n/);
  });
});

describe("Designs snapshot, restore, and listChanged", () => {
  it("snapshots prior content on set and restores the most recent snapshot", async () => {
    const { roots, dir } = freshRoot();
    writeFileSync(join(dir, "a.cir"), NETLIST);
    const designs = new Designs(roots);
    const opened = await designs.open("a.cir");
    await designs.setContent(opened.id, NETLIST.replace("1k", "9k"), { snapshot: true });
    assert.match(readFileSync(join(dir, "a.cir"), "utf8"), /9k/);
    const restored = await designs.restore(opened.id);
    assert.equal(restored.restored, true);
    // Back to the original 1k value.
    assert.match(readFileSync(join(dir, "a.cir"), "utf8"), /1k/);
  });

  it("reports changed designs since a cursor", async () => {
    const { roots, dir } = freshRoot();
    writeFileSync(join(dir, "a.cir"), NETLIST);
    const designs = new Designs(roots);
    const opened = await designs.open("a.cir");
    const first = designs.listChanged(0);
    assert.ok(first.changed.some((c) => c.id === opened.id));
    assert.ok(first.cursor >= 1);
    // Nothing new since the latest cursor.
    const second = designs.listChanged(first.cursor);
    assert.equal(second.changed.length, 0);
    // A set bumps the change log.
    await designs.setContent(opened.id, NETLIST.replace("1k", "3k3"));
    const third = designs.listChanged(first.cursor);
    assert.ok(third.changed.some((c) => c.id === opened.id));
  });
});

describe("Designs result association", () => {
  beforeEach(() => {});
  it("records the latest raw/log for a design", async () => {
    const { roots, dir } = freshRoot();
    writeFileSync(join(dir, "a.cir"), NETLIST);
    const designs = new Designs(roots);
    const opened = await designs.open("a.cir");
    assert.equal(designs.lastResult(opened.id), null);
    designs.setResult(opened.id, { rawPath: join(dir, "out.raw"), logPath: join(dir, "out.log"), runDir: dir });
    const res = designs.lastResult(opened.id);
    assert.equal(res?.rawPath, join(dir, "out.raw"));
    assert.equal(res?.logPath, join(dir, "out.log"));
  });
});
