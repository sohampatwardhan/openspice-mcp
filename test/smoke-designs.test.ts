// Drives the task-16 tools over stdio with the MCP Client: the open-designs
// session (open/list/active/get/set/snapshot/restore/list_changed), the netlist
// text helpers, and the reference lookup. The netlist-edit -> simulate path is
// exercised against real ngspice 44.2 when present.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { connect } from "./smoke-helpers.js";

const hasReal = existsSync("/usr/bin/ngspice");

interface Structured {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text: string }[];
}

async function callTool(client: import("@modelcontextprotocol/sdk/client/index.js").Client, name: string, args: Record<string, unknown>): Promise<Structured> {
  return (await client.callTool({ name, arguments: args })) as unknown as Structured;
}

const RC = ["rc", "V1 in 0 PULSE(0 1 0 1n 1n 5m 10m)", "R1 in out 1k", "C1 out 0 159n", ".tran 10u 2m", ".end", ""].join("\n");

describe("openspice_designs", () => {
  it("opens, gets, edits, snapshots, restores, and lists changes", async () => {
    const c = await connect();
    try {
      writeFileSync(join(c.work, "a.cir"), RC);
      const open = await callTool(c.client, "openspice_designs", { action: "open", path: "a.cir" });
      const o = open.structuredContent as Record<string, any>;
      assert.equal(o.design.kind, "netlist");
      assert.equal(o.design.active, true);
      const id = o.design.id as string;

      const list = await callTool(c.client, "openspice_designs", { action: "list" });
      assert.equal((list.structuredContent as any).designs.length, 1);

      const active = await callTool(c.client, "openspice_designs", { action: "active" });
      assert.equal((active.structuredContent as any).design.id, id);

      const get = await callTool(c.client, "openspice_designs", { action: "get_content", id });
      assert.match((get.structuredContent as any).content, /R1 in out 1k/);

      // Invalid content is rejected, file unchanged.
      const bad = await callTool(c.client, "openspice_designs", { action: "set_content", id, content: "rc\n@@@ bad line\n.end\n" });
      const b = bad.structuredContent as Record<string, any>;
      assert.equal(b.written, false);
      assert.ok(b.diagnostic);

      // Valid edit with snapshot.
      const set = await callTool(c.client, "openspice_designs", { action: "set_content", id, content: RC.replace("1k", "2k2"), snapshot: true });
      const se = set.structuredContent as Record<string, any>;
      assert.equal(se.written, true);
      assert.ok(se.snapshot_id);
      const after = await callTool(c.client, "openspice_designs", { action: "get_content", id });
      assert.match((after.structuredContent as any).content, /2k2/);

      // Restore the snapshot.
      const restore = await callTool(c.client, "openspice_designs", { action: "restore", id });
      assert.equal((restore.structuredContent as any).restored, true);
      const restored = await callTool(c.client, "openspice_designs", { action: "get_content", id });
      assert.match((restored.structuredContent as any).content, /1k/);

      // list_changed advances with a cursor.
      const changed = await callTool(c.client, "openspice_designs", { action: "list_changed", cursor: 0 });
      const ch = changed.structuredContent as Record<string, any>;
      assert.ok(ch.changed.some((x: any) => x.id === id));
      assert.ok(ch.cursor >= 1);
    } finally {
      await c.close();
    }
  });

  it("rejects an unknown design id with DESIGN_NOT_FOUND", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_designs", { action: "get_content", id: "design-999" });
      assert.equal(res.isError, true);
      assert.match(res.content[0]?.text ?? "", /DESIGN_NOT_FOUND/);
    } finally {
      await c.close();
    }
  });
});

describe("openspice_netlist_edit", () => {
  it("adds a .meas directive to inline text without simulating", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_netlist_edit", {
        op: "add_meas",
        text: RC,
        meas: { analysis: "tran", name: "vfinal", expr: "FIND v(out) AT=2m" },
      });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(s.changed, true);
      assert.equal(s.diagnostic, null);
      assert.match(s.text, /\.meas tran vfinal FIND v\(out\) AT=2m/);
    } finally {
      await c.close();
    }
  });

  it("returns a diagnostic for an absent parameterize target and leaves text unchanged", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_netlist_edit", { op: "parameterize", text: RC, param: { device: "R9", name: "rv" } });
      const s = res.structuredContent as Record<string, any>;
      assert.equal(s.changed, false);
      assert.ok(s.diagnostic);
      assert.equal(s.text, RC);
    } finally {
      await c.close();
    }
  });

  it("writes the edited netlist into the roots when out_path is given", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_netlist_edit", {
        op: "add_step",
        text: RC,
        step: { param: "rl", values: ["1k", "2k", "3k"], default: "1k" },
        out_path: "stepped.cir",
      });
      const s = res.structuredContent as Record<string, any>;
      assert.ok(String(s.written_path).endsWith("stepped.cir"));
      assert.ok(existsSync(s.written_path));
    } finally {
      await c.close();
    }
  });

  it("add_meas then simulate yields the measurement (real ngspice 44.2)", { skip: !hasReal }, async () => {
    const c = await connect({ env: { OPENSPICE_NGSPICE_BIN: "/usr/bin/ngspice" } });
    try {
      const edit = await callTool(c.client, "openspice_netlist_edit", {
        op: "add_meas",
        text: RC,
        meas: { analysis: "tran", name: "vfinal", expr: "FIND v(out) AT=2m" },
      });
      const edited = (edit.structuredContent as Record<string, any>).text as string;

      const sim = await callTool(c.client, "openspice_simulate", { text: edited, kind: "netlist", variables: ["v(out)"] });
      assert.equal(sim.isError ?? false, false, sim.content[0]?.text);
      const s = sim.structuredContent as Record<string, any>;
      assert.equal(s.status, "ok");
      const vfinal = (s.measurements as any[]).find((m) => m.name === "vfinal");
      assert.ok(vfinal && vfinal.value > 0.9 && vfinal.value <= 1.0001, `vfinal ${vfinal?.value}`);
    } finally {
      await c.close();
    }
  });
});

describe("openspice_reference", () => {
  it("lists OpenSPICE and ngspice entries and fetches an OpenSPICE doc", async () => {
    const c = await connect();
    try {
      const list = await callTool(c.client, "openspice_reference", { action: "list" });
      const entries = (list.structuredContent as any).entries as any[];
      assert.ok(entries.some((e) => e.source === "openspice"));
      assert.ok(entries.some((e) => e.source === "ngspice"));
      assert.ok(!entries.some((e) => e.source === "ltspice-help"));

      const own = entries.find((e) => e.source === "openspice");
      const get = await callTool(c.client, "openspice_reference", { action: "get", id: own.id });
      const doc = (get.structuredContent as any).doc;
      assert.equal(doc.source, "openspice");
      assert.ok(doc.text && doc.text.length > 0);
      assert.equal(doc.url, null);
    } finally {
      await c.close();
    }
  });

  it("fails with INVALID_ARGUMENT on an unknown reference id", async () => {
    const c = await connect();
    try {
      const res = await callTool(c.client, "openspice_reference", { action: "get", id: "nope" });
      assert.equal(res.isError, true);
      assert.match(res.content[0]?.text ?? "", /INVALID_ARGUMENT/);
    } finally {
      await c.close();
    }
  });
});
