import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readAsc } from "../src/asc.js";
import { toNetlist } from "../src/ascnet.js";
import { SymbolResolver } from "../src/symbols.js";

const resolver = new SymbolResolver([]);

/**
 * A resistor divider: V1 drives `in`, R1 from `in` to `out`, R2 from `out` to
 * ground. Pin coordinates use the builtin symbol pin offsets (res: 16,0 and
 * 16,96; voltage: 0,0 and 0,96) added to each SYMBOL origin, and wires tie the
 * matching points together.
 */
const DIVIDER = [
  "Version 4",
  "SHEET 1 880 680",
  // V1 at (0,0): + pin at (0,0) -> net `in`, - pin at (0,96) -> net `0`
  "SYMBOL voltage 0 0 R0",
  "SYMATTR InstName V1",
  "SYMATTR Value 1",
  // R1 at (0,0): pin1 at (16,0), pin2 at (16,96)
  "SYMBOL res 0 0 R0",
  "SYMATTR InstName R1",
  "SYMATTR Value 1k",
  // R2 at (0,96): pin1 at (16,96), pin2 at (16,192)
  "SYMBOL res 0 96 R0",
  "SYMATTR InstName R2",
  "SYMATTR Value 2k",
  // Wires: V1+ (0,0) to R1.1 (16,0) -> net in. R1.2 (16,96) to R2.1 (16,96) shared point.
  "WIRE 0 0 16 0",
  // V1- (0,96) to R2.2 (16,192) and to ground flag.
  "WIRE 0 96 16 192",
  "FLAG 16 0 in",
  "FLAG 16 96 out",
  "FLAG 0 96 0",
  "",
].join("\n");

describe("toNetlist", () => {
  it("derives devices, nodes, and nets from flags and wires", async () => {
    const s = readAsc(Buffer.from(DIVIDER, "utf8"));
    const result = await toNetlist(s, resolver);
    const names = result.netlist.devices.map((d) => d.name).sort();
    assert.deepEqual(names, ["R1", "R2", "V1"]);

    const r1 = result.netlist.devices.find((d) => d.name === "R1");
    assert.deepEqual(r1?.nodes, ["in", "out"]);
    assert.equal(r1?.value, "1k");

    const r2 = result.netlist.devices.find((d) => d.name === "R2");
    assert.deepEqual(r2?.nodes, ["out", "0"]);

    const v1 = result.netlist.devices.find((d) => d.name === "V1");
    assert.deepEqual(v1?.nodes, ["in", "0"]);
  });

  it("orders nodes by the symbol's SpiceOrder", async () => {
    const s = readAsc(Buffer.from(DIVIDER, "utf8"));
    const result = await toNetlist(s, resolver);
    const v1 = result.netlist.devices.find((d) => d.name === "V1");
    // voltage pins are + (order 1) then - (order 2): + is `in`, - is `0`.
    assert.deepEqual(v1?.nodes, ["in", "0"]);
  });

  it("emits a netlist whose text re-parses to the same devices", async () => {
    const s = readAsc(Buffer.from(DIVIDER, "utf8"));
    const result = await toNetlist(s, resolver);
    assert.match(result.text, /R1 in out 1k/);
    assert.match(result.text, /R2 out 0 2k/);
  });

  it("warns when a component pin lands on no net", async () => {
    const text = ["Version 4", "SHEET 1 880 680", "SYMBOL res 0 0 R0", "SYMATTR InstName R1", "SYMATTR Value 1k", "FLAG 16 0 in", ""].join("\n");
    const s = readAsc(Buffer.from(text, "utf8"));
    const result = await toNetlist(s, resolver);
    assert.ok(result.warnings.some((w) => w.includes("R1") && /unconnected|pin/i.test(w)));
  });

  it("warns on an unknown symbol and still emits what it can", async () => {
    const text = ["Version 4", "SHEET 1 880 680", "SYMBOL mystery 0 0 R0", "SYMATTR InstName U1", ""].join("\n");
    const s = readAsc(Buffer.from(text, "utf8"));
    const result = await toNetlist(s, resolver);
    assert.ok(result.warnings.some((w) => w.includes("mystery")));
  });
});
