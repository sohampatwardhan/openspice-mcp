/**
 * Compatibility test corpus (Requirement 14). Each case under test/corpus/<name>/
 * carries an `input.cir` or `input.asc`, an `expected.net` whose device
 * connectivity the parse/convert must match, and a `notes.md`. A case may add:
 *
 *   expected.meas.json   { analysis, ngspice?, tolerances?, measurements } or
 *                        { unsupported: "<CODE>" } to assert a construct is
 *                        rejected, or { translation: "<substring>" } to assert a
 *                        safe translation is recorded.
 *
 * The runner parses (or converts an .asc), compares connectivity against the
 * golden netlist, and — when real ngspice is on the host — runs the circuit
 * through the LTspice compatibility layer and checks measurements within the
 * stated tolerance. Cases with no reference values still assert that parse and
 * netlist match and that the ngspice run completes (Requirement 14.3). The CI
 * `test` job installs ngspice, so the corpus runs against a real engine there.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { readAsc } from "../src/asc.js";
import { toNetlist } from "../src/ascnet.js";
import { prepareCompat } from "../src/compat.js";
import { ToolError } from "../src/errors.js";
import { parse, type Netlist } from "../src/netlist.js";
import { Roots } from "../src/paths.js";
import { summarize } from "../src/raw.js";
import { runSimulation } from "../src/runner.js";
import { SymbolResolver } from "../src/symbols.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "..", "test", "corpus");
const realNgspice = "/usr/bin/ngspice";
const hasReal = existsSync(realNgspice);
const resolver = new SymbolResolver([]);

interface MeasExpectation {
  analysis?: string;
  /** Assert the run is rejected with this error code (e.g. UNSUPPORTED_LTSPICE_FEATURE). */
  unsupported?: string;
  /** Assert a prepareCompat translation whose message/construct contains this substring. */
  translation?: string;
  /** Assert a run-result translation (e.g. a `.meas AT` rewrite) contains this substring. */
  runTranslation?: string;
  /** name -> expected value (checked within tolerance when ngspice is present). */
  measurements?: Record<string, number>;
  /** variable name -> expected final value from the raw summary (e.g. v(out)). */
  nodes?: Record<string, number>;
  /** name -> absolute tolerance; defaults to relTol of the value. */
  tolerances?: Record<string, number>;
  /** Default relative tolerance for measurements without an explicit one. */
  relTol?: number;
}

/** A device reduced to its comparable connectivity: name -> {nodes, value}. */
function connectivity(netlist: Netlist): Map<string, { nodes: string; value: string | null }> {
  const map = new Map<string, { nodes: string; value: string | null }>();
  for (const d of netlist.devices) {
    map.set(d.name.toLowerCase(), { nodes: d.nodes.join(" ").toLowerCase(), value: d.value });
  }
  return map;
}

function assertSameConnectivity(produced: Netlist, expected: Netlist, label: string): void {
  const a = connectivity(produced);
  const b = connectivity(expected);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), `${label}: device set differs`);
  for (const [name, wantConn] of b) {
    const got = a.get(name);
    assert.ok(got, `${label}: missing device ${name}`);
    assert.equal(got?.nodes, wantConn.nodes, `${label}: ${name} node connectivity differs`);
  }
}

function listCases(): string[] {
  if (!existsSync(corpusDir)) return [];
  return readdirSync(corpusDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

async function netlistForCase(dir: string): Promise<Netlist> {
  const ascPath = join(dir, "input.asc");
  if (existsSync(ascPath)) {
    const schematic = readAsc(readFileSync(ascPath));
    const converted = await toNetlist(schematic, resolver);
    return converted.netlist;
  }
  const cirPath = join(dir, "input.cir");
  assert.ok(existsSync(cirPath), `case ${dir} has no input.cir or input.asc`);
  return parse(readFileSync(cirPath, "utf8"));
}

const cases = listCases();

describe("compatibility corpus", () => {
  assert.ok(cases.length > 0, "the corpus has at least one case");

  for (const name of cases) {
    const dir = join(corpusDir, name);
    const expPath = join(dir, "expected.meas.json");
    const exp: MeasExpectation = existsSync(expPath) ? JSON.parse(readFileSync(expPath, "utf8")) : {};

    describe(name, () => {
      it("parses/converts to the golden connectivity", async () => {
        const produced = await netlistForCase(dir);
        // Unsupported cases may still have a golden netlist for the parse stage.
        const expNetPath = join(dir, "expected.net");
        if (existsSync(expNetPath)) {
          const expected = parse(readFileSync(expNetPath, "utf8"));
          assertSameConnectivity(produced, expected, name);
        }
      });

      if (exp.unsupported) {
        it(`is rejected with ${exp.unsupported}`, async () => {
          const produced = await netlistForCase(dir);
          assert.throws(
            () => prepareCompat(produced),
            (err: unknown) => err instanceof ToolError && err.code === exp.unsupported,
            `${name}: expected ${exp.unsupported}`,
          );
        });
        return;
      }

      if (exp.translation) {
        it(`records a translation mentioning "${exp.translation}"`, async () => {
          const produced = await netlistForCase(dir);
          const prep = prepareCompat(produced);
          assert.ok(
            prep.translations.some((t) => t.message.includes(exp.translation as string) || t.construct.includes(exp.translation as string)),
            `${name}: no translation mentioned ${exp.translation}; got ${JSON.stringify(prep.translations)}`,
          );
        });
      }

      it("runs under ngspice compatibility mode", { skip: !hasReal }, async () => {
        const produced = await netlistForCase(dir);
        const work = mkdtempSync(join(tmpdir(), `openspice-corpus-${name}-`));
        try {
          const roots = new Roots([work]);
          const result = await runSimulation(produced, { roots, ngspiceBin: realNgspice, timeoutMs: 60_000 });
          assert.equal(result.status, "ok");

          if (exp.runTranslation) {
            assert.ok(
              result.translations.some((t) => t.message.includes(exp.runTranslation as string) || t.construct.includes(exp.runTranslation as string)),
              `${name}: no run translation mentioned ${exp.runTranslation}; got ${JSON.stringify(result.translations)}`,
            );
          }

          const tolFor = (key: string, want: number) => exp.tolerances?.[key] ?? Math.max(Math.abs(want) * (exp.relTol ?? 0.02), 1e-9);

          if (exp.measurements) {
            const byName = new Map(result.measurements.map((m) => [m.name.toLowerCase(), m.value]));
            for (const [measName, want] of Object.entries(exp.measurements)) {
              const got = byName.get(measName.toLowerCase());
              assert.ok(got !== undefined, `${name}: measurement ${measName} missing; got ${[...byName.keys()].join(", ")}`);
              const tol = tolFor(measName, want);
              assert.ok(Math.abs((got as number) - want) <= tol, `${name}: ${measName} = ${got}, expected ${want} ± ${tol}`);
            }
          }

          if (exp.nodes) {
            const summary = summarize(result.raw, Object.keys(exp.nodes));
            const byVar = new Map(summary.variables.map((v) => [v.name.toLowerCase(), v]));
            for (const [varName, want] of Object.entries(exp.nodes)) {
              const v = byVar.get(varName.toLowerCase());
              assert.ok(v, `${name}: variable ${varName} missing; got ${[...byVar.keys()].join(", ")}`);
              const got = v?.final ?? null;
              assert.ok(got !== null, `${name}: variable ${varName} had no final value`);
              const tol = tolFor(varName, want);
              assert.ok(Math.abs((got as number) - want) <= tol, `${name}: ${varName} final = ${got}, expected ${want} ± ${tol}`);
            }
          }
        } finally {
          rmSync(work, { recursive: true, force: true });
        }
      });

      // When a case records no reference values and no real engine is present,
      // the golden-connectivity assertion above is the whole check (R14.3).
    });
  }
});
