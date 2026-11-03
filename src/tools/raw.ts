/**
 * Raw-result and log tools (Requirement 7, 10, 18). All read a `.raw` or `.log`
 * from a path inside the roots.
 *
 *   - openspice_read_raw: parse a rawfile and return a bounded, downsampled
 *     summary plus optional complex magnitude/phase, optionally writing an
 *     LTspice-compatible raw beside it (verified by re-read) and/or an SVG plot
 *     (only when plotting is enabled).
 *   - openspice_raw_info: metadata only, no sample arrays.
 *   - openspice_export_waveforms: write selected variables to CSV/ASCII.
 *   - openspice_get_log: return a SPICE log and its parsed .meas results.
 *
 * None fabricate data: a truncated/unknown rawfile is RAW_PARSE_FAILED, and a
 * plot requested while plotting is disabled returns the numeric summary with a
 * diagnostic rather than an error.
 */

import { readFile, writeFile } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { exportWaveforms, parseMeas, rawInfo, readRaw, summarize } from "../raw.js";
import { renderPlot } from "../plot.js";
import { writeLtspiceRaw } from "../rawwrite.js";
import { defineTool } from "./define.js";

export function registerRawTools(server: McpServer, core: Core): void {
  registerReadRaw(server, core);
  registerRawInfo(server, core);
  registerExportWaveforms(server, core);
  registerGetLog(server, core);
}

function registerReadRaw(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_read_raw",
    {
      title: "Read a SPICE .raw result",
      description:
        "Parse a .raw file (ngspice Berkeley binary/ASCII or LTspice binary, with precision and flags detected from the header) from a path inside " +
        "the roots and return a bounded, downsampled summary per variable (min/max/final/mean/peak-to-peak and sample points), with complex " +
        "magnitude/phase for .ac data. Optionally write an LTspice-compatible .raw beside it (verified by re-reading; if it cannot be produced " +
        "faithfully the ngspice-native file is kept and a diagnostic is returned) and/or render an SVG plot (only when plotting is enabled; " +
        "otherwise a diagnostic is returned with the numeric summary). A truncated or unknown rawfile fails with RAW_PARSE_FAILED.",
      input: z
        .object({
          path: z.string(),
          variables: z.array(z.string()).optional(),
          max_points: z.number().int().positive().optional(),
          write_ltspice_raw: z.string().optional(),
          plot_path: z.string().optional(),
          overwrite: z.boolean().optional(),
        })
        .strict(),
      output: z.object({
        source: z.object({ path: z.string() }),
        format: z.string(),
        complex: z.boolean(),
        point_count: z.number(),
        variables: z.array(z.object({ name: z.string(), kind: z.string() })),
        summary: z.array(
          z.object({
            name: z.string(),
            kind: z.string(),
            min: z.number(),
            max: z.number(),
            final: z.number(),
            mean: z.number().nullable(),
            peak_to_peak: z.number().nullable(),
            samples: z.array(z.number()),
            complex_samples: z
              .array(z.object({ re: z.number(), im: z.number(), magnitude: z.number(), phase: z.number() }))
              .optional(),
          }),
        ),
        ltspice_raw: z
          .object({ written_path: z.string().nullable(), verified: z.boolean(), diagnostic: z.string().nullable(), uncertain: z.array(z.string()) })
          .nullable(),
        plot: z.object({ written: z.boolean(), path: z.string().nullable(), diagnostic: z.string().nullable() }).nullable(),
        diagnostics: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const resolved = await core.roots.resolveInside(args.path);
      const bytes = await readFile(resolved);
      const raw = readRaw(bytes);
      const summary = summarize(raw, args.variables ?? [], args.max_points ?? undefined);
      const diagnostics: string[] = [];

      let ltspiceRaw: { written_path: string | null; verified: boolean; diagnostic: string | null; uncertain: string[] } | null = null;
      if (typeof args.write_ltspice_raw === "string" && args.write_ltspice_raw !== "") {
        const written = writeLtspiceRaw(raw);
        if (written.verified) {
          const target = await core.roots.ensureWritable(args.write_ltspice_raw, args.overwrite === true);
          await writeFile(target, written.bytes);
          ltspiceRaw = { written_path: target, verified: true, diagnostic: null, uncertain: written.uncertain };
        } else {
          // Decline to write an unfaithful file; keep ngspice's native raw (R18.4).
          ltspiceRaw = { written_path: null, verified: false, diagnostic: written.diagnostic, uncertain: written.uncertain };
          if (written.diagnostic !== null) diagnostics.push(written.diagnostic);
        }
      }

      let plot: { written: boolean; path: string | null; diagnostic: string | null } | null = null;
      if (typeof args.plot_path === "string" && args.plot_path !== "") {
        const target = await core.roots.ensureWritable(args.plot_path, args.overwrite === true);
        const rendered = renderPlot(raw, args.variables ?? [], target, { allowPlots: core.config.allowPlots });
        plot = { written: rendered.written, path: rendered.path, diagnostic: rendered.diagnostic };
        if (rendered.diagnostic !== null) diagnostics.push(rendered.diagnostic);
      }

      return {
        source: { path: resolved },
        format: raw.format,
        complex: raw.complex,
        point_count: raw.pointCount,
        variables: raw.variables.map((v) => ({ name: v.name, kind: v.kind })),
        summary: summary.variables.map((v) => ({
          name: v.name,
          kind: v.kind,
          min: v.min,
          max: v.max,
          final: v.final,
          mean: v.mean,
          peak_to_peak: v.peakToPeak,
          samples: v.samples,
          ...(v.complexSamples !== undefined ? { complex_samples: v.complexSamples } : {}),
        })),
        ltspice_raw: ltspiceRaw,
        plot,
        diagnostics,
      };
    },
  );
}

function registerRawInfo(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_raw_info",
    {
      title: "Read .raw metadata",
      description:
        "Return metadata only for a .raw file inside the roots: format, title, plotname, flags, real vs complex, point count, the variable list, and " +
        "any step structure. No sample arrays are read, so this is cheap on large transients. A truncated or unknown rawfile fails with RAW_PARSE_FAILED.",
      input: z.object({ path: z.string() }).strict(),
      output: z.object({
        source: z.object({ path: z.string() }),
        format: z.string(),
        title: z.string(),
        plotname: z.string(),
        flags: z.array(z.string()),
        complex: z.boolean(),
        point_count: z.number(),
        variables: z.array(z.object({ index: z.number(), name: z.string(), kind: z.string() })),
        steps: z.object({ count: z.number(), values: z.array(z.number()) }).nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const resolved = await core.roots.resolveInside(args.path);
      const bytes = await readFile(resolved);
      const info = rawInfo(readRaw(bytes));
      return {
        source: { path: resolved },
        format: info.format,
        title: info.title,
        plotname: info.plotname,
        flags: info.flags,
        complex: info.complex,
        point_count: info.pointCount,
        variables: info.variables,
        steps: info.steps,
      };
    },
  );
}

function registerExportWaveforms(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_export_waveforms",
    {
      title: "Export .raw waveforms to CSV/ASCII",
      description:
        "Read a .raw file inside the roots and write selected variables (or all) to a CSV or whitespace-ASCII file inside the roots, one row per " +
        "point; complex (.ac) data writes :re/:im columns. The write refuses to overwrite unless overwrite is set. Returns the written path, row " +
        "count, and columns. A truncated or unknown rawfile fails with RAW_PARSE_FAILED.",
      input: z
        .object({
          path: z.string(),
          out_path: z.string(),
          variables: z.array(z.string()).optional(),
          format: z.enum(["csv", "ascii"]).optional(),
          overwrite: z.boolean().optional(),
        })
        .strict(),
      output: z.object({
        source: z.object({ path: z.string() }),
        written_path: z.string(),
        format: z.enum(["csv", "ascii"]),
        rows: z.number(),
        columns: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const resolved = await core.roots.resolveInside(args.path);
      const bytes = await readFile(resolved);
      const raw = readRaw(bytes);
      const format = args.format ?? "csv";
      const target = await core.roots.ensureWritable(args.out_path, args.overwrite === true);
      const result = exportWaveforms(raw, args.variables ?? [], target, format);
      return { source: { path: resolved }, written_path: result.path, format: result.format, rows: result.rows, columns: result.columns };
    },
  );
}

function registerGetLog(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_get_log",
    {
      title: "Read a SPICE log",
      description:
        "Read a SPICE .log file inside the roots and return its text (optionally only the last tail_lines lines) along with the measurements parsed " +
        "from it and any lines that look like errors/warnings. Pairs with openspice_simulate, which writes the log beside the .raw.",
      input: z.object({ path: z.string(), tail_lines: z.number().int().positive().optional() }).strict(),
      output: z.object({
        source: z.object({ path: z.string() }),
        text: z.string(),
        line_count: z.number(),
        truncated: z.boolean(),
        measurements: z.array(z.object({ name: z.string(), value: z.number() })),
        errors: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const resolved = await core.roots.resolveInside(args.path);
      const full = await readFile(resolved, "utf8");
      const lines = full.split(/\r\n|\r|\n/);
      const lineCount = lines.length;
      let text = full;
      let truncated = false;
      if (typeof args.tail_lines === "number" && args.tail_lines < lineCount) {
        text = lines.slice(lineCount - args.tail_lines).join("\n");
        truncated = true;
      }
      const errors = lines.filter((l) => /\b(error|fatal|aborted|warning|cannot|failed)\b/i.test(l)).slice(0, 200);
      return {
        source: { path: resolved },
        text,
        line_count: lineCount,
        truncated,
        measurements: parseMeas(full),
        errors,
      };
    },
  );
}
