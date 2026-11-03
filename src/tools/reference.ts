/**
 * `openspice_reference` (Requirement 13). Lists and fetches reference docs from
 * locally available sources, bundling no copyrighted help: OpenSPICE's own docs
 * (returned verbatim), ngspice manual pointers (URLs only), and the user's local
 * LTspiceHelp folder when present and inside an allowed location. An unknown id
 * fails with INVALID_ARGUMENT.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { ToolError } from "../errors.js";
import { defineTool } from "./define.js";

export function registerReferenceTool(server: McpServer, core: Core): void {
  defineTool(
    server,
    "openspice_reference",
    {
      title: "Look up reference docs",
      description:
        "action=list returns the reference entries OpenSPICE can index, each tagged with its source: OpenSPICE's own docs, ngspice manual pointers " +
        "(URLs, not fetched content), and the user's local LTspiceHelp folder when it is installed and inside an allowed location. action=get returns " +
        "one entry by id: the text of an OpenSPICE-owned doc, the text read from a local LTspiceHelp file, or an ngspice manual URL. OpenSPICE ships " +
        "no Analog Devices LTspice documentation. An unknown id fails with INVALID_ARGUMENT.",
      input: z
        .object({
          action: z.enum(["list", "get"]),
          id: z.string().optional(),
        })
        .strict(),
      output: z.object({
        action: z.string(),
        entries: z
          .array(
            z.object({
              id: z.string(),
              title: z.string(),
              summary: z.string(),
              source: z.enum(["openspice", "ngspice", "ltspice-help"]),
              path: z.string().nullable(),
              url: z.string().nullable(),
            }),
          )
          .nullable(),
        doc: z
          .object({
            id: z.string(),
            title: z.string(),
            source: z.enum(["openspice", "ngspice", "ltspice-help"]),
            text: z.string().nullable(),
            url: z.string().nullable(),
          })
          .nullable(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.action === "list") {
        const entries = await core.reference.list();
        return { action: args.action, entries, doc: null };
      }
      if (typeof args.id !== "string" || args.id === "") throw new ToolError("INVALID_ARGUMENT", "get requires an id", { action: args.action });
      const doc = await core.reference.get(args.id);
      return { action: args.action, entries: null, doc };
    },
  );
}
