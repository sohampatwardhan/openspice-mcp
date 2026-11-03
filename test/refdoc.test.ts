import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ToolError } from "../src/errors.js";
import { ReferenceIndex } from "../src/refdoc.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "openspice-refdoc-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

// A pretend user LTspiceHelp folder inside an allowed location.
const helpDir = join(tmp, "LTspiceHelp");
mkdirSync(helpDir, { recursive: true });
writeFileSync(join(helpDir, "dotcommands.html"), "<html><body>LTspice .tran help, user-installed.</body></html>");
mkdirSync(join(helpDir, "nested"), { recursive: true });
writeFileSync(join(helpDir, "nested", "shortcuts.html"), "<html><body>LTspice keyboard shortcuts, user-installed.</body></html>");

describe("ReferenceIndex without LTspiceHelp", () => {
  const index = new ReferenceIndex({ helpDir: null });

  it("lists OpenSPICE-owned docs and ngspice pointers, each tagged with a source", async () => {
    const entries = await index.list();
    assert.ok(entries.length > 0);
    assert.ok(entries.some((e) => e.source === "openspice"));
    assert.ok(entries.some((e) => e.source === "ngspice"));
    assert.ok(entries.every((e) => e.id !== "" && e.title !== ""));
    // No LTspiceHelp entries when the folder is absent.
    assert.ok(!entries.some((e) => e.source === "ltspice-help"));
  });

  it("returns the text of an OpenSPICE-owned doc directly", async () => {
    const entries = await index.list();
    const own = entries.find((e) => e.source === "openspice");
    assert.ok(own !== undefined);
    const doc = await index.get(own.id);
    assert.equal(doc.source, "openspice");
    assert.ok(typeof doc.text === "string" && doc.text.length > 0);
  });

  it("returns a URL pointer (not fetched content) for an ngspice entry", async () => {
    const entries = await index.list();
    const ng = entries.find((e) => e.source === "ngspice");
    assert.ok(ng !== undefined);
    const doc = await index.get(ng.id);
    assert.equal(doc.source, "ngspice");
    assert.ok(typeof doc.url === "string" && /^https?:\/\//.test(doc.url ?? ""));
    assert.equal(doc.text, null);
  });

  it("fails with INVALID_ARGUMENT on an unknown id", async () => {
    await assert.rejects(
      () => index.get("no-such-id"),
      (err: unknown) => err instanceof ToolError && err.code === "INVALID_ARGUMENT",
    );
  });
});

describe("ReferenceIndex with a user LTspiceHelp folder", () => {
  const index = new ReferenceIndex({ helpDir });

  it("includes local LTspiceHelp entries tagged as ltspice-help", async () => {
    const entries = await index.list();
    const help = entries.filter((e) => e.source === "ltspice-help");
    assert.ok(help.length >= 1);
    assert.ok(help.every((e) => e.path !== null && e.path !== undefined));
  });

  it("reads LTspiceHelp content from the user's installed file", async () => {
    const entries = await index.list();
    const help = entries.find((e) => e.source === "ltspice-help");
    assert.ok(help !== undefined);
    const doc = await index.get(help.id);
    assert.equal(doc.source, "ltspice-help");
    assert.match(doc.text ?? "", /user-installed/);
  });

  it("never ships LTspice help itself: the OpenSPICE-owned docs carry no ADI content", async () => {
    const own = new ReferenceIndex({ helpDir: null });
    const entries = await own.list();
    for (const e of entries.filter((x) => x.source === "openspice")) {
      const doc = await own.get(e.id);
      assert.ok(!/analog devices|ltspice help/i.test(doc.text ?? ""));
    }
  });
});
