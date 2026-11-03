import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { parseNgspiceVersion, probeNgspice } from "../src/ngspice.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "..", "..", "test", "fixtures", "fake-ngspice.mjs");

describe("parseNgspiceVersion", () => {
  it("extracts the version from an ngspice banner", () => {
    assert.equal(parseNgspiceVersion("** ngspice-44.2 : Circuit level simulation program"), "44.2");
    assert.equal(parseNgspiceVersion("ngspice-34"), "34");
  });

  it("returns null when no version is present", () => {
    assert.equal(parseNgspiceVersion("no version here"), null);
  });
});

describe("probeNgspice", () => {
  const cwd = here;

  it("reports a found engine, version, and compat-mode support", async () => {
    const probe = await probeNgspice(fakeBin, { cwd });
    assert.equal(probe.found, true);
    assert.equal(probe.version, "44.2");
    assert.equal(probe.supportsCompatMode, true);
    assert.ok(probe.path);
  });

  it("warns when the version is older than the compat-mode minimum", async () => {
    const probe = await probeNgspice(fakeBin, { cwd, env: { ...process.env, FAKE_NGSPICE_VERSION: "27" } });
    assert.equal(probe.version, "27");
    assert.equal(probe.supportsCompatMode, false);
    assert.ok(probe.warnings.some((w) => /27/.test(w) && /34/.test(w)));
  });

  it("reports not found with an install hint when the binary is missing", async () => {
    const probe = await probeNgspice("/no/such/ngspice-binary", { cwd });
    assert.equal(probe.found, false);
    assert.equal(probe.version, null);
    assert.ok(probe.installHint && probe.installHint.length > 0);
  });
});
