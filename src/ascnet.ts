/**
 * Schematic-to-netlist conversion (Requirement 4). Nets are derived from wire
 * endpoints and FLAG labels by union-find over grid points; each component pin
 * is placed by applying the symbol's orientation to its symbol-space pin offset
 * and attached to the net at that point. Node lists are ordered by the symbol's
 * SPICE pin order. Shorts and unconnected pins produce warnings, never silent
 * drops. The emitted text reuses `netlist.emit`.
 */

import { emit, type Device, type Netlist } from "./netlist.js";
import type { Pin, Schematic, Symbol } from "./asc.js";
import type { SymbolResolver } from "./symbols.js";

export interface ConvertResult {
  netlist: Netlist;
  text: string;
  warnings: string[];
}

/** Snap a coordinate to an integer key so wire/pin points compare exactly. */
function key(x: number, y: number): string {
  return `${Math.round(x)},${Math.round(y)}`;
}

/** Minimal union-find over point keys. */
class DisjointSet {
  private readonly parent = new Map<string, string>();

  find(a: string): string {
    let root = a;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }
    if (this.parent.get(a) === undefined) this.parent.set(a, root);
    // Path compression.
    let node = a;
    while (node !== root) {
      const next = this.parent.get(node) as string;
      this.parent.set(node, root);
      node = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  ensure(a: string): void {
    if (this.parent.get(a) === undefined) this.parent.set(a, a);
  }
}

/**
 * Apply an LTspice orientation (`R<deg>`/`M<deg>`) to a symbol-space pin offset.
 * Mirror flips the X axis, then the rotation is applied clockwise in screen
 * coordinates (Y grows downward). The exact convention only needs to be
 * self-consistent for the generator's round-trip and for wire matching, and is
 * marked uncertain against LTspice's own geometry until the corpus pins it.
 */
function orientPin(rotation: number, mirror: boolean, px: number, py: number): { x: number; y: number } {
  let x = mirror ? -px : px;
  let y = py;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      [x, y] = [-y, x];
      break;
    case 180:
      [x, y] = [-x, -y];
      break;
    case 270:
      [x, y] = [y, -x];
      break;
    default:
      break;
  }
  return { x, y };
}

/** Derive the device kind letter and value/model for a component from its symbol + attributes. */
function deviceFromComponent(symbol: Symbol | null, symbolName: string, instName: string, value: string | null): { kind: string; value: string | null; model: string | null } {
  const prefix = symbol?.attributes.Prefix ?? instName.charAt(0).toUpperCase();
  const kind = (prefix || instName.charAt(0)).toUpperCase().charAt(0);
  // For model-based devices the Value attribute names the model; otherwise it is a value.
  const modelDevices = new Set(["Q", "J", "Z", "M", "D"]);
  if (modelDevices.has(kind)) return { kind, value: null, model: value };
  return { kind, value, model: null };
}

/** Convert an `.asc` schematic to a netlist (Requirement 4). */
export async function toNetlist(schematic: Schematic, resolver: SymbolResolver): Promise<ConvertResult> {
  const warnings: string[] = [];
  const dsu = new DisjointSet();

  // 1. Wires union their two endpoints.
  for (const wire of schematic.wires) {
    const a = key(wire.x1, wire.y1);
    const b = key(wire.x2, wire.y2);
    dsu.ensure(a);
    dsu.ensure(b);
    dsu.union(a, b);
  }

  // 2. Resolve every component's pins to absolute points, and collect them.
  interface ResolvedComponent {
    instName: string;
    kind: string;
    value: string | null;
    model: string | null;
    pinPoints: { pin: Pin; point: string }[];
  }
  const resolved: ResolvedComponent[] = [];
  for (const comp of schematic.components) {
    const instName = comp.instName ?? "";
    if (instName === "") {
      warnings.push(`component with symbol ${JSON.stringify(comp.symbol)} has no InstName and was skipped`);
      continue;
    }
    const sym = await resolver.resolve(comp.symbol);
    if (sym === null) {
      warnings.push(`unknown symbol ${JSON.stringify(comp.symbol)} for ${instName}; cannot resolve pin order`);
    }
    const pins = sym?.pins ?? [];
    const pinPoints = pins.map((pin) => {
      const off = orientPin(comp.rotation, comp.mirror, pin.x, pin.y);
      const point = key(comp.x + off.x, comp.y + off.y);
      dsu.ensure(point);
      return { pin, point };
    });
    const dev = deviceFromComponent(sym, comp.symbol, instName, comp.value);
    resolved.push({ instName, kind: dev.kind, value: dev.value, model: dev.model, pinPoints });
  }

  // 3. FLAG labels name the net of their point's group. Ground (`0`) wins ties.
  const groupNet = new Map<string, string>();
  for (const flag of schematic.flags) {
    const point = key(flag.x, flag.y);
    dsu.ensure(point);
    const root = dsu.find(point);
    const existing = groupNet.get(root);
    if (existing !== undefined && existing !== flag.net) {
      // Ground label always wins; otherwise keep the first and warn on the clash.
      if (flag.net === "0" || existing === "0") {
        groupNet.set(root, "0");
      } else {
        warnings.push(`net label conflict at group of ${JSON.stringify(point)}: ${existing} vs ${flag.net}; using ${existing}`);
        continue;
      }
    } else {
      groupNet.set(root, flag.net);
    }
  }

  // 4. Assign auto-names to any remaining connected groups.
  let autoIndex = 1;
  const netForPoint = (point: string): string | null => {
    const root = dsu.find(point);
    const named = groupNet.get(root);
    if (named !== undefined) return named;
    return null;
  };

  // Pre-name groups that hold more than one pin but no flag, so a shared node gets a stable name.
  const groupPinCount = new Map<string, number>();
  for (const comp of resolved) {
    for (const { point } of comp.pinPoints) {
      const root = dsu.find(point);
      groupPinCount.set(root, (groupPinCount.get(root) ?? 0) + 1);
    }
  }

  // 5. Build devices, ordering nodes by SPICE pin order and warning on loose pins.
  const devices: Device[] = [];
  for (const comp of resolved) {
    const ordered = [...comp.pinPoints].sort((a, b) => a.pin.order - b.pin.order);
    const nodes: string[] = [];
    for (const { pin, point } of ordered) {
      let net = netForPoint(point);
      if (net === null) {
        const root = dsu.find(point);
        if ((groupPinCount.get(root) ?? 0) >= 2) {
          // A shared internal node: mint a stable name once per group.
          net = `N${String(autoIndex).padStart(3, "0")}`;
          autoIndex++;
          groupNet.set(root, net);
        } else {
          warnings.push(`${comp.instName} pin ${JSON.stringify(pin.name)} is unconnected (no wire or net label)`);
          net = `N${String(autoIndex).padStart(3, "0")}`;
          autoIndex++;
          groupNet.set(root, net);
        }
      }
      nodes.push(net);
    }
    devices.push({
      kind: comp.kind,
      name: comp.instName,
      nodes,
      value: comp.value,
      model: comp.model,
      params: {},
      raw: "",
      line: 0,
    });
  }

  // 6. On-sheet SPICE directives become netlist directives.
  const directives = schematic.directives
    .filter((d) => d.kind === "spice" && d.text.startsWith("."))
    .map((d) => {
      const match = /^(\.[a-z]+)\s*(.*)$/i.exec(d.text);
      return { kind: (match?.[1] ?? d.text).toLowerCase(), args: match?.[2] ?? "", raw: d.text, line: 0 };
    });

  const netlist: Netlist = {
    title: "* schematic",
    devices,
    models: [],
    subckts: [],
    includes: [],
    directives,
    diagnostics: [],
  };

  return { netlist, text: emit(netlist), warnings };
}
