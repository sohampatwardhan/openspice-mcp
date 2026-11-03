import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Every code a tool error may carry. New codes also go in the README error table. */
export type ErrorCode =
  // Arguments
  | "INVALID_ARGUMENT"
  // Paths and content
  | "PATH_OUTSIDE_ROOTS"
  | "PATH_EXISTS"
  | "CONTENT_TOO_LARGE"
  // Generation and round-trip
  | "GENERATE_INVALID"
  | "GENERATE_UNVERIFIED"
  // Compatibility
  | "UNSUPPORTED_LTSPICE_FEATURE"
  // ngspice and simulation
  | "BACKEND_NOT_FOUND"
  | "SIM_TIMEOUT"
  | "SIM_FAILED"
  // Raw files
  | "RAW_PARSE_FAILED"
  // Designs
  | "DESIGN_NOT_FOUND"
  | "DESIGN_HAS_NO_RESULT"
  // Optional bridge extra
  | "BRIDGE_UNAVAILABLE"
  // Catch-all
  | "INTERNAL_ERROR";

export const ERROR_CODES: readonly ErrorCode[] = [
  "INVALID_ARGUMENT",
  "PATH_OUTSIDE_ROOTS",
  "PATH_EXISTS",
  "CONTENT_TOO_LARGE",
  "GENERATE_INVALID",
  "GENERATE_UNVERIFIED",
  "UNSUPPORTED_LTSPICE_FEATURE",
  "BACKEND_NOT_FOUND",
  "SIM_TIMEOUT",
  "SIM_FAILED",
  "RAW_PARSE_FAILED",
  "DESIGN_NOT_FOUND",
  "DESIGN_HAS_NO_RESULT",
  "BRIDGE_UNAVAILABLE",
  "INTERNAL_ERROR",
];

/** A failure a tool reports to the caller with a stable code. */
export class ToolError extends Error {
  override name = "ToolError";
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Tool errors carry `{ error: { code, message, details } }` as their text body. */
export function toolErrorResult(err: unknown): CallToolResult & { content: { type: "text"; text: string }[] } {
  const error =
    err instanceof ToolError
      ? { code: err.code, message: err.message, details: err.details }
      : { code: "INTERNAL_ERROR" as const, message: err instanceof Error ? err.message : String(err), details: {} };
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
}

/** A success result: the structured body, mirrored as JSON text for clients without structured output. */
export function okResult(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}
