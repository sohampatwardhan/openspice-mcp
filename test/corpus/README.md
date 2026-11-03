# Compatibility test corpus

Each subdirectory is one compatibility case the suite in
[`../corpus.test.ts`](../corpus.test.ts) runs (Requirement 14). A case parses (or
converts an `.asc`), compares device connectivity against a golden netlist, and —
when a real ngspice is on the host (the CI `test` job installs it) — runs the
circuit through the LTspice compatibility layer and checks measurements or node
values within a stated tolerance. Cases with no reference values still assert that
parse and netlist match and that the ngspice run completes (Requirement 14.3).

## Files in a case

| File | Required | Purpose |
| --- | --- | --- |
| `input.cir` **or** `input.asc` | yes | The circuit. `.asc` is converted to a netlist first. |
| `expected.net` | for parse/convert cases | Golden netlist; the runner compares device-level connectivity (names, nodes), not byte text. |
| `expected.meas.json` | optional | Expectations for the run (see below). Absent means parse/connectivity is the whole check. |
| `notes.md` | recommended | What the case exercises, the reference value's source, and a certainty note. |

## `expected.meas.json` shape

All fields are optional; include only what the case asserts.

```jsonc
{
  "analysis": "tran",                 // documentation only
  "unsupported": "UNSUPPORTED_LTSPICE_FEATURE", // assert prepareCompat rejects the deck with this code
  "translation": ".options",          // assert prepareCompat records a translation mentioning this
  "runTranslation": ".meas",          // assert the run result records a translation mentioning this
  "measurements": { "vfinal": 1.0 },  // assert parsed .meas values (within tolerance)
  "nodes": { "v(out)": 0.5 },         // assert a variable's final value from the first-step raw summary
  "tolerances": { "vfinal": 0.01 },   // per-key absolute tolerance
  "relTol": 0.02                      // default relative tolerance when a key has none
}
```

A case that sets `unsupported` asserts the rejection and skips the run; the other
fields drive the ngspice run (skipped when no real engine is present).

## Current cases

| Case | Exercises |
| --- | --- |
| `resistor_divider` | Parse + `.op` node value under `ngbehavior=lt`. |
| `divider_asc` | `.asc` → netlist conversion + on-sheet `!.op` + node value. |
| `rc_lowpass_tran` | `.tran` + `.meas` with an LTspice bare `AT <value>` clause rewritten to `AT=<value>`. |
| `dropped_options` | LTspice-only `.options` keys dropped with a recorded translation. |
| `stepped_divider` | `.step` device sweep emulated with a control loop into a stepped raw. |
| `unsupported_adevice` | LTspice `A` special-function device rejected with `UNSUPPORTED_LTSPICE_FEATURE`. |

## Adding your own LTspice circuits

Drop a real LTspice schematic or netlist here to pin its behavior:

1. `mkdir test/corpus/<your_case>` and add `input.asc` (or `input.cir`).
2. Add `expected.net` — the simplest way is to run `openspice_schematic_to_netlist`
   (or `openspice_parse_netlist`) and save the device section as the golden.
3. If you have a reference LTspice run, record its measured or node values and a
   tolerance in `expected.meas.json`; otherwise leave it out and the suite still
   checks parse, connectivity, and that the ngspice run completes.
4. Write a short `notes.md` saying where the reference value came from and how
   certain it is.

No real LTspice or the bridge is ever required to run the corpus; ngspice (or, in
unit tests elsewhere, the fake fixture) is the engine.
