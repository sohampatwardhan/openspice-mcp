// Drives the task-11 tools over stdio with the MCP Client: status reports the
// ngspice probe and extras, parse_netlist returns a structured model and
// validation, and read_schematic reads an .asc.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { connect } from "./smoke-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeNgspice = join(here, "..", "..", "test", "fixtures", "fake-ngspice.mjs");

interface Structured {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function callTool(client: import("@modelcontextprotocol/sdk/client/index.js").Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  return (await client.callTool({ name, arguments: args })) as unknown as Structured;
}

describe("openspice_status", () => {
  it("reports the ngspice probe, roots, plotting, and extras", async () => {
    const c = await connect({ env: { OPENSPICE_NGSPICE_BIN: fakeNgspice } });
    try {
      const res = await callTool(c.client, "openspice_status", {});
      const s = res.structuredContent as Record<string, any>;
      assert.equal(s.ngspice.found, true);
      assert.equal(s.ngspice.version, "44.2");
      assert.equal(s.ngspice.supports_compat_mode, true);
      assert.equal(s.plotting_enabled, false);
      assert.ok(Array.isArray(s.roots) && s.roots.length === 1);
      assert.equal(s.optional_extras.ltspice.enabled, false);
      assert.equal(s.optional_extras.bridge.enabled, false);
    } finally {
      await c.close();
    }
  });

  it("still succeeds with an install hint when ngspice is missing", async () => {
    const c = await connect({ env: { OPENSPICE_NGSPICE_BIN: "/no/such/ngspice" } });
    try {
      const res = await callTool(c.client, "openspice_status", {});
      const s = res.structuredContent as Record<string, any>;
      assert.equal(res.isError ?? false, false);
      assert.equal(s.ngspice.found, false);
      assert.ok(s.ngspice.install_hint);
    } finally {
      await c.close();
    }
  });
});

describe("openspice_parse_netlist", () => {
  it("parses inline text and validates", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_parse_netlist", {
        text: "divider\nV1 in 0 1\nR1 in out 1k\nR2 out 0 1k\n.tran 1n 1m\n.end\n",
        validate: true,
      });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(s.title, "divider");
      assert.equal(s.devices.length, 3);
      assert.ok(s.directives.some((d: any) => d.kind === ".tran"));
      assert.ok(Array.isArray(s.validation));
      assert.ok(!s.validation.some((v: any) => v.rule === "no-ground"));
    } finally {
      await c.close();
    }
  });

  it("parses a file inside the roots and resolves an include within roots", async () => {
    const c = await connect();
    try {
      writeFileSync(join(c.work, "sub.cir"), "* sub\n");
      writeFileSync(join(c.work, "main.cir"), "main\nR1 a 0 1k\n.include sub.cir\n.end\n");
      const res = await callTool(c.client, "openspice_parse_netlist", { path: "main.cir" });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(s.source.path.endsWith("main.cir"), true);
      assert.equal(s.includes.length, 1);
      assert.equal(s.includes[0].inside_roots, true);
    } finally {
      await c.close();
    }
  });

  it("rejects a path outside the roots", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_parse_netlist", { path: "../escape.cir" });
      assert.equal(res.isError, true);
      assert.match(res.content[0]?.text ?? "", /PATH_OUTSIDE_ROOTS/);
    } finally {
      await c.close();
    }
  });
});

describe("openspice_read_schematic", () => {
  it("reads an inline .asc schematic", async () => {
    const c = await connect();
    try {
      const asc = ["Version 4", "SHEET 1 880 680", "SYMBOL res 128 80 R0", "SYMATTR InstName R1", "SYMATTR Value 1k", "FLAG 144 240 0", ""].join("\n");
      const res = await callTool(c.client, "openspice_read_schematic", { text: asc, kind: "asc" });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(s.kind, "asc");
      assert.equal(s.schematic.components.length, 1);
      assert.equal(s.schematic.components[0].inst_name, "R1");
      assert.ok(s.schematic.flags.some((f: any) => f.net === "0"));
    } finally {
      await c.close();
    }
  });
});
