import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "./config.js";
import { stopAll } from "./children.js";
import { createCore, type Core } from "./core.js";
import { registerNetlistTool } from "./tools/netlist.js";
import { registerSchematicTools } from "./tools/schematic.js";
import { registerStatusTool } from "./tools/status.js";

export const SERVER_NAME = "openspice-mcp";
export const SERVER_VERSION = "0.1.0";

/** Server-level guidance sent to clients in the initialize result. */
export const SERVER_INSTRUCTIONS = [
  "Works with SPICE circuits on this machine through typed, file-based tools. ngspice is the one required simulation engine, on every " +
    "platform; LTspice is the format inspiration, not a runtime dependency. Files OpenSPICE writes are meant to open in LTspice, but circuits " +
    "are simulated with ngspice in its LTspice compatibility mode (set ngbehavior=lt).",
  "Call the status tool first: it reports whether ngspice is installed, its path and version, whether that version supports the compatibility " +
    "mode, the configured roots, whether plotting is enabled, and whether the optional Windows-x64 extras (native LTspice backend, LTspice MCP " +
    "bridge) are available. Those extras are never required and never the default.",
  "Every path must resolve inside the configured roots; writes refuse to overwrite unless asked. There is no shell tool and no way to pass raw " +
    "flags. An LTspice-only construct that ngspice cannot run identically is translated when safe, or else fails with UNSUPPORTED_LTSPICE_FEATURE " +
    "naming the construct and line, rather than running a silently different circuit.",
].join("\n\n");

export interface OpenSpiceServer {
  server: McpServer;
  core: Core;
  /** Stop every tracked child process group and release resources. */
  shutdown: () => Promise<void>;
}

/** Composition root: builds the core modules and registers every tool in src/tools. */
export function createServer(config: Config): OpenSpiceServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const core = createCore(config, SERVER_VERSION);
  // Tool groups are registered here as they land (tasks 11, 12, 16).
  registerStatusTool(server, core);
  registerNetlistTool(server, core);
  registerSchematicTools(server, core);
  const shutdown = async () => {
    await stopAll();
  };
  return { server, core, shutdown };
}
