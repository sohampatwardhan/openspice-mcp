import { resolve as resolvePath } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { parse, validate } from "../netlist.js";
import { defineTool } from "./define.js";
import { resolveInput } from "./input.js";

export function registerNetlistTool(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_parse_netlist",
    {
      title: "Parse a SPICE netlist",
      description:
        "Parse a SPICE netlist from a path inside the roots or inline text into a structured model: title, devices (type, instance, nodes, value " +
        "or model, params), subcircuits, models, includes (.include/.lib, recorded and resolved relative to the source dir within the roots), and " +
        "analysis/control directives (.op/.tran/.ac/.dc/.noise/.step/.meas/.param). Unparseable lines become diagnostics with 1-based line numbers " +
        "and parsing continues. With validate, also reports floating/single-connection nodes, duplicate instance names, missing models/subcircuits, " +
        "and a missing ground, without modifying anything.",
      input: z
        .object({
          path: z.string().optional(),
          text: z.string().optional(),
          validate: z.boolean().optional(),
        })
        .strict(),
      output: z.object({
        source: z.object({ path: z.string().nullable() }),
        title: z.string(),
        devices: z.array(
          z.object({
            kind: z.string(),
            name: z.string(),
            nodes: z.array(z.string()),
            value: z.string().nullable(),
            model: z.string().nullable(),
            params: z.record(z.string(), z.string()),
            line: z.number(),
          }),
        ),
        models: z.array(z.object({ name: z.string(), type: z.string(), params: z.record(z.string(), z.string()), line: z.number() })),
        subckts: z.array(z.object({ name: z.string(), ports: z.array(z.string()), device_count: z.number(), line: z.number() })),
        includes: z.array(
          z.object({
            kind: z.string(),
            path: z.string(),
            section: z.string().nullable(),
            resolved: z.string().nullable(),
            inside_roots: z.boolean(),
            line: z.number(),
          }),
        ),
        directives: z.array(z.object({ kind: z.string(), args: z.string(), line: z.number() })),
        diagnostics: z.array(z.object({ line: z.number(), text: z.string(), reason: z.string() })),
        validation: z
          .array(z.object({ rule: z.string(), severity: z.string(), message: z.string() }))
          .nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const input = await resolveInput(core, { path: args.path, text: args.text });
      const netlist = parse(input.bytes.toString("utf8"));

      // Resolve .include/.lib references relative to the source dir, confined to roots (Requirement 2.3).
      const includes = await Promise.all(
        netlist.includes.map(async (inc) => {
          const absolute = resolvePath(input.baseDir, inc.path);
          let resolved: string | null = null;
          let insideRoots = false;
          try {
            resolved = await core.roots.resolveInside(absolute);
            insideRoots = true;
          } catch {
            resolved = null;
            insideRoots = false;
          }
          return { kind: inc.kind, path: inc.path, section: inc.section, resolved, inside_roots: insideRoots, line: inc.line };
        }),
      );

      const validation = args.validate === true ? validate(netlist).map((v) => ({ rule: v.rule, severity: v.severity, message: v.message })) : null;

      return {
        source: { path: input.path },
        title: netlist.title,
        devices: netlist.devices.map((d) => ({ kind: d.kind, name: d.name, nodes: d.nodes, value: d.value, model: d.model, params: d.params, line: d.line })),
        models: netlist.models.map((m) => ({ name: m.name, type: m.type, params: m.params, line: m.line })),
        subckts: netlist.subckts.map((s) => ({ name: s.name, ports: s.ports, device_count: s.devices.length, line: s.line })),
        includes,
        directives: netlist.directives.map((d) => ({ kind: d.kind, args: d.args, line: d.line })),
        diagnostics: netlist.diagnostics,
        validation,
      };
    },
  );
}
