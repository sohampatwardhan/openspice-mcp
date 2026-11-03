# LTspice-vs-ngspice compatibility

Circuits are simulated with ngspice in LTspice compatibility mode
(`set ngbehavior=lt`, written into a per-run config inside the run directory,
never your global `.spiceinit`; the `ltpsa` variant is used when a PSpice-style
library appears). For each LTspice-only construct the layer either translates it
(recorded in `translations`) or fails with `UNSUPPORTED_LTSPICE_FEATURE` naming
the construct and its 1-based line. Details confirmed against the host engine are
recorded in the repo's `docs/compatibility.md`; the compatibility corpus pins the
behavior in CI.

| Construct | Action |
| --- | --- |
| B-sources, most arithmetic/boolean operators | pass through |
| LTspice `uramp`, `limit`, `buf`, `inv` | pass through |
| `.meas` with a bare `AT <value>` clause | rewritten to `AT=<value>` (recorded) |
| `.options plotwinsize`, `numdgt`, `measdgt`, `nomarch` | dropped with a note |
| `Rser`/`Cpar` on L/C/V | passed through to lt mode; verify (partial support) |
| `.step` | emulated with a control loop into a stepped raw |
| LTspice `A` special-function devices (DIFFSCHMITT, SAMPLEHOLD, MODULATE, ...) | `UNSUPPORTED_LTSPICE_FEATURE` |
| `.machine` state machines | `UNSUPPORTED_LTSPICE_FEATURE` |
| `.net` network parameters | `UNSUPPORTED_LTSPICE_FEATURE` |
| `.wave` WAV export | `UNSUPPORTED_LTSPICE_FEATURE` |
| Encrypted/proprietary vendor `.lib` | `UNSUPPORTED_LTSPICE_FEATURE`; supply an open user model |
| LTspice `standard.dio/.bjt/.mos` | read from the user's install when present and allowed, else a user model is required |

Two things verified on the host and worth remembering:

- `.meas` does not run in plain `-b -r <raw>` batch mode. OpenSPICE drives the
  run through a generated `.control` block so a single deck yields both the raw
  result and `.meas` output. You do not manage this; it is automatic.
- ngspice does not support `.meas op`. Use a `.tran`/`.ac`/`.dc` analysis for
  measurements, or read the node value from the `.op` rawfile instead.

Anything not yet confirmed against a real LTspice file (notably the LTspice binary
`.raw` field widths) is treated as uncertain and gated by the writer's re-read
round-trip rather than asserted.
