import { writeFile } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readAsc, readAsy } from "../asc.js";
import { toNetlist } from "../ascnet.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { generateAsc, type Circuit } from "../generate.js";
import { defineTool } from "./define.js";
import { resolveInput } from "./input.js";

export function registerSchematicTools(server: McpServer, core: Core): void {
  registerReadSchematic(server, core);
  registerSchematicToNetlist(server, core);
  registerGenerateSchematic(server, core);
}

function registerReadSchematic(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_read_schematic",
    {
      title: "Read an LTspice schematic or symbol",
      description:
        "Read an LTspice .asc schematic or .asy symbol from a path inside the roots (or inline text), decoding UTF-8/UTF-8-BOM/UTF-16LE and CRLF " +
        "and reporting the detected encoding. For .asc: placed components (symbol, instance, value, grid coordinates, rotation/mirror, attributes), " +
        "wires, net flags, and on-sheet directives (SPICE ! lines and ; comments). For .asy: pins in SPICE order, drawing primitives, and attributes. " +
        "Keywords the reader does not model are preserved as raw entries with a diagnostic rather than dropped. kind defaults to the path extension.",
      input: z
        .object({
          path: z.string().optional(),
          text: z.string().optional(),
          kind: z.enum(["asc", "asy"]).optional(),
        })
        .strict(),
      output: z.object({
        source: z.object({ path: z.string().nullable() }),
        kind: z.enum(["asc", "asy"]),
        encoding: z.string(),
        schematic: z
          .object({
            version: z.string().nullable(),
            sheet: z.object({ index: z.number(), width: z.number(), height: z.number() }).nullable(),
            components: z.array(
              z.object({
                symbol: z.string(),
                inst_name: z.string().nullable(),
                value: z.string().nullable(),
                x: z.number(),
                y: z.number(),
                rotation: z.number(),
                mirror: z.boolean(),
                attributes: z.record(z.string(), z.string()),
              }),
            ),
            wires: z.array(z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() })),
            flags: z.array(z.object({ x: z.number(), y: z.number(), net: z.string() })),
            directives: z.array(z.object({ kind: z.string(), text: z.string(), x: z.number(), y: z.number() })),
          })
          .nullable(),
        symbol: z
          .object({
            symbol_type: z.string().nullable(),
            pins: z.array(z.object({ name: z.string(), order: z.number(), x: z.number(), y: z.number() })),
            primitives: z.array(z.object({ kind: z.string(), args: z.string() })),
            attributes: z.record(z.string(), z.string()),
          })
          .nullable(),
        raw: z.array(z.object({ keyword: z.string(), text: z.string(), line: z.number() })),
        diagnostics: z.array(z.object({ line: z.number(), text: z.string(), reason: z.string() })),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const input = await resolveInput(core, { path: args.path, text: args.text });
      const kind = resolveKind(args.kind, input.path);

      if (kind === "asy") {
        const sym = readAsy(input.bytes);
        return {
          source: { path: input.path },
          kind,
          encoding: sym.encoding,
          schematic: null,
          symbol: {
            symbol_type: sym.symbolType,
            pins: sym.pins,
            primitives: sym.primitives,
            attributes: sym.attributes,
          },
          raw: sym.raw,
          diagnostics: sym.diagnostics,
        };
      }

      const schematic = readAsc(input.bytes);
      return {
        source: { path: input.path },
        kind,
        encoding: schematic.encoding,
        schematic: {
          version: schematic.version,
          sheet: schematic.sheet,
          components: schematic.components.map((c) => ({
            symbol: c.symbol,
            inst_name: c.instName,
            value: c.value,
            x: c.x,
            y: c.y,
            rotation: c.rotation,
            mirror: c.mirror,
            attributes: c.attributes,
          })),
          wires: schematic.wires,
          flags: schematic.flags,
          directives: schematic.directives,
        },
        symbol: null,
        raw: schematic.raw,
        diagnostics: schematic.diagnostics,
      };
    },
  );
}

/** Convert an LTspice `.asc` schematic to a SPICE netlist (Requirement 4). */
function registerSchematicToNetlist(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_schematic_to_netlist",
    {
      title: "Convert an LTspice schematic to a netlist",
      description:
        "Read an LTspice .asc from a path inside the roots (or inline text) and derive a SPICE netlist: nets come from wire endpoints and net " +
        "labels, each component's nodes are ordered by its symbol's SPICE pin order (resolved from the bundled open symbol set and the configured " +
        "symbol search path), and shorts or unconnected pins become warnings rather than silent drops. Returns the netlist text and structured " +
        "devices. With out_path (inside the roots) the netlist is also written; writes refuse to overwrite unless overwrite is set.",
      input: z
        .object({
          path: z.string().optional(),
          text: z.string().optional(),
          out_path: z.string().optional(),
          overwrite: z.boolean().optional(),
        })
        .strict(),
      output: z.object({
        source: z.object({ path: z.string().nullable() }),
        netlist_text: z.string(),
        devices: z.array(z.object({ kind: z.string(), name: z.string(), nodes: z.array(z.string()), value: z.string().nullable(), model: z.string().nullable() })),
        warnings: z.array(z.string()),
        written_path: z.string().nullable(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const input = await resolveInput(core, { path: args.path, text: args.text });
      const schematic = readAsc(input.bytes);
      const converted = await toNetlist(schematic, core.symbols);

      let writtenPath: string | null = null;
      if (typeof args.out_path === "string" && args.out_path !== "") {
        const target = await core.roots.ensureWritable(args.out_path, args.overwrite === true);
        await writeFile(target, converted.text, "utf8");
        writtenPath = target;
      }

      return {
        source: { path: input.path },
        netlist_text: converted.text,
        devices: converted.netlist.devices.map((d) => ({ kind: d.kind, name: d.name, nodes: d.nodes, value: d.value, model: d.model })),
        warnings: converted.warnings,
        written_path: writtenPath,
      };
    },
  );
}

/** Generate an LTspice-openable `.asc` from a description and verify it by round trip (Requirement 5, 11, 18). */
function registerGenerateSchematic(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_generate_schematic",
    {
      title: "Generate an LTspice schematic from a description",
      description:
        "Generate an LTspice-openable .asc from a structured circuit (devices with kind, instance name, nodes in SPICE pin order, and a value or " +
        "model, plus on-sheet directives), with deterministic grid placement, orthogonal routing, ground flags on 0/GND, and net-label flags. The " +
        "geometry is always verified by round trip: the generated .asc is converted back to a netlist and its device set and connectivity are " +
        "compared with the intended circuit. An inconsistent description fails with GENERATE_INVALID; in strict mode a round-trip mismatch fails " +
        "with GENERATE_UNVERIFIED, otherwise verified is false with diffs. With out_path the .asc is written (overwrite guarded); netlist_out_path " +
        "also writes the equivalent netlist.",
      input: z
        .object({
          title: z.string().optional(),
          devices: z
            .array(
              z
                .object({
                  kind: z.string(),
                  name: z.string(),
                  nodes: z.array(z.string()),
                  value: z.string().nullable().optional(),
                  model: z.string().nullable().optional(),
                })
                .strict(),
            )
            .min(1),
          directives: z.array(z.string()).optional(),
          strict: z.boolean().optional(),
          out_path: z.string().optional(),
          netlist_out_path: z.string().optional(),
          overwrite: z.boolean().optional(),
        })
        .strict(),
      output: z.object({
        verified: z.boolean(),
        diffs: z.array(z.string()),
        counts: z.object({ devices: z.number(), nets: z.number() }),
        encoding: z.string(),
        asc_text: z.string(),
        netlist_text: z.string(),
        written_path: z.string().nullable(),
        netlist_written_path: z.string().nullable(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const circuit: Circuit = {
        title: args.title ?? "",
        devices: args.devices.map((d) => ({ kind: d.kind, name: d.name, nodes: d.nodes, value: d.value ?? null, model: d.model ?? null })),
        directives: args.directives ?? [],
      };
      // generateAsc throws GENERATE_INVALID / GENERATE_UNVERIFIED (strict) as ToolErrors.
      const result = await generateAsc(circuit, { strict: args.strict === true });

      let writtenPath: string | null = null;
      let netlistWrittenPath: string | null = null;
      if (typeof args.out_path === "string" && args.out_path !== "") {
        const target = await core.roots.ensureWritable(args.out_path, args.overwrite === true);
        await writeFile(target, result.bytes);
        writtenPath = target;
      }
      if (typeof args.netlist_out_path === "string" && args.netlist_out_path !== "") {
        const target = await core.roots.ensureWritable(args.netlist_out_path, args.overwrite === true);
        await writeFile(target, result.netlistText, "utf8");
        netlistWrittenPath = target;
      }

      return {
        verified: result.verified,
        diffs: result.diffs,
        counts: result.counts,
        encoding: result.encoding,
        asc_text: result.bytes.toString("utf8"),
        netlist_text: result.netlistText,
        written_path: writtenPath,
        netlist_written_path: netlistWrittenPath,
      };
    },
  );
}

/** Pick asc/asy from an explicit kind or the path extension; default to asc for inline text. */
function resolveKind(explicit: "asc" | "asy" | undefined, path: string | null): "asc" | "asy" {
  if (explicit !== undefined) return explicit;
  if (path !== null && path.toLowerCase().endsWith(".asy")) return "asy";
  if (path !== null && path.toLowerCase().endsWith(".asc")) return "asc";
  // Inline text without a kind: default to schematic.
  if (path === null) return "asc";
  throw new ToolError("INVALID_ARGUMENT", `cannot tell whether ${JSON.stringify(path)} is a .asc or .asy; pass kind`, { path });
}
