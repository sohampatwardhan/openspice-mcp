import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { ConfigError, LIMITS, loadConfig } from "../src/config.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "openspice-config-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const base = { OPENSPICE_CWD: tmp };

describe("loadConfig", () => {
  it("uses safe defaults", () => {
    const c = loadConfig(base);
    assert.equal(c.cwd, tmp);
    assert.deepEqual(c.roots, [tmp]);
    assert.equal(c.ngspiceBin, "ngspice");
    assert.equal(c.allowPlots, false);
    assert.equal(c.ltspiceHelpDir, null);
    assert.deepEqual(c.symbolPath, []);
    assert.equal(c.enableLtspice, false);
    assert.equal(c.ltspiceBin, null);
    assert.equal(c.enableBridge, false);
    assert.equal(c.bridgeBin, null);
    assert.equal(c.wineBin, null);
    assert.equal(c.simTimeoutMs, 120_000);
  });

  it("reads every variable", () => {
    const c = loadConfig({
      ...base,
      OPENSPICE_NGSPICE_BIN: "/opt/ngspice",
      OPENSPICE_ALLOW_PLOTS: "yes",
      OPENSPICE_LTSPICE_HELP_DIR: tmp,
      OPENSPICE_SYMBOL_PATH: tmp,
      OPENSPICE_ENABLE_LTSPICE: "1",
      OPENSPICE_LTSPICE_BIN: "/opt/ltspice.exe",
      OPENSPICE_ENABLE_BRIDGE: "true",
      OPENSPICE_BRIDGE_BIN: "/opt/ltspice-mcp-bridge.exe",
      OPENSPICE_WINE_BIN: "/usr/bin/wine",
      OPENSPICE_SIM_TIMEOUT_MS: "5000",
    });
    assert.equal(c.ngspiceBin, "/opt/ngspice");
    assert.equal(c.allowPlots, true);
    assert.equal(c.ltspiceHelpDir, tmp);
    assert.deepEqual(c.symbolPath, [tmp]);
    assert.equal(c.enableLtspice, true);
    assert.equal(c.ltspiceBin, "/opt/ltspice.exe");
    assert.equal(c.enableBridge, true);
    assert.equal(c.bridgeBin, "/opt/ltspice-mcp-bridge.exe");
    assert.equal(c.wineBin, "/usr/bin/wine");
    assert.equal(c.simTimeoutMs, 5000);
  });

  it("treats 0, false, no, and blank as off", () => {
    for (const v of ["0", "false", "no", "NO", ""]) {
      assert.equal(loadConfig({ ...base, OPENSPICE_ALLOW_PLOTS: v }).allowPlots, false);
    }
  });

  const invalid: [string, string][] = [
    ["OPENSPICE_ALLOW_PLOTS", "on"],
    ["OPENSPICE_ENABLE_BRIDGE", "maybe"],
    ["OPENSPICE_SIM_TIMEOUT_MS", "-1"],
    ["OPENSPICE_SIM_TIMEOUT_MS", "1.5"],
    ["OPENSPICE_SIM_TIMEOUT_MS", "abc"],
    ["OPENSPICE_CWD", join(tmp, "missing")],
    ["OPENSPICE_LTSPICE_HELP_DIR", "relative/dir"],
    ["OPENSPICE_LTSPICE_HELP_DIR", join(tmp, "missing")],
    ["OPENSPICE_SYMBOL_PATH", "relative/dir"],
    ["OPENSPICE_SYMBOL_PATH", join(tmp, "missing")],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}=${value} with the variable name`, () => {
      assert.throws(
        () => loadConfig({ ...base, [name]: value }),
        (err: unknown) => err instanceof ConfigError && err.message.includes(name),
      );
    });
  }

  it("fixes the documented limits", () => {
    assert.equal(LIMITS.maxFileBytes, 16 * 1024 * 1024);
    assert.equal(LIMITS.maxInlineChars, 4 * 1024 * 1024);
    assert.equal(LIMITS.defaultMaxPoints, 2_000);
    assert.equal(LIMITS.maxPoints, 200_000);
    assert.equal(LIMITS.logTailChars, 8_000);
  });
});
