import { arch, platform } from "node:os";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Core } from "../core.js";
import { COMPAT_MODE_MIN_VERSION, COMPAT_MODE_NOTE, probeNgspice, resolveBinary } from "../ngspice.js";
import { defineTool } from "./define.js";

/** True when the host is Windows x64, the only platform the optional extras run on. */
function isWindowsX64(): boolean {
  return platform() === "win32" && arch() === "x64";
}

export function registerStatusTool(server: McpServer, core: Core): void {
  const { config, roots } = core;

  defineTool(
    server,
    "openspice_status",
    {
      title: "OpenSPICE status",
      description:
        "Call first. Reports whether ngspice is installed (resolved path and version) and whether that version meets the minimum for LTspice " +
        "compatibility mode (set ngbehavior=lt), the configured roots, whether plotting is enabled, and whether each optional Windows-x64 extra " +
        "(native LTspice backend, LTspice MCP bridge) is enabled and available. ngspice is the one required engine, on every platform; the extras " +
        "are never required and never the default. If ngspice is missing the call still succeeds and returns an install hint.",
      input: z.object({}).strict(),
      output: z.object({
        server: z.object({ name: z.string(), version: z.string() }),
        ngspice: z.object({
          found: z.boolean(),
          path: z.string().nullable(),
          configured: z.string(),
          version: z.string().nullable(),
          supports_compat_mode: z.boolean().nullable(),
          compat_mode_min_version: z.number(),
          compat_mode_note: z.string(),
          install_hint: z.string().nullable(),
        }),
        roots: z.array(z.string()),
        plotting_enabled: z.boolean(),
        platform: z.object({ os: z.string(), arch: z.string(), windows_x64: z.boolean() }),
        optional_extras: z.object({
          ltspice: z.object({ enabled: z.boolean(), available: z.boolean(), path: z.string().nullable(), reason: z.string().nullable() }),
          bridge: z.object({ enabled: z.boolean(), available: z.boolean(), path: z.string().nullable(), reason: z.string().nullable() }),
        }),
        warnings: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const warnings: string[] = [];
      const probe = await probeNgspice(config.ngspiceBin, { cwd: roots.primary });
      for (const w of probe.warnings) warnings.push(w);

      const winX64 = isWindowsX64();
      const extraStatus = (enabled: boolean, bin: string | null, label: string) => {
        if (!winX64) {
          return { enabled, available: false, path: null, reason: `${label} is a Windows-x64-only extra; this host is ${platform()}/${arch()}` };
        }
        if (!enabled) return { enabled, available: false, path: null, reason: `${label} is disabled` };
        const resolved = bin !== null ? resolveBinary(bin) : null;
        return {
          enabled,
          available: resolved !== null,
          path: resolved,
          reason: resolved === null ? `${label} is enabled but its executable was not found` : null,
        };
      };

      return {
        server: { name: "openspice-mcp", version: core.version },
        ngspice: {
          found: probe.found,
          path: probe.path,
          configured: probe.configured,
          version: probe.version,
          supports_compat_mode: probe.supportsCompatMode,
          compat_mode_min_version: COMPAT_MODE_MIN_VERSION,
          compat_mode_note: COMPAT_MODE_NOTE,
          install_hint: probe.installHint,
        },
        roots: roots.list,
        plotting_enabled: config.allowPlots,
        platform: { os: platform(), arch: arch(), windows_x64: winX64 },
        optional_extras: {
          ltspice: extraStatus(config.enableLtspice, config.ltspiceBin, "the native LTspice backend"),
          bridge: extraStatus(config.enableBridge, config.bridgeBin, "the LTspice MCP bridge"),
        },
        warnings,
      };
    },
  );
}
