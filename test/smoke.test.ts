// Suite-wide checks over stdio: the server starts, reports its identity, and
// exposes no tools yet (tool groups land in tasks 11, 12, 16).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { connect, serverEntry } from "./smoke-helpers.js";

describe("server surface", () => {
  it("connects over stdio and reports its name and version", async () => {
    const c = await connect();
    try {
      const info = c.client.getServerVersion();
      assert.equal(info?.name, "openspice-mcp");
      assert.equal(info?.version, "0.1.0");
    } finally {
      await c.close();
    }
  });

  it("advertises no tools capability yet", async () => {
    // The MCP SDK registers the tools/list handler and the tools capability only
    // once a tool is registered. Tool groups land in tasks 11, 12, and 16; until
    // then the scaffold has no tools and does not advertise the capability.
    const c = await connect();
    try {
      assert.equal(c.client.getServerCapabilities()?.tools, undefined);
    } finally {
      await c.close();
    }
  });
});

describe("startup", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "openspice-startup-")));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("exits 2 and names the variable when the environment is invalid", () => {
    const run = spawnSync(process.execPath, [serverEntry], {
      env: { ...process.env, OPENSPICE_CWD: tmp, OPENSPICE_ALLOW_PLOTS: "sometimes" },
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /OPENSPICE_ALLOW_PLOTS/);
    assert.equal(run.stdout, "");
  });
});
