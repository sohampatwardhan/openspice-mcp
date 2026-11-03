import type { Config } from "./config.js";
import { Roots } from "./paths.js";

/** The core modules every tool group uses, built once per server. */
export interface Core {
  config: Config;
  roots: Roots;
  /** The server version, reported by the status tool. */
  version: string;
}

export function createCore(config: Config, version: string): Core {
  return {
    config,
    roots: new Roots(config.roots),
    version,
  };
}
