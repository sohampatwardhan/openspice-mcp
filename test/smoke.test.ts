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

  it("advertises the tools capability and the task-11 tool set", async () => {
    const c = await connect();
    try {
      assert.ok(c.client.getServerCapabilities()?.tools);
      const list = await c.client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ["openspice_parse_netlist", "openspice_read_schematic", "openspice_status"]);
      // Every tool has a strict input schema and an output schema.
      for (const tool of list.tools) {
        assert.equal((tool.inputSchema as { additionalProperties?: unknown }).additionalProperties, false);
        assert.ok(tool.outputSchema, `${tool.name} has an outputSchema`);
      }
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
