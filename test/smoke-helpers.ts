// Starts the built server over stdio, exactly as an MCP client would, with the
// roots pointed at a throwaway work directory.
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const serverEntry = join(repoRoot, "dist/src/index.js");

export interface Connected {
  client: Client;
  work: string;
  stderr: () => string;
  close: () => Promise<void>;
  serverPid: number | null;
}

export interface ConnectOptions {
  env?: Record<string, string>;
}

export async function connect(opts: ConnectOptions = {}): Promise<Connected> {
  const dir = mkdtempSync(join(tmpdir(), "openspice-smoke-"));
  const work = join(dir, "work");
  mkdirSync(work, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("OPENSPICE_")) env[k] = v;
  }
  Object.assign(env, { OPENSPICE_ROOTS: work, OPENSPICE_CWD: work, HOME: dir }, opts.env ?? {});
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: "pipe", cwd: work });
  const client = new Client({ name: "smoke-test", version: "0.0.0" }, { capabilities: {} });
  let stderrText = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString("utf8");
  });
  await client.connect(transport);
  return {
    client,
    work,
    stderr: () => stderrText,
    close: () => client.close(),
    serverPid: transport.pid,
  };
}
