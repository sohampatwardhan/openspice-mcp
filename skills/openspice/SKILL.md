---
name: openspice
description: Use when working with SPICE circuits through the openspice-mcp MCP tools (openspice_status, openspice_parse_netlist, openspice_read_schematic, openspice_schematic_to_netlist, openspice_generate_schematic, openspice_designs, openspice_netlist_edit, openspice_simulate, openspice_read_raw, openspice_raw_info, openspice_export_waveforms, openspice_get_log, openspice_reference). Covers probing the host, opening and editing designs, parsing and validating netlists and LTspice schematics, generating a verified .asc, simulating with ngspice in LTspice compatibility mode, reading results and the log, exporting waveforms, writing an LTspice-compatible raw, and recovering from failures. Notes the native LTspice backend and the LTspice MCP bridge as optional Windows-x64 extras.
metadata:
  author: Soham Patwardhan
  version: "1.0.0"
---

# Working with SPICE circuits through openspice-mcp

The `openspice-mcp` server drives SPICE work through typed, file-based tools. You
call tools; there is no shell and no way to pass raw simulator flags. ngspice is
the one required engine, on every platform. LTspice is the format inspiration,
not a runtime dependency: files the server writes are meant to open in LTspice,
but circuits are simulated with ngspice in its LTspice compatibility mode
(`set ngbehavior=lt`). The tool cheat sheet is in [references/tools.md](references/tools.md),
the official-LTspice-MCP parity map is in [references/parity.md](references/parity.md),
the LTspice-vs-ngspice compatibility table is in [references/compatibility.md](references/compatibility.md),
and the failure playbook is in [references/recovery.md](references/recovery.md).

## Before anything else

1. Call `openspice_status`. It reports whether ngspice is installed (resolved
   path and version), whether that version meets the minimum for compatibility
   mode (`compat_mode_min_version`, stated as 34 and marked uncertain), the
   configured `roots`, whether plotting is enabled, and whether each optional
   Windows-x64 extra is enabled and available. If `ngspice.found` is false, show
   the `install_hint`; do not try to simulate.
2. Work only inside the listed `roots`. Any path that resolves outside them fails
   with `PATH_OUTSIDE_ROOTS` before any read, write, or spawn. Writes refuse to
   overwrite unless you pass `overwrite: true` (otherwise `PATH_EXISTS`).

## Open and edit designs

- `openspice_designs` is the file-based session: `open` a `.asc` or netlist path,
  `list` the open set, get the `active` one, `get_content`/`set_content`,
  `snapshot` before an edit, `restore` the last snapshot, and `list_changed`
  with a cursor. `set_content` validates before writing and never overwrites on a
  parse error, so a bad edit leaves the file untouched.
- `openspice_netlist_edit` applies text helpers to a netlist without simulating:
  add or update a `.meas`, define a `.step` sweep, or parameterize a device value
  into a `{name}` plus a `.param`. A helper that targets a missing device or
  directive returns a diagnostic and changes nothing.

## Parse, read, convert

- `openspice_parse_netlist` parses a `.cir`/`.net`/`.sp` (path or inline `text`)
  into devices, nets, models, subcircuits, includes, and directives, with
  per-line diagnostics; set `validate: true` for floating-node, duplicate-name,
  missing-model, and no-ground checks.
- `openspice_read_schematic` reads a `.asc` or `.asy`, reporting components,
  wires, flags, directives, and the detected encoding; unknown keywords are kept
  as raw entries, never dropped.
- `openspice_schematic_to_netlist` converts a `.asc` to a netlist, ordering nodes
  by symbol pin order and warning on shorts or unconnected pins.

## Generate a schematic you can trust

`openspice_generate_schematic` turns a structured circuit description into an
LTspice-openable `.asc`, then round-trips it: it netlists the generated `.asc`
and compares connectivity against the intent. A match returns `verified: true`
with device/net counts; a mismatch returns `GENERATE_UNVERIFIED` with the
differing nets, and in `strict` mode it does not write the file. An inconsistent
description (unknown symbol, a pin on no net, a net joining fewer than two pins)
is rejected with `GENERATE_INVALID` and writes nothing. This round-trip is the
reason to prefer generating over hand-drawing: never present an unverified
schematic as verified.

## Simulate with ngspice

`openspice_simulate` runs a netlist (path or inline `text`) or a `.asc`
(converted first) with ngspice. The analysis comes from the deck's
`.tran`/`.ac`/`.dc`/`.op`/`.noise` directive. Compatibility settings go into a
per-run config inside the run directory, never your global `.spiceinit`. `.step`
is emulated with a control loop into a stepped result; `.meas` runs in the same
batch (an LTspice bare `AT <value>` clause is rewritten to `AT=<value>` and the
rewrite is reported in `translations`). The result carries the status, the `.raw`
and `.log` paths, a bounded downsampled waveform summary, parsed measurements, and
the translations the compatibility layer applied.

An LTspice-only construct ngspice cannot run is reported as
`UNSUPPORTED_LTSPICE_FEATURE` naming the construct and its 1-based line, never run
as a silently different circuit. Missing ngspice is `BACKEND_NOT_FOUND`; a run
over the timeout is `SIM_TIMEOUT`; a nonzero/convergence/syntax failure is
`SIM_FAILED` with a log tail. See [references/compatibility.md](references/compatibility.md)
for which constructs translate and which fail.

## Read results, export, log

- `openspice_raw_info` returns `.raw` metadata only (format, variables, point
  count, real/complex, step structure).
- `openspice_read_raw` parses a `.raw` into per-variable summaries (min, max,
  final, mean, peak-to-peak) and bounded downsampled samples; for complex `.ac`
  data it adds magnitude and phase, and for a stepped run it keys waveforms by
  step index. It can also write an LTspice-compatible `.raw` beside the ngspice
  original, verified by re-reading it; if a reliable one cannot be produced you
  get the ngspice-native file plus a diagnostic. A plot is written only when
  plotting is enabled, otherwise you still get the numeric summary.
- `openspice_export_waveforms` writes selected variables to CSV/ASCII inside the
  roots (no overwrite unless asked).
- `openspice_get_log` returns the SPICE log (or parsed error/warning lines) for a
  design's most recent run, or reports that none exists yet.

## Reference lookup

`openspice_reference` lists and fetches docs from OpenSPICE's own bundled docs,
ngspice-manual pointers, and the user's local `LTspiceHelp` folder when it is
installed inside an allowed location. LTspice help content is read only from the
user's files; OpenSPICE ships no Analog Devices documentation.

## Optional Windows-x64 extras (planned, not available here)

Two optional Windows-x64 extras are planned but are **not built in this release**:
a native LTspice simulation backend and a proxy to ADI's official
`ltspice-mcp-bridge.exe`. Neither is required and ngspice file-based simulation is
always the path. `openspice_simulate` exposes no `backend` or `delegate` flag yet;
`openspice_status` reports both extras as unavailable on every host (and, off
Windows x64, with a one-line reason). The `BACKEND_NOT_FOUND` and
`BRIDGE_UNAVAILABLE` error codes are reserved for when these extras land.

## Recover

See [references/recovery.md](references/recovery.md). In short: read the error
`code`; `PATH_OUTSIDE_ROOTS`/`PATH_EXISTS` are confinement and overwrite guards,
`UNSUPPORTED_LTSPICE_FEATURE` names the construct and line to change or translate
yourself, `SIM_FAILED`/`SIM_TIMEOUT` carry a log tail, `RAW_PARSE_FAILED` reports
where parsing stopped, and `GENERATE_UNVERIFIED` lists the connectivity diffs.
