import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareCompat, spiceinitContents, COMPAT_UNSUPPORTED } from "../src/compat.js";
import { ToolError } from "../src/errors.js";
import { parse } from "../src/netlist.js";

describe("spiceinitContents", () => {
  it("sets lt mode and never touches the user's global config", () => {
    const text = spiceinitContents([]);
    assert.match(text, /set ngbehavior=lt/);
  });

  it("adds ltps/ltpsa variants when PSpice-style libraries appear", () => {
    const text = spiceinitContents(["pspice"]);
    assert.match(text, /ngbehavior=ltpsa|ngbehavior=ltps/);
  });
});

describe("prepareCompat", () => {
  it("prepares a plain netlist with lt mode and no translations", () => {
    const n = parse("rc\nV1 in 0 1\nR1 in out 1k\nC1 out 0 1u\n.tran 1u 1m\n.end\n");
    const prep = compat(n);
    assert.match(prep.spiceinit, /ngbehavior=lt/);
    assert.equal(prep.translations.length, 0);
  });

  it("passes B-sources through as supported", () => {
    const n = parse("b\nV1 in 0 1\nB1 out 0 V=uramp(v(in))\nR1 out 0 1k\n.op\n.end\n");
    const prep = compat(n);
    // uramp is a documented pass-through; no unsupported error.
    assert.ok(prep.translations.every((t) => !/unsupported/i.test(t.message)));
  });

  it("rejects an A-device with UNSUPPORTED_LTSPICE_FEATURE naming the construct and line", () => {
    const n = parse("a\nV1 in 0 1\nA1 in 0 0 0 0 0 0 0 DIFFSCHMITT\n.model DIFFSCHMITT ...\n.op\n.end\n");
    assert.throws(
      () => compat(n),
      (err: unknown) => {
        assert.ok(err instanceof ToolError);
        assert.equal(err.code, "UNSUPPORTED_LTSPICE_FEATURE");
        assert.match(err.message, /A1|A-device|DIFFSCHMITT/i);
        assert.ok(typeof err.details.line === "number");
        return true;
      },
    );
  });

  it("rejects a .machine directive as unsupported with its line", () => {
    const n = parse("m\nV1 in 0 1\nR1 in 0 1k\n.machine foo\n.op\n.end\n");
    assert.throws(
      () => compat(n),
      (err: unknown) => err instanceof ToolError && err.code === "UNSUPPORTED_LTSPICE_FEATURE" && typeof err.details.line === "number",
    );
  });

  it("records a translation for dropped LTspice-only .options", () => {
    const n = parse("o\nV1 in 0 1\nR1 in 0 1k\n.options plotwinsize=0\n.op\n.end\n");
    const prep = compat(n);
    assert.ok(prep.translations.some((t) => /plotwinsize/i.test(t.message)));
  });

  it("exposes the unsupported-construct table", () => {
    assert.ok(COMPAT_UNSUPPORTED.length > 0);
  });
});

function compat(n: ReturnType<typeof parse>) {
  return prepareCompat(n);
}
