// End-to-end over stdio with the real ngspice 44.2 engine: generate an RC
// low-pass .asc from a structured description (round-trip verified), write it
// into the roots, then simulate it (as a schematic) with a transient and an AC
// sweep, read the resulting .raw, and check a measurement within tolerance. This
// exercises the task-7 generator and the task-12 generate/simulate/raw tools
// together against a real engine, not a fixture.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

// R = 1k, C = 159n -> fc = 1/(2*pi*R*C) ~= 1001 Hz.
const R = 1000;
const C = 159e-9;
const FC = 1 / (2 * Math.PI * R * C);

describe("end-to-end generate -> simulate -> read (real ngspice 44.2)", { skip: !hasReal }, () => {
  it("generates an RC low-pass .asc, round-trips it, and writes it into the roots", async () => {
    const c = await connect({ env: { OPENSPICE_NGSPICE_BIN: "/usr/bin/ngspice" } });
    try {
      const gen = await callTool(c.client, "openspice_generate_schematic", {
        title: "RC low-pass",
        devices: [
          { kind: "V", name: "V1", nodes: ["in", "0"], value: "AC 1 PULSE(0 1 0 1n 1n 5m 10m)" },
          { kind: "R", name: "R1", nodes: ["in", "out"], value: "1k" },
          { kind: "C", name: "C1", nodes: ["out", "0"], value: "159n" },
        ],
        directives: [".tran 10u 2m"],
        strict: true,
        out_path: "rc.asc",
      });
      const g = gen.structuredContent as Record<string, any>;
      assert.equal(gen.isError ?? false, false);
      assert.equal(g.verified, true);
      assert.deepEqual(g.diffs, []);
      assert.ok(String(g.written_path).endsWith("rc.asc"));
      assert.ok(existsSync(g.written_path));
    } finally {
      await c.close();
    }
  });

  it("simulates the generated .asc as a transient and reads the .raw back", async () => {
    const c = await connect({ env: { OPENSPICE_NGSPICE_BIN: "/usr/bin/ngspice" } });
    try {
      await callTool(c.client, "openspice_generate_schematic", {
        title: "RC low-pass tran",
        devices: [
          { kind: "V", name: "V1", nodes: ["in", "0"], value: "PULSE(0 1 0 1n 1n 5m 10m)" },
          { kind: "R", name: "R1", nodes: ["in", "out"], value: "1k" },
          { kind: "C", name: "C1", nodes: ["out", "0"], value: "159n" },
        ],
        directives: [".tran 10u 2m", ".meas tran vfinal FIND v(out) AT 2m"],
        strict: true,
        out_path: "rc_tran.asc",
      });

      const sim = await callTool(c.client, "openspice_simulate", { path: "rc_tran.asc", kind: "asc", variables: ["v(out)"] });
      assert.equal(sim.isError ?? false, false, sim.content[0]?.text);
      const s = sim.structuredContent as Record<string, any>;
      assert.equal(s.status, "ok");
      assert.equal(s.complex, false);
      assert.ok(s.point_count > 10);
      const vout = s.summary.find((v: any) => v.name.toLowerCase() === "v(out)");
      assert.ok(vout, "summary includes v(out)");
      // After ~2ms (>>tau=159us) with a 1V step the cap is nearly fully charged.
      assert.ok(vout.max > 0.9 && vout.max <= 1.0001, `vout max ${vout.max}`);

      // Read the resulting .raw directly and confirm the same shape.
      const rawInfo = await callTool(c.client, "openspice_raw_info", { path: s.raw_path });
      const ri = rawInfo.structuredContent as Record<string, any>;
      assert.equal(ri.complex, false);
      assert.ok(ri.variables.some((v: any) => v.name.toLowerCase() === "v(out)"));

      // The .meas measurement should be present and ~1V.
      const log = await callTool(c.client, "openspice_get_log", { path: s.log_path });
      const l = log.structuredContent as Record<string, any>;
      const vfinal = (l.measurements as any[]).find((m) => m.name === "vfinal");
      assert.ok(vfinal && vfinal.value > 0.9 && vfinal.value <= 1.0001, `vfinal ${vfinal?.value}`);
    } finally {
      await c.close();
    }
  });

  it("simulates the generated .asc as an AC sweep and sees -3 dB near the cutoff", async () => {
    const c = await connect({ env: { OPENSPICE_NGSPICE_BIN: "/usr/bin/ngspice" } });
    try {
      await callTool(c.client, "openspice_generate_schematic", {
        title: "RC low-pass ac",
        devices: [
          { kind: "V", name: "V1", nodes: ["in", "0"], value: "AC 1" },
          { kind: "R", name: "R1", nodes: ["in", "out"], value: "1k" },
          { kind: "C", name: "C1", nodes: ["out", "0"], value: "159n" },
        ],
        directives: [".ac dec 50 1 1meg"],
        strict: true,
        out_path: "rc_ac.asc",
      });

      const sim = await callTool(c.client, "openspice_simulate", { path: "rc_ac.asc", kind: "asc", variables: ["v(out)"], max_points: 200000 });
      assert.equal(sim.isError ?? false, false, sim.content[0]?.text);
      const s = sim.structuredContent as Record<string, any>;
      assert.equal(s.status, "ok");
      assert.equal(s.complex, true);

      // Export to CSV, then read the raw to find the magnitude nearest the cutoff.
      const raw = await callTool(c.client, "openspice_read_raw", { path: s.raw_path, variables: ["v(out)", "frequency"] });
      const r = raw.structuredContent as Record<string, any>;
      const vout = r.summary.find((v: any) => v.name.toLowerCase() === "v(out)");
      const freq = r.summary.find((v: any) => v.name.toLowerCase() === "frequency");
      assert.ok(vout?.complex_samples && freq?.samples, "complex samples and frequency present");

      // Find the sample whose frequency is closest to fc and check |H| ~ 0.707.
      const freqs: number[] = freq.samples;
      let best = 0;
      for (let i = 1; i < freqs.length; i++) {
        if (Math.abs(freqs[i]! - FC) < Math.abs(freqs[best]! - FC)) best = i;
      }
      const mag = vout.complex_samples[best].magnitude as number;
      assert.ok(Math.abs(mag - Math.SQRT1_2) < 0.03, `|H(fc)| ~= ${mag} (expected ~0.707 at ${FC.toFixed(1)} Hz, sample ${freqs[best]?.toFixed(1)} Hz)`);
    } finally {
      await c.close();
    }
  });
});
