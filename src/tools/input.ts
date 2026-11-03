/**
 * Shared input resolution for tools that accept either a `path` inside the
 * roots or inline `text`. Enforces the size limits (Requirement 8.4) and reads
 * bytes so callers can decode `.asc`/`.asy` encodings themselves.
 */

import { readFile, stat } from "node:fs/promises";

import { LIMITS } from "../config.js";
import type { Core } from "../core.js";
import { ToolError } from "../errors.js";

export interface ResolvedInput {
  /** Bytes of the input (inline text is encoded UTF-8). */
  bytes: Buffer;
  /** The resolved absolute path, or null for inline text. */
  path: string | null;
  /** The directory inputs like `.include` resolve against (the file's dir, or the primary root). */
  baseDir: string;
}

/** Resolve a path-or-inline input to bytes, confined to the roots and within the size limits. */
export async function resolveInput(core: Core, args: { path?: string | undefined; text?: string | undefined }): Promise<ResolvedInput> {
  const hasPath = typeof args.path === "string" && args.path !== "";
  const hasText = typeof args.text === "string";
  if (hasPath && hasText) throw new ToolError("CONTENT_TOO_LARGE", "provide either a path or inline text, not both", { reason: "both path and text supplied" });
  if (!hasPath && !hasText) throw new ToolError("CONTENT_TOO_LARGE", "provide a path or inline text", { reason: "neither path nor text supplied" });

  if (hasText) {
    const text = args.text as string;
    if (text.length > LIMITS.maxInlineChars) {
      throw new ToolError("CONTENT_TOO_LARGE", `inline text exceeds the ${LIMITS.maxInlineChars}-character limit`, { length: text.length, limit: LIMITS.maxInlineChars });
    }
    return { bytes: Buffer.from(text, "utf8"), path: null, baseDir: core.roots.primary };
  }

  const resolved = await core.roots.resolveInside(args.path as string);
  const info = await stat(resolved);
  if (info.size > LIMITS.maxFileBytes) {
    throw new ToolError("CONTENT_TOO_LARGE", `file exceeds the ${LIMITS.maxFileBytes}-byte limit`, { size: info.size, limit: LIMITS.maxFileBytes });
  }
  const bytes = await readFile(resolved);
  const slash = Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf("\\"));
  const baseDir = slash >= 0 ? resolved.slice(0, slash) : core.roots.primary;
  return { bytes, path: resolved, baseDir };
}
