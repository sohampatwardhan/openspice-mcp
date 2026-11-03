/**
 * `openspice_designs` and `openspice_netlist_edit` (Requirement 9, 12). The
 * designs tool is the file-based "open designs" surface: open / list / active /
 * get_content / set_content / snapshot / restore / list_changed, all keyed by a
 * stable design id and confined to the roots. An unknown id is DESIGN_NOT_FOUND;
 * set_content never writes when the new content fails to parse (Requirement 9.6).
 *
 * The netlist-edit tool applies the `.meas`/`.step`/parameterize text helpers to
 * netlist text (path inside the roots or inline) and returns the edited text; it
 * never simulates (Requirement 12), and an absent target returns a diagnostic
 * with the text unchanged.
 */

import { writeFile } from "node:fs/promises";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { addMeas, addStep, parameterize } from "../edits.js";
import { defineTool } from "./define.js";
import { resolveInput } from "./input.js";

export function registerDesignTools(server: McpServer, core: Core): void {
  registerDesigns(server, core);
  registerNetlistEdit(server, core);
}

function registerDesigns(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_designs",
    {
      title: "Manage open designs",
      description:
        "The file-based open-designs session. action=open records an .asc/.asy/netlist path inside the roots and makes it the active design; " +
        "list returns every open design (id, path, kind, active); active returns the active design or null; get_content returns a design's current " +
        "text and detected encoding; set_content validates new content (a parse error means no write, Requirement 9.6) and writes it back, preserving " +
        "a schematic's original encoding and CRLF, optionally snapshotting the prior content first; restore puts the most recent snapshot back; " +
        "list_changed returns designs changed since a cursor. An unknown id fails with DESIGN_NOT_FOUND.",
      input: z
        .object({
          action: z.enum(["open", "list", "active", "get_content", "set_content", "snapshot", "restore", "list_changed"]),
          path: z.string().optional(),
          id: z.string().optional(),
          content: z.string().optional(),
          snapshot: z.boolean().optional(),
          cursor: z.number().int().nonnegative().optional(),
        })
        .strict(),
      output: z.object({
        action: z.string(),
        design: z.object({ id: z.string(), path: z.string(), kind: z.enum(["schematic", "netlist"]), active: z.boolean() }).nullable(),
        designs: z.array(z.object({ id: z.string(), path: z.string(), kind: z.enum(["schematic", "netlist"]), active: z.boolean() })).nullable(),
        content: z.string().nullable(),
        encoding: z.string().nullable(),
        written: z.boolean().nullable(),
        restored: z.boolean().nullable(),
        snapshot_id: z.string().nullable(),
        changed: z.array(z.object({ id: z.string(), path: z.string(), at: z.number() })).nullable(),
        cursor: z.number().nullable(),
        diagnostic: z.string().nullable(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const base = {
        action: args.action,
        design: null as null | { id: string; path: string; kind: "schematic" | "netlist"; active: boolean },
        designs: null as null | { id: string; path: string; kind: "schematic" | "netlist"; active: boolean }[],
        content: null as string | null,
        encoding: null as string | null,
        written: null as boolean | null,
        restored: null as boolean | null,
        snapshot_id: null as string | null,
        changed: null as null | { id: string; path: string; at: number }[],
        cursor: null as number | null,
        diagnostic: null as string | null,
      };

      switch (args.action) {
        case "open": {
          if (typeof args.path !== "string" || args.path === "") throw new ToolError("INVALID_ARGUMENT", "open requires a path", { action: args.action });
          return { ...base, design: await core.designs.open(args.path) };
        }
        case "list":
          return { ...base, designs: core.designs.list() };
        case "active":
          return { ...base, design: core.designs.active() };
        case "get_content": {
          const id = requireId(args.id, args.action);
          const got = await core.designs.getContent(id);
          return { ...base, design: find(core, id), content: got.text, encoding: got.encoding };
        }
        case "set_content": {
          const id = requireId(args.id, args.action);
          if (typeof args.content !== "string") throw new ToolError("INVALID_ARGUMENT", "set_content requires content", { action: args.action });
          const res = await core.designs.setContent(id, args.content, { snapshot: args.snapshot === true });
          return { ...base, design: find(core, id), written: res.written, snapshot_id: res.snapshotId, diagnostic: res.diagnostic };
        }
        case "snapshot": {
          // A standalone snapshot writes the current content back unchanged while taking a snapshot.
          const id = requireId(args.id, args.action);
          const current = await core.designs.getContent(id);
          const res = await core.designs.setContent(id, current.text, { snapshot: true });
          return { ...base, design: find(core, id), written: res.written, snapshot_id: res.snapshotId, diagnostic: res.diagnostic };
        }
        case "restore": {
          const id = requireId(args.id, args.action);
          const res = await core.designs.restore(id);
          return { ...base, design: find(core, id), restored: res.restored, diagnostic: res.diagnostic };
        }
        case "list_changed": {
          const res = core.designs.listChanged(args.cursor ?? 0);
          return { ...base, changed: res.changed, cursor: res.cursor };
        }
        default:
          throw new ToolError("INVALID_ARGUMENT", `unknown action ${JSON.stringify(args.action)}`, { action: args.action });
      }
    },
  );
}

function registerNetlistEdit(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_netlist_edit",
    {
      title: "Edit netlist text (.meas / .step / parameterize)",
      description:
        "Apply a text helper to a SPICE netlist (path inside the roots or inline text) and return the edited text without simulating. op=add_meas " +
        "inserts or updates a .meas directive (analysis, name, expr); op=add_step adds a .param default and a .step list for a parameter; " +
        "op=parameterize replaces a device's literal value with a {name} reference and adds a .param with the original value. A helper whose target " +
        "is absent (or an empty value set) returns a diagnostic and leaves the text unchanged. With out_path the edited text is written inside the " +
        "roots (overwrite guarded).",
      input: z
        .object({
          op: z.enum(["add_meas", "add_step", "parameterize"]),
          path: z.string().optional(),
          text: z.string().optional(),
          meas: z.object({ analysis: z.string(), name: z.string(), expr: z.string() }).strict().optional(),
          step: z.object({ param: z.string(), values: z.array(z.string()), default: z.string() }).strict().optional(),
          param: z.object({ device: z.string(), name: z.string() }).strict().optional(),
          out_path: z.string().optional(),
          overwrite: z.boolean().optional(),
        })
        .strict(),
      output: z.object({
        op: z.string(),
        source: z.object({ path: z.string().nullable() }),
        text: z.string(),
        changed: z.boolean(),
        diagnostic: z.string().nullable(),
        written_path: z.string().nullable(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const input = await resolveInput(core, { path: args.path, text: args.text });
      const original = input.bytes.toString("utf8");

      let result;
      if (args.op === "add_meas") {
        if (args.meas === undefined) throw new ToolError("INVALID_ARGUMENT", "add_meas requires a meas spec", { op: args.op });
        result = addMeas(original, args.meas);
      } else if (args.op === "add_step") {
        if (args.step === undefined) throw new ToolError("INVALID_ARGUMENT", "add_step requires a step spec", { op: args.op });
        result = addStep(original, args.step);
      } else {
        if (args.param === undefined) throw new ToolError("INVALID_ARGUMENT", "parameterize requires a param spec", { op: args.op });
        result = parameterize(original, args.param);
      }

      let writtenPath: string | null = null;
      if (result.changed && typeof args.out_path === "string" && args.out_path !== "") {
        const target = await core.roots.ensureWritable(args.out_path, args.overwrite === true);
        await writeFile(target, result.text, "utf8");
        writtenPath = target;
      }

      return {
        op: args.op,
        source: { path: input.path },
        text: result.text,
        changed: result.changed,
        diagnostic: result.diagnostic,
        written_path: writtenPath,
      };
    },
  );
}

function requireId(id: string | undefined, action: string): string {
  if (typeof id !== "string" || id === "") throw new ToolError("INVALID_ARGUMENT", `${action} requires a design id`, { action });
  return id;
}

/** The current info for a design id, or null when it is not open (it will have thrown earlier otherwise). */
function find(core: Core, id: string): { id: string; path: string; kind: "schematic" | "netlist"; active: boolean } | null {
  return core.designs.list().find((d) => d.id === id) ?? null;
}
