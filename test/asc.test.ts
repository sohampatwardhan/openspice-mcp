import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeText, readAsc, readAsy } from "../src/asc.js";

/** Encode a string to UTF-16LE with a BOM and CRLF line endings, as LTspice often writes. */
function utf16le(text: string): Buffer {
  const crlf = text.replace(/\n/g, "\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(crlf, "utf16le")]);
}

const SAMPLE_ASC = [
  "Version 4",
  "SHEET 1 880 680",
  "WIRE 144 96 144 48",
  "WIRE 144 240 144 192",
  "FLAG 144 240 0",
  "FLAG 144 48 in",
  "SYMBOL res 128 80 R0",
  "SYMATTR InstName R1",
  "SYMATTR Value 1k",
  "SYMBOL voltage 144 96 R0",
  "SYMATTR InstName V1",
  "SYMATTR Value SINE(0 1 1k)",
  "TEXT 48 320 Left 2 !.tran 1m",
  "TEXT 48 360 Left 2 ;just a note",
  "",
].join("\n");

describe("decodeText", () => {
  it("decodes UTF-8 and reports the encoding", () => {
    const r = decodeText(Buffer.from("Version 4\n", "utf8"));
    assert.equal(r.encoding, "utf-8");
    assert.equal(r.text.trim(), "Version 4");
  });

  it("decodes UTF-8 with a BOM", () => {
    const r = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Version 4\n", "utf8")]));
    assert.equal(r.encoding, "utf-8-bom");
    assert.equal(r.text.trim(), "Version 4");
  });

  it("decodes UTF-16LE with a BOM and CRLF", () => {
    const r = decodeText(utf16le("Version 4\nSHEET 1 880 680\n"));
    assert.equal(r.encoding, "utf-16le");
    assert.ok(r.text.includes("SHEET 1 880 680"));
  });
});

describe("readAsc", () => {
  it("parses components, wires, flags, and directives from UTF-8", () => {
    const s = readAsc(Buffer.from(SAMPLE_ASC, "utf8"));
    assert.equal(s.encoding, "utf-8");
    assert.equal(s.components.length, 2);
    const r1 = s.components.find((c) => c.instName === "R1");
    assert.equal(r1?.symbol, "res");
    assert.equal(r1?.value, "1k");
    assert.equal(r1?.x, 128);
    assert.equal(r1?.y, 80);
    assert.equal(r1?.rotation, 0);
    assert.equal(r1?.mirror, false);

    assert.equal(s.wires.length, 2);
    assert.deepEqual(s.wires[0], { x1: 144, y1: 96, x2: 144, y2: 48 });

    const ground = s.flags.find((f) => f.net === "0");
    assert.ok(ground);
    assert.deepEqual([ground.x, ground.y], [144, 240]);

    const directive = s.directives.find((d) => d.kind === "spice");
    assert.equal(directive?.text, ".tran 1m");
    const comment = s.directives.find((d) => d.kind === "comment");
    assert.equal(comment?.text, "just a note");
  });

  it("decodes a UTF-16LE .asc correctly", () => {
    const s = readAsc(utf16le(SAMPLE_ASC));
    assert.equal(s.encoding, "utf-16le");
    assert.equal(s.components.length, 2);
  });

  it("reads rotation and mirror from the symbol orientation", () => {
    const text = ["Version 4", "SHEET 1 880 680", "SYMBOL nmos 100 100 M90", "SYMATTR InstName M1", ""].join("\n");
    const s = readAsc(Buffer.from(text, "utf8"));
    const m1 = s.components[0];
    assert.equal(m1?.rotation, 90);
    assert.equal(m1?.mirror, true);
  });

  it("preserves an unknown keyword as a raw entry with a diagnostic", () => {
    const text = ["Version 4", "SHEET 1 880 680", "BOGUS 1 2 3", ""].join("\n");
    const s = readAsc(Buffer.from(text, "utf8"));
    assert.ok(s.raw.some((r) => r.keyword === "BOGUS"));
    assert.ok(s.diagnostics.some((d) => d.text.includes("BOGUS")));
  });
});

describe("readAsy", () => {
  const SAMPLE_ASY = [
    "Version 4",
    "SymbolType CELL",
    "LINE Normal 16 0 16 16",
    "RECTANGLE Normal 0 32 32 64",
    "PIN 16 0 NONE 0",
    "PINATTR PinName 1",
    "PINATTR SpiceOrder 1",
    "PIN 16 96 NONE 0",
    "PINATTR PinName 2",
    "PINATTR SpiceOrder 2",
    "SYMATTR Prefix R",
    "",
  ].join("\n");

  it("parses pins in SpiceOrder, primitives, and attributes", () => {
    const sym = readAsy(Buffer.from(SAMPLE_ASY, "utf8"));
    assert.equal(sym.symbolType, "CELL");
    assert.equal(sym.pins.length, 2);
    assert.deepEqual(
      sym.pins.map((p) => p.name),
      ["1", "2"],
    );
    assert.deepEqual(
      sym.pins.map((p) => p.order),
      [1, 2],
    );
    assert.deepEqual([sym.pins[0]?.x, sym.pins[0]?.y], [16, 0]);
    assert.equal(sym.attributes.Prefix, "R");
    assert.ok(sym.primitives.some((p) => p.kind === "LINE"));
    assert.ok(sym.primitives.some((p) => p.kind === "RECTANGLE"));
  });
});
