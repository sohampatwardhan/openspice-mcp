# ngspice LTspice-compatibility notes (verified against ngspice 44.2)

This file records behaviour of the host's ngspice that the design marked
**uncertain**, verified against **ngspice 44.2** (Linux, build date 2025-01-12,
KLU direct solver) rather than guessed. The compatibility corpus (Requirement
14, task 20) pins these behaviours with golden fixtures; this document is the
human-readable record of what was checked and when.

## Compatibility mode (`set ngbehavior=lt`)

- **Verified: works, but must be set before the circuit is parsed.** ngspice
  reads a `.spiceinit` from the current working directory at startup (unless
  `-n`/`--no-spiceinit` is passed). A `.spiceinit` containing `set ngbehavior=lt`
  placed in the per-run directory turns on lt mode: the log then prints
  `Note: Compatibility modes selected: lt`. Setting `ngbehavior` from inside a
  `.control` block is **too late** — the log prints `Note: No compatibility mode
  selected!` because the deck was already parsed.
- **Consequence for the runner:** the compatibility `.spiceinit` is written into
  the per-run directory and ngspice is spawned with that directory as its cwd, so
  the setting is isolated to the run and the user's global `~/.spiceinit` is never
  touched (Requirement 8.5). `-n` is **not** passed, because we rely on the local
  `.spiceinit` being read; the per-run directory is freshly created and contains
  only our file.
- **Minimum version:** lt mode is present and working in 44.2. The design's
  stated floor of 34 remains **uncertain** (the exact first release of each of
  `lt`/`ltps`/`ltpsa` is not confirmed here); the status tool reports the found
  version and the caveat.

## `.step` is not implemented natively (even in lt mode)

- **Verified: a deck with `.step` fails.** Under lt mode, a `.step param ...`
  directive produces `Error ... unimplemented dot command '.step'` and the
  simulation is interrupted. This holds for `.step param <name> list ...` and is
  independent of the analysis.
- **Consequence:** `.step` is emulated (task 10). The sweep is expanded into an
  ngspice `.control` loop (`foreach`/`alter`/`run`) that runs the analysis once
  per step value and writes one rawfile section per step; the sections are then
  assembled into a single stepped result keyed by step index.

## `.meas` does not run in `-b -r <raw>` batch mode

- **Verified: measurement is refused with a rawfile set.** Running
  `ngspice -b -r out.raw -o out.log deck` where the deck contains `.meas`
  directives prints into the log:
  `No .measure possible in batch mode (-b) with -r rawfile set! Remove rawfile
  and use .print or .plot or select interactive mode ...`. No measurement values
  are produced.
- **Verified: measurement runs from a `.control` block.** A deck whose analysis
  and output are driven by a `.control` block (`run` then `write <raw>`), invoked
  as `ngspice -b -o out.log deck` (no `-r`), runs the `.meas` directives and
  prints results in the form `vmax = 6.321208e-01 at= 1.000001e-03` and
  `vfinal = 2.325446e-01`. The existing `parseMeas` reader matches this form.
- **Consequence for the runner:** OpenSPICE drives the simulation through a
  generated `.control` block (`run` + `write <raw>`) rather than the plain
  `-b -r` path, so a single deck supports both the raw result and `.meas` output.
  The deck is spawned as `ngspice -b -o <log> <deck>`; the rawfile is produced by
  the `write` command inside the control block, not by `-r`. `argv.ts` keeps the
  plain `batchRunArgv` (`-b -r <raw> -o <log> <deck>`) for callers that do not
  need measurement, and adds `controlRunArgv` (`-b -o <log> <deck>`) for the
  control-block path the runner uses.

## `write` and stepped-raw assembly

- **Verified: repeated `write <file>` overwrites.** Writing to the same filename
  on each loop iteration leaves only the last plot (`No. Points: 1`).
- **Verified: `set appendwrite` concatenates independent rawfile sections.** With
  `set appendwrite`, each `write <file>` appends a complete rawfile section (its
  own ASCII `Title:`…`Binary:` header followed by the payload) to the file, so a
  three-step sweep yields three concatenated Berkeley rawfile sections in one
  file.
- **Consequence:** the `.step` emulator uses `set appendwrite` and a single
  output file, then the stepped-raw reader (task 10) splits the file into its
  per-step sections and exposes them keyed by step index. ngspice variable
  filename interpolation inside `foreach` (`step{$idx}.raw`) did **not** expand in
  44.2, so a single appended file is used rather than per-step filenames.

## Raw payload precision

- **Verified: ngspice 44.2 writes float64 payloads** for both `real` and
  `complex` runs on this host (matches the reader's size-based detection). Whether
  a single-precision build would write float32 remains **uncertain**; the reader
  detects width from the payload size against the header counts rather than
  assuming, so both are handled.

## LTspice binary `.raw` fidelity (writer, task 17)

- LTspice is not available on this host, so the LTspice binary layout the writer
  produces (UTF-16LE header, CRLF, float64 time axis + float32 traces for a real
  transient) remains **uncertain** against a genuine LTspice file and is pinned by
  the hand-crafted fixture and the writer's own re-read round-trip rather than by
  a real LTspice open. Every field the writer relies on is tagged uncertain in the
  module and the fidelity gate is the re-read comparison (Requirement 18.3).
