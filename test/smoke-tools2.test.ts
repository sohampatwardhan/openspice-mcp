// Drives the task-12 tools over stdio with the MCP Client: convert and generate
// schematics, simulate with the fake ngspice engine, and read/raw-info/export a
// .raw plus read a log. The fake engine keeps these deterministic and offline.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { connect } from "./smoke-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeNgspice = join(here, "..", "..", "test", "fixtures", "fake-ngspice.mjs");
const fixtureRaw = join(here, "..", "..", "test", "fixtures", "raw", "test_tran_bin.raw");

interface Structured {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function callTool(client: import("@modelcontextprotocol/sdk/client/index.js").Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  return (await client.callTool({ name, arguments: args })) as unknown as Structured;
}

const DIVIDER_ASC = [
  "Version 4",
  "SHEET 1 880 680",
  "SYMBOL voltage 0 0 R0",
  "SYMATTR InstName V1",
  "SYMATTR Value 1",
  "SYMBOL res 0 0 R0",
  "SYMATTR InstName R1",
  "SYMATTR Value 1k",
  "SYMBOL res 0 96 R0",
  "SYMATTR InstName R2",
  "SYMATTR Value 2k",
  "FLAG 16 0 in",
  "FLAG 16 96 out",
  "FLAG 0 96 0",
  "",
].join("\n");

describe("openspice_schematic_to_netlist", () => {
  it("converts an inline .asc to a netlist and writes it when asked", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_schematic_to_netlist", { text: DIVIDER_ASC, out_path: "divider.net" });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(res.isError ?? false, false);
      assert.match(s.netlist_text, /R1 /);
      assert.ok(s.devices.some((d: any) => d.name === "V1"));
      assert.ok(String(s.written_path).endsWith("divider.net"));
      assert.ok(existsSync(s.written_path));
    } finally {
      await c.close();
    }
  });

  it("refuses to overwrite an existing output without overwrite", async () => {
    const c = await connect();
    try {
      writeFileSync(join(c.work, "exists.net"), "old\n");
      const res = await callTool(c.client, "openspice_schematic_to_netlist", { text: DIVIDER_ASC, out_path: "exists.net" });
      assert.equal(res.isError, true);
      assert.match(res.content[0]?.text ?? "", /PATH_EXISTS/);
      assert.equal(readFileSync(join(c.work, "exists.net"), "utf8"), "old\n");
    } finally {
      await c.close();
    }
  });
});

describe("openspice_generate_schematic", () => {
  it("generates a verified .asc and writes it", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_generate_schematic", {
        title: "divider",
        devices: [
          { kind: "V", name: "V1", nodes: ["in", "0"], value: "1" },
          { kind: "R", name: "R1", nodes: ["in", "out"], value: "1k" },
          { kind: "R", name: "R2", nodes: ["out", "0"], value: "2k" },
        ],
        directives: [".op"],
        out_path: "gen.asc",
      });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(res.isError ?? false, false);
      assert.equal(s.verified, true);
      assert.equal(s.counts.devices, 3);
      assert.match(s.asc_text, /SYMATTR InstName R1/);
      assert.ok(existsSync(s.written_path));
    } finally {
      await c.close();
    }
  });

  it("passes GENERATE_INVALID through for an inconsistent circuit", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_generate_schematic", {
        devices: [{ kind: "R", name: "R1", nodes: ["a"], value: "1k" }],
      });
      assert.equal(res.isError, true);
      assert.match(res.content[0]?.text ?? "", /GENERATE_INVALID/);
    } finally {
      await c.close();
    }
  });
});

describe("openspice_simulate (fake ngspice)", () => {
  it("simulates an inline netlist and returns a summary", async () => {
    const c = await connect({ env: { OPENSPICE_NGSPICE_BIN: fakeNgspice } });
    try {
      const res = await callTool(c.client, "openspice_simulate", {
        text: "rc\nV1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 1m\n.end\n",
      });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(res.isError ?? false, false, res.content[0]?.text);
      assert.equal(s.status, "ok");
      assert.ok(existsSync(s.raw_path));
      assert.ok(existsSync(s.log_path));
      assert.ok(s.summary.some((v: any) => v.name.toLowerCase() === "v(out)"));
    } finally {
      await c.close();
    }
  });

  it("surfaces SIM_FAILED when ngspice exits nonzero", async () => {
    const c = await connect({ env: { OPENSPICE_NGSPICE_BIN: fakeNgspice, FAKE_NGSPICE_EXIT: "1" } });
    try {
      const res = await callTool(c.client, "openspice_simulate", { text: "rc\nV1 in 0 1\nR1 in 0 1k\n.op\n.end\n" });
      assert.equal(res.isError, true);
      assert.match(res.content[0]?.text ?? "", /SIM_FAILED/);
    } finally {
      await c.close();
    }
  });
});

describe("raw and log tools", () => {
  it("reads a fixture .raw and reports metadata and a summary", async () => {
    const c = await connect();
    try {
      writeFileSync(join(c.work, "t.raw"), readFileSync(fixtureRaw));
      const info = await callTool(c.client, "openspice_raw_info", { path: "t.raw" });
      const i = info.structuredContent as Record<string, any>;
      assert.equal(info.isError ?? false, false);
      assert.ok(i.variables.length >= 2);

      const read = await callTool(c.client, "openspice_read_raw", { path: "t.raw" });
      const r = read.structuredContent as Record<string, any>;
      assert.equal(read.isError ?? false, false);
      assert.equal(r.point_count, i.point_count);
      assert.ok(r.summary.length >= 1);
    } finally {
      await c.close();
    }
  });

  it("exports waveforms to CSV inside the roots", async () => {
    const c = await connect();
    try {
      writeFileSync(join(c.work, "t.raw"), readFileSync(fixtureRaw));
      const res = await callTool(c.client, "openspice_export_waveforms", { path: "t.raw", out_path: "waves.csv" });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(res.isError ?? false, false);
      assert.ok(existsSync(s.written_path));
      assert.equal(s.format, "csv");
      assert.ok(s.rows >= 1);
    } finally {
      await c.close();
    }
  });

  it("reports a plotting-disabled diagnostic but still returns the summary", async () => {
    const c = await connect();
    try {
      writeFileSync(join(c.work, "t.raw"), readFileSync(fixtureRaw));
      const res = await callTool(c.client, "openspice_read_raw", { path: "t.raw", plot_path: "p.svg" });
      const r = res.structuredContent as Record<string, any>;
      assert.equal(res.isError ?? false, false);
      assert.equal(r.plot.written, false);
      assert.ok(/plotting is disabled/i.test(r.plot.diagnostic));
      assert.ok(r.summary.length >= 1);
      assert.equal(existsSync(join(c.work, "p.svg")), false);
    } finally {
      await c.close();
    }
  });

  it("writes an SVG plot when plotting is enabled", async () => {
    const c = await connect({ env: { OPENSPICE_ALLOW_PLOTS: "1" } });
    try {
      writeFileSync(join(c.work, "t.raw"), readFileSync(fixtureRaw));
      const res = await callTool(c.client, "openspice_read_raw", { path: "t.raw", plot_path: "p.svg" });
      const r = res.structuredContent as Record<string, any>;
      assert.equal(res.isError ?? false, false);
      assert.equal(r.plot.written, true);
      assert.ok(existsSync(join(c.work, "p.svg")));
    } finally {
      await c.close();
    }
  });

  it("reads a SPICE log and returns its text", async () => {
    const c = await connect();
    try {
      writeFileSync(join(c.work, "run.log"), "ngspice run\nWarning: something\nNo. of Data Rows : 2\n");
      const res = await callTool(c.client, "openspice_get_log", { path: "run.log" });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(res.isError ?? false, false);
      assert.match(s.text, /ngspice run/);
      assert.ok(s.errors.some((e: string) => /Warning/i.test(e)));
    } finally {
      await c.close();
    }
  });
});
