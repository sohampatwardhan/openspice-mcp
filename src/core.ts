import type { Config } from "./config.js";
import { Designs } from "./designs.js";
import { Roots } from "./paths.js";
import { ReferenceIndex } from "./refdoc.js";
import { SymbolResolver } from "./symbols.js";

/** The core modules every tool group uses, built once per server. */
export interface Core {
  config: Config;
  roots: Roots;
  /** Resolves `.asy` symbols from the bundled open set and the configured search path. */
  symbols: SymbolResolver;
  /** The in-memory open-designs session store. */
  designs: Designs;
  /** The local reference indexer (OpenSPICE docs, ngspice pointers, local LTspice help). */
  reference: ReferenceIndex;
  /** The server version, reported by the status tool. */
  version: string;
}

export function createCore(config: Config, version: string): Core {
  const roots = new Roots(config.roots);
  return {
    config,
    roots,
    symbols: new SymbolResolver(config.symbolPath),
    designs: new Designs(roots),
    reference: new ReferenceIndex({ helpDir: resolveHelpDir(config, roots) }),
    version,
  };
}

/**
 * The LTspice help directory used by the reference tool, but only when it is
 * inside an allowed root (Requirement 13.3). A configured help dir outside the
 * roots is dropped so the reference tool never reads outside the confinement.
 */
function resolveHelpDir(config: Config, roots: Roots): string | null {
  const dir = config.ltspiceHelpDir;
  if (dir === null) return null;
  return roots.contains(dir) ? dir : null;
}
