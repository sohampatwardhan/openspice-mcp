import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { builtinSymbols, SymbolResolver } from "../src/symbols.js";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "openspice-sym-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("builtinSymbols", () => {
  it("includes the common passives and sources with pin orders", () => {
    for (const name of ["res", "cap", "ind", "voltage", "current", "diode"]) {
      const sym = builtinSymbols[name];
      assert.ok(sym, `missing builtin symbol ${name}`);
      assert.ok(sym.pins.length >= 2);
      // Pins are ordered by SpiceOrder.
      const orders = sym.pins.map((p) => p.order);
      assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
    }
  });

  it("gives res a device prefix of R", () => {
    assert.equal(builtinSymbols.res?.attributes.Prefix, "R");
  });
});

describe("SymbolResolver", () => {
  it("resolves a builtin symbol by name, case-insensitively", async () => {
    const resolver = new SymbolResolver([]);
    const sym = await resolver.resolve("RES");
    assert.ok(sym);
    assert.equal(sym.pins.length, builtinSymbols.res?.pins.length);
  });

  it("resolves an .asy file from a configured search path", async () => {
    const asy = ["Version 4", "SymbolType CELL", "PIN 0 0 NONE 0", "PINATTR PinName A", "PINATTR SpiceOrder 1", "PIN 0 32 NONE 0", "PINATTR PinName B", "PINATTR SpiceOrder 2", ""].join("\n");
    writeFileSync(join(tmp, "myblock.asy"), asy);
    const resolver = new SymbolResolver([tmp]);
    const sym = await resolver.resolve("myblock");
    assert.ok(sym);
    assert.deepEqual(
      sym.pins.map((p) => p.name),
      ["A", "B"],
    );
  });

  it("returns null for an unknown symbol", async () => {
    const resolver = new SymbolResolver([tmp]);
    assert.equal(await resolver.resolve("does-not-exist"), null);
  });
});
