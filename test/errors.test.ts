import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ERROR_CODES, okResult, ToolError, toolErrorResult } from "../src/errors.js";

describe("tool errors", () => {
  it("renders the documented body", () => {
    const result = toolErrorResult(new ToolError("PATH_OUTSIDE_ROOTS", "nope", { path: "/x" }));
    assert.equal(result.isError, true);
    const first = result.content[0];
    assert.ok(first !== undefined && first.type === "text");
    assert.deepEqual(JSON.parse(first.text), {
      error: { code: "PATH_OUTSIDE_ROOTS", message: "nope", details: { path: "/x" } },
    });
  });

  it("wraps unexpected errors as INTERNAL_ERROR without a stack", () => {
    const result = toolErrorResult(new Error("boom"));
    const first = result.content[0];
    assert.ok(first !== undefined && first.type === "text");
    const body = JSON.parse(first.text) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(body.error.message, "boom");
  });

  it("mirrors a success body as JSON text and structuredContent", () => {
    const result = okResult({ ok: true, count: 3 });
    assert.deepEqual(result.structuredContent, { ok: true, count: 3 });
    const first = result.content?.[0];
    assert.ok(first !== undefined && first.type === "text");
    assert.deepEqual(JSON.parse(first.text), { ok: true, count: 3 });
  });

  it("lists every ErrorCode exactly once", () => {
    const seen = new Set(ERROR_CODES);
    assert.equal(seen.size, ERROR_CODES.length);
    for (const required of ["UNSUPPORTED_LTSPICE_FEATURE", "GENERATE_UNVERIFIED", "BRIDGE_UNAVAILABLE", "DESIGN_NOT_FOUND"] as const) {
      assert.ok(seen.has(required), `${required} is in ERROR_CODES`);
    }
  });
});
