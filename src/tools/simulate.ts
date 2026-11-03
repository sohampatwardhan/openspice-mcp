/**
 * `openspice_simulate` (Requirement 6, 15). Runs a circuit with ngspice in
 * LTspice compatibility mode through the runner, which owns the per-run
 * `.spiceinit`, the fixed argv, the tracked child, the timeout, and the `.step`
 * emulator. Input is a SPICE netlist (path inside the roots or inline text) or
 * an LTspice `.asc`, which is converted to a netlist first. The tool surfaces the
 * run status, the raw/log paths, a bounded waveform summary, parsed `.meas`
 * results, and the compatibility translations the layer recorded.
 *
 * It does not fabricate success: `UNSUPPORTED_LTSPICE_FEATURE` (from the compat
 * layer), `BACKEND_NOT_FOUND`, `SIM_TIMEOUT`, `SIM_FAILED`, and
 * `RAW_PARSE_FAILED` all propagate as tool errors with their details.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readAsc } from "../asc.js";
import { toNetlist } from "../ascnet.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { parse, type Netlist } from "../netlist.js";
import { summarize } from "../raw.js";
import { runSimulation } from "../runner.js";
import { defineTool } from "./define.js";
import { resolveInput } from "./input.js";

export function registerSimulateTool(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_simulate",
    {
      title: "Simulate a circuit with ngspice",
      description:
        "Run a SPICE netlist (path inside the roots or inline text) or an LTspice .asc (converted to a netlist first) with ngspice in LTspice " +
        "compatibility mode (set ngbehavior=lt, written to a per-run config, never your global .spiceinit). The analysis comes from the deck's " +
        ".tran/.ac/.dc/.op/.noise directive; .step is emulated with a control loop into a stepped result; .meas runs in the same batch. Returns the " +
        "run status, the .raw and .log paths, a bounded downsampled waveform summary, parsed measurements, and the LTspice-compatibility " +
        "translations applied. An LTspice-only construct ngspice cannot run is reported as UNSUPPORTED_LTSPICE_FEATURE with its line; a failed or " +
        "timed-out run is SIM_FAILED/SIM_TIMEOUT with a log tail. Pass design_id (from openspice_designs) to associate this run's .raw/.log with " +
        "that open design (Requirement 10.1); an unknown id fails with DESIGN_NOT_FOUND.",
      input: z
        .object({
          path: z.string().optional(),
          text: z.string().optional(),
          kind: z.enum(["netlist", "asc"]).optional(),
          variables: z.array(z.string()).optional(),
          max_points: z.number().int().positive().optional(),
          timeout_ms: z.number().int().positive().optional(),
          step_device: z.record(z.string(), z.string()).optional(),
          design_id: z.string().optional(),
        })
        .strict(),
      output: z.object({
        status: z.literal("ok"),
        source: z.object({ path: z.string().nullable(), kind: z.enum(["netlist", "asc"]) }),
        design_id: z.string().nullable(),
        raw_path: z.string(),
        log_path: z.string(),
        run_dir: z.string(),
        complex: z.boolean(),
        point_count: z.number(),
        steps: z.number().nullable(),
        variables: z.array(z.object({ name: z.string(), kind: z.string() })),
        summary: z.array(
          z.object({
            name: z.string(),
            kind: z.string(),
            min: z.number().nullable(),
            max: z.number().nullable(),
            final: z.number().nullable(),
            mean: z.number().nullable(),
            peak_to_peak: z.number().nullable(),
            samples: z.array(z.number().nullable()),
          }),
        ),
        measurements: z.array(z.object({ name: z.string(), value: z.number() })),
        translations: z.array(z.object({ construct: z.string(), line: z.number().nullable(), message: z.string() })),
        warnings: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const input = await resolveInput(core, { path: args.path, text: args.text });
      const kind = resolveKind(args.kind, input.path);
      const warnings: string[] = [];

      // Validate an optional design association up front so an unknown id fails
      // with DESIGN_NOT_FOUND before any ngspice process is spawned (R10.1).
      const designId = typeof args.design_id === "string" && args.design_id !== "" ? args.design_id : null;
      if (designId !== null && !core.designs.has(designId)) {
        throw new ToolError("DESIGN_NOT_FOUND", `no open design with id ${JSON.stringify(designId)}`, { id: designId });
      }

      let netlist: Netlist;
      if (kind === "asc") {
        const schematic = readAsc(input.bytes);
        const converted = await toNetlist(schematic, core.symbols);
        warnings.push(...converted.warnings);
        netlist = converted.netlist;
      } else {
        netlist = parse(input.bytes.toString("utf8"));
      }

      const result = await runSimulation(netlist, {
        roots: core.roots,
        ngspiceBin: core.config.ngspiceBin,
        timeoutMs: args.timeout_ms ?? core.config.simTimeoutMs,
        stepDevice: args.step_device,
      });

      const summary = summarize(result.raw, args.variables ?? [], args.max_points ?? undefined);

      // Associate the run's artifacts with the open design (R10.1). The id was
      // validated above, so this cannot fail here.
      if (designId !== null) {
        core.designs.setResult(designId, { rawPath: result.rawPath, logPath: result.logPath, runDir: result.runDir });
      }

      return {
        status: "ok" as const,
        source: { path: input.path, kind },
        design_id: designId,
        raw_path: result.rawPath,
        log_path: result.logPath,
        run_dir: result.runDir,
        complex: result.raw.complex,
        point_count: result.raw.pointCount,
        steps: result.stepped?.count ?? null,
        variables: result.raw.variables.map((v) => ({ name: v.name, kind: v.kind })),
        summary: summary.variables.map((v) => ({
          name: v.name,
          kind: v.kind,
          min: v.min,
          max: v.max,
          final: v.final,
          mean: v.mean,
          peak_to_peak: v.peakToPeak,
          samples: v.samples,
        })),
        measurements: result.measurements,
        translations: result.translations,
        warnings,
      };
    },
  );
}

/** Pick netlist/asc from an explicit kind or the path extension; default to netlist for inline text. */
function resolveKind(explicit: "netlist" | "asc" | undefined, path: string | null): "netlist" | "asc" {
  if (explicit !== undefined) return explicit;
  if (path !== null && path.toLowerCase().endsWith(".asc")) return "asc";
  return "netlist";
}
