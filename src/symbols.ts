/**
 * Symbol model and resolution (Requirement 4.2). A `Symbol` carries the pin
 * list in SPICE order plus attributes (notably `Prefix`, the device letter).
 *
 * OpenSPICE ships a minimal open symbol set so `.asc`->netlist works without
 * LTspice installed. Symbols not in that set are resolved from a configured
 * search path, and (at the tool layer) from the user's LTspice `sym` folder
 * only when it is installed and inside an allowed location.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readAsy, type Symbol } from "./asc.js";

export type { Symbol } from "./asc.js";

/** Build a minimal in-repo symbol with pins in SPICE order and a device prefix. */
function makeSymbol(prefix: string, pins: { name: string; x: number; y: number }[]): Symbol {
  return {
    symbolType: "CELL",
    pins: pins.map((p, i) => ({ name: p.name, order: i + 1, x: p.x, y: p.y })),
    primitives: [],
    attributes: { Prefix: prefix },
    raw: [],
    diagnostics: [],
  };
}

/**
 * The bundled open symbol set. Pin coordinates follow the LTspice convention
 * that the symbol origin is the component placement point and pins sit on the
 * grid around it; the exact geometry is not important for netlisting, only the
 * pin order and net attachment, so these are simple vertical two/three/four-pin
 * layouts. Names mirror LTspice's built-in symbol names (`res`, `cap`, ...).
 */
export const builtinSymbols: Record<string, Symbol> = {
  res: makeSymbol("R", [
    { name: "1", x: 16, y: 0 },
    { name: "2", x: 16, y: 96 },
  ]),
  cap: makeSymbol("C", [
    { name: "1", x: 16, y: 0 },
    { name: "2", x: 16, y: 64 },
  ]),
  ind: makeSymbol("L", [
    { name: "1", x: 16, y: 0 },
    { name: "2", x: 16, y: 96 },
  ]),
  voltage: makeSymbol("V", [
    { name: "+", x: 0, y: 0 },
    { name: "-", x: 0, y: 96 },
  ]),
  current: makeSymbol("I", [
    { name: "+", x: 0, y: 0 },
    { name: "-", x: 0, y: 96 },
  ]),
  diode: makeSymbol("D", [
    { name: "A", x: 16, y: 0 },
    { name: "K", x: 16, y: 64 },
  ]),
  npn: makeSymbol("Q", [
    { name: "C", x: 64, y: 16 },
    { name: "B", x: 0, y: 48 },
    { name: "E", x: 64, y: 80 },
  ]),
  pnp: makeSymbol("Q", [
    { name: "C", x: 64, y: 80 },
    { name: "B", x: 0, y: 48 },
    { name: "E", x: 64, y: 16 },
  ]),
  nmos: makeSymbol("M", [
    { name: "D", x: 64, y: 16 },
    { name: "G", x: 0, y: 48 },
    { name: "S", x: 64, y: 80 },
    { name: "B", x: 64, y: 48 },
  ]),
  pmos: makeSymbol("M", [
    { name: "D", x: 64, y: 80 },
    { name: "G", x: 0, y: 48 },
    { name: "S", x: 64, y: 16 },
    { name: "B", x: 64, y: 48 },
  ]),
};

/**
 * Resolves a symbol name to a `Symbol`. The caller supplies the search path
 * (already confined to allowed locations). Builtins win first; then each path
 * is searched for `<name>.asy`.
 */
export class SymbolResolver {
  private readonly cache = new Map<string, Symbol | null>();

  constructor(private readonly searchPath: string[]) {}

  async resolve(name: string): Promise<Symbol | null> {
    const key = name.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const builtin = builtinSymbols[key];
    if (builtin !== undefined) {
      this.cache.set(key, builtin);
      return builtin;
    }

    for (const dir of this.searchPath) {
      const candidate = join(dir, `${name}.asy`);
      try {
        const bytes = await readFile(candidate);
        const sym = readAsy(bytes);
        this.cache.set(key, sym);
        return sym;
      } catch {
        // try the next search dir
      }
    }

    this.cache.set(key, null);
    return null;
  }
}
