import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readAsc, readAsy } from "../asc.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { defineTool } from "./define.js";
import { resolveInput } from "./input.js";

export function registerSchematicTools(server: McpServer, core: Core): void {
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

/** Pick asc/asy from an explicit kind or the path extension; default to asc for inline text. */
function resolveKind(explicit: "asc" | "asy" | undefined, path: string | null): "asc" | "asy" {
  if (explicit !== undefined) return explicit;
  if (path !== null && path.toLowerCase().endsWith(".asy")) return "asy";
  if (path !== null && path.toLowerCase().endsWith(".asc")) return "asc";
  // Inline text without a kind: default to schematic.
  if (path === null) return "asc";
  throw new ToolError("CONTENT_TOO_LARGE", `cannot tell whether ${JSON.stringify(path)} is a .asc or .asy; pass kind`, { path });
}
