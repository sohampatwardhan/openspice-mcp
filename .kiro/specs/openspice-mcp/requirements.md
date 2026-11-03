# Requirements Document

## Introduction

OpenSPICE-MCP is an MCP stdio server that lets an AI agent work with SPICE circuits through typed tools instead of shell commands. It parses and validates SPICE netlists (`.cir`, `.net`, `.sp`) and LTspice schematic and symbol files (`.asc`, `.asy`), converts a schematic to a netlist, generates readable LTspice-openable `.asc` schematics from a structured circuit description, runs simulations with **ngspice**, and parses the resulting `.raw` waveform files into measurements, waveform summaries, and optional plots. It is the SPICE sibling of the owner's `kiro-mcp-server` and follows that repo's layout, tooling, CI, release, and safety conventions.

ngspice is the sole required simulation engine, on every platform and in CI. LTspice was the inspiration for the file formats, not a runtime dependency: generated and edited `.asc`, `.asy`, netlist, and `.raw` files are a hard fidelity requirement and MUST open in LTspice, but the circuits are *simulated* with ngspice using its LTspice compatibility mode (`set ngbehavior=lt`, plus `ltps`/`ltpsa` where PSpice-style libraries are involved). Where an LTspice-only construct cannot run identically under ngspice, the server translates it when that is safe, and otherwise fails with a clear `UNSUPPORTED_LTSPICE_FEATURE` error naming the construct and line (Requirement 15).

A native LTspice simulation backend and a proxy to Analog Devices' official LTspice MCP bridge are **optional extras, Windows-x64 only, clearly secondary, and never required** (Requirement 16, 17). The parity table in `design.md` maps every official LTspice-MCP capability to an ngspice-backed, file-based OpenSPICE tool first, with the bridge noted only as an optional alternative. ADI documents that AI tools draw schematics poorly; OpenSPICE's differentiator is a deterministic `.asc` generator with a connectivity round-trip check (Requirement 5, 11).

Scope calls made for this spec (rationale in `design.md`): the server exposes a fixed, strict tool set with no shell escape hatch; it shells out only to a resolved ngspice (and, as optional extras, LTspice/Wine or the bridge), never to arbitrary commands; all file access is confined to configured roots; compatibility settings are written into a per-run `.spiceinit`/control block the server controls, never into the user's global config; the reference tool indexes the user's local docs and OpenSPICE's own docs and ships no ADI documentation. Out of scope for this release: GUI schematic editing, Monte Carlo and worst-case orchestration beyond `.step`, running or redistributing encrypted/proprietary vendor model libraries, and bundling any ADI content.

```mermaid
---
config:
  layout: elk
---
flowchart LR
  agent["AI agent"] --> design["Open / list / edit design"]
  agent --> parse["Parse / validate"]
  agent --> gen["Generate .asc + round-trip check"]
  design --> compat["LTspice compatibility layer"]
  parse --> compat
  gen --> compat
  compat --> sim["Run ngspice (ngbehavior=lt)"]
  sim --> raw["Write/parse .raw (ngspice + LTspice-compatible)"]
  raw --> result["Measurements, waveforms, export, plot"]
  agent --> status["Probe ngspice + optional extras"]
  agent --> refdoc["ngspice / local reference"]
```

## Requirements

### Requirement 1

**User Story:** As an agent, I want to probe the host for ngspice and any optional extras, so that I know what is available before I call other tools.

#### Acceptance Criteria

1. WHEN the probe tool is called THEN the system SHALL report whether ngspice is installed, its resolved executable path, its reported version, and whether that version supports the required LTspice compatibility mode (`ngbehavior=lt`); IF ngspice is missing THEN the system SHALL return a human-readable install hint and SHALL NOT fail the call.
2. WHEN ngspice is present but older than the recorded minimum compatibility-mode version THEN the system SHALL report a capability warning naming the found and required versions.
3. WHEN the probe tool is called THEN the system SHALL report the configured roots, whether plotting is enabled, and whether each optional extra (native LTspice backend, LTspice MCP bridge) is enabled.
4. WHERE the host is Windows x64 AND the LTspice extra or bridge is enabled THEN the system SHALL report whether a native LTspice executable and `ltspice-mcp-bridge.exe` are present, with paths and versions when obtainable; WHERE the host is not Windows x64 THEN the system SHALL report the bridge as unavailable with a one-line reason.

### Requirement 2

**User Story:** As an agent, I want to parse and validate a SPICE netlist, so that I can inspect its devices, nets, and analyses and catch errors before simulating.

#### Acceptance Criteria

1. WHEN a path to a `.cir`, `.net`, or `.sp` file inside the roots is given THEN the system SHALL return a structured netlist: the title line, every device (type, instance name, connected nodes, value or model, parameters), subcircuit definitions, model statements, included files, and analysis/control directives (`.op`, `.tran`, `.ac`, `.dc`, `.noise`, `.step`, `.meas`, `.param`).
2. WHEN netlist text is supplied inline instead of a path THEN the system SHALL parse it with the same result shape.
3. IF the netlist references a `.include` or `.lib` path THEN the system SHALL resolve it relative to the netlist's directory, confine it to the roots, and record each resolved and unresolved reference without reading files outside the roots.
4. IF a line cannot be parsed THEN the system SHALL return a diagnostic with the 1-based line number, the offending text, and a reason, and SHALL continue parsing the remaining lines.
5. WHEN validation is requested THEN the system SHALL report floating nodes, nodes connected to a single device, duplicate instance names, missing models or subcircuits, and the absence of a ground (`0`) node as warnings or errors without modifying the file.

### Requirement 3

**User Story:** As an agent, I want to read an LTspice schematic or symbol file, so that I can understand a captured design without opening LTspice.

#### Acceptance Criteria

1. WHEN a path to an `.asc` file inside the roots is given THEN the system SHALL return the sheet's components (symbol name, instance reference, value, grid coordinates, rotation/mirror), wires (endpoint coordinates), net labels/flags, and directive text (`.tran`, `.ac`, SPICE directives placed on the sheet).
2. WHEN a path to an `.asy` symbol file is given THEN the system SHALL return the symbol's pins (name, order, coordinates), drawing primitives, and attributes.
3. IF the file is UTF-16 or UTF-8 with a BOM, or uses CRLF line endings THEN the system SHALL decode it correctly and report the detected encoding.
4. IF a line uses an `.asc` keyword the parser does not model THEN the system SHALL preserve it as a raw directive entry rather than dropping it, and SHALL record a diagnostic naming the keyword.

### Requirement 4

**User Story:** As an agent, I want to convert an LTspice schematic into a SPICE netlist, so that I can simulate a captured design with ngspice.

#### Acceptance Criteria

1. WHEN an `.asc` file is given THEN the system SHALL resolve each component's pins to nets derived from wire connectivity and net labels, and SHALL emit a SPICE netlist whose devices, nodes, values, and on-sheet directives match the schematic.
2. WHEN a component references an `.asy` symbol with a defined pin order THEN the system SHALL order the netlist node list to match that pin order, resolving the symbol from OpenSPICE's bundled open symbol set or from a configured symbol search path, and from the user's LTspice `sym` folder only when it is installed and inside an allowed location.
3. IF two placed components or wires imply a short or an unconnected pin THEN the system SHALL emit the netlist and attach a connectivity warning naming the component and pin.
4. WHEN requested THEN the system SHALL write the netlist to a `.cir`/`.net` path inside the roots, refusing to overwrite an existing file unless overwrite is set, and otherwise SHALL return the netlist text only.

### Requirement 5

**User Story:** As an agent, I want to generate an LTspice-openable `.asc` schematic from a structured circuit description, so that I can hand a user an editable, readable schematic rather than only a netlist.

#### Acceptance Criteria

1. WHEN a circuit description of components (type, reference, value, symbol) and connections (named nets joining component pins) is given THEN the system SHALL produce a valid `.asc` file that LTspice can open, using the byte format LTspice expects (Requirement 18), with components placed on the LTspice grid and wires routed orthogonally between their pins.
2. WHEN placing components THEN the system SHALL assign grid coordinates so that components do not overlap and labels remain legible, and SHALL place a ground flag on every net named `0` or `GND`.
3. WHEN routing wires THEN the system SHALL connect every pin that shares a net and SHALL add a net-label flag for each named net other than ground.
4. IF the description includes analysis directives THEN the system SHALL place them as a SPICE directive on the sheet.
5. IF the description is inconsistent (an unknown symbol, a pin referenced on no net, or a net joining fewer than two pins) THEN the system SHALL reject the request with a diagnostic identifying the offending element and SHALL NOT write a file.
6. WHEN requested THEN the system SHALL write the `.asc` to a path inside the roots, refusing to overwrite unless overwrite is set, and SHALL be able to emit the equivalent netlist for the same description.

### Requirement 6

**User Story:** As an agent, I want to run a simulation on a netlist or schematic with ngspice, so that I can get results without driving a simulator by hand.

#### Acceptance Criteria

1. WHEN a netlist path, inline netlist, or `.asc` path and an analysis (`op`, `tran`, `ac`, `dc`, `noise`, or "use directives in the file") is given THEN the system SHALL run it with ngspice in batch mode, applying the LTspice compatibility settings via a per-run `.spiceinit`/control block the server writes (Requirement 15), and SHALL return the run status, the ngspice version used, the produced `.raw` and log paths inside a working directory within the roots, and any solver diagnostics.
2. WHEN the input is an `.asc` file THEN the system SHALL convert it to a netlist first (Requirement 4) and simulate the netlist.
3. WHEN the netlist contains `.meas` directives THEN the system SHALL preserve or translate them so ngspice produces measurement output; WHEN it contains `.step` THEN the system SHALL emulate the sweep (Requirement 15) and assemble a stepped `.raw`.
4. IF ngspice is not installed THEN the system SHALL return a `BACKEND_NOT_FOUND` error with the install hint, without starting a process.
5. IF the simulation exceeds the configured timeout THEN the system SHALL stop the process group and return a `SIM_TIMEOUT` error with the captured log tail.
6. IF ngspice exits nonzero or reports a convergence or syntax failure THEN the system SHALL return a `SIM_FAILED` error carrying the parsed error lines and the log tail, and SHALL NOT return partial results as success.
7. WHEN a simulation completes THEN every process it started SHALL be terminated, and the server SHALL leave no process running.
8. WHERE the optional LTspice backend is enabled AND requested AND available THEN the system MAY run the simulation with native LTspice batch instead; otherwise it SHALL use ngspice. The LTspice backend SHALL never be required for any operation.

### Requirement 7

**User Story:** As an agent, I want parsed simulation results, so that I can report measurements and waveform behavior without handling binary files.

#### Acceptance Criteria

1. WHEN a `.raw` file produced by a run (or given by path inside the roots) is read THEN the system SHALL detect its format (ngspice Berkeley binary or ASCII, or LTspice binary) and report the variable list (name, unit/kind), the number of points, and whether the data is real or complex.
2. WHEN the data is complex (an `.ac` run) THEN the system SHALL return magnitude and phase alongside the real and imaginary parts for requested variables.
3. WHEN the run was stepped THEN the system SHALL report the step count and the parameter values per step, and SHALL key returned waveforms by step index.
4. WHEN waveform data is requested THEN the system SHALL return a summary per variable (min, max, final value, and for time-domain data an approximate peak-to-peak and mean) and SHALL return downsampled sample arrays bounded by a configured maximum point count rather than every raw point.
5. WHEN the netlist contained measurement directives THEN the system SHALL parse the measurement results from the log and return them as name/value pairs.
6. IF the `.raw` file is truncated or its header is unrecognized THEN the system SHALL return a `RAW_PARSE_FAILED` error identifying where parsing stopped.
7. WHEN a plot is requested AND plotting is enabled THEN the system SHALL render the selected variables to an image file inside the roots and return its path; WHERE plotting is disabled the system SHALL return a diagnostic that plotting is off and SHALL still return the numeric summary.

### Requirement 8

**User Story:** As an operator, I want file and process access confined and the tool surface fixed, so that an agent driving the server cannot reach outside the project or run arbitrary commands.

#### Acceptance Criteria

1. IF any input or output path resolves (via `realpath`) outside the configured roots THEN the system SHALL reject the call with `PATH_OUTSIDE_ROOTS` before any file read, file write, or process start.
2. WHEN ngspice, or an enabled optional extra (native LTspice, Wine, or `ltspice-mcp-bridge.exe`), is launched THEN the system SHALL spawn only that resolved executable with a fixed argument vector built in one module, with no shell and no caller-supplied free-form flags.
3. IF a requested write target exists and overwrite is not set THEN the system SHALL return `PATH_EXISTS` and SHALL NOT modify the existing file.
4. IF an input file exceeds the configured size limit, or an inline netlist exceeds its length limit THEN the system SHALL return `CONTENT_TOO_LARGE` without parsing it.
5. WHEN compatibility settings are applied THEN the system SHALL write them into a per-run file inside the run directory and SHALL NOT modify the user's global `.spiceinit` or any configuration outside the roots.
6. WHEN the server shuts down (stdin close, SIGINT, SIGTERM, or SIGHUP) THEN the system SHALL terminate every tracked process group and exit.

### Requirement 9

**User Story:** As an agent, I want a file-based "open designs" concept with get/set content, so that I have a working set and edit capability without a GUI.

#### Acceptance Criteria

1. WHEN a design (an `.asc` or netlist path inside the roots) is opened THEN the system SHALL record it in an in-memory open-designs set with a stable id and SHALL mark the most recently opened or acted-on design as the active design.
2. WHEN the open-designs list is requested THEN the system SHALL return each open design's id, path, kind (`schematic` or `netlist`), and whether it is active, and WHEN the active design path is requested THEN the system SHALL return it or report that none is active.
3. WHEN the content of a design is requested THEN the system SHALL return its current text and its detected encoding.
4. WHEN new content is set for a design THEN the system SHALL validate it (schematic parse or netlist parse) before writing, SHALL write it back to the design's path inside the roots in the LTspice-openable byte format for `.asc`/`.asy` (Requirement 18), and SHALL make the written text readable on the next get.
5. IF a backup or undo snapshot is requested on a set THEN the system SHALL save the prior content as a snapshot inside the roots and SHALL be able to restore the most recent snapshot for that design.
6. IF setting content produces a parse error THEN the system SHALL return a diagnostic and SHALL NOT overwrite the existing file.

### Requirement 10

**User Story:** As an agent, I want to retrieve the SPICE log, raw metadata, and exportable waveform data for a design or run, so that I can report errors and numbers.

#### Acceptance Criteria

1. WHEN the SPICE log for a design or a completed run is requested THEN the system SHALL return the log text (or its parsed error/warning lines) from the log produced for that design's most recent simulation, or report that no log exists yet.
2. WHEN raw info for a design or run is requested THEN the system SHALL return the `.raw` metadata (format, variable list, point count, real/complex, step structure) without returning full sample arrays.
3. WHEN waveform export is requested THEN the system SHALL write the selected variables to a CSV (or ASCII) file inside the roots and return its path, and SHALL refuse to overwrite an existing target unless overwrite is set.
4. IF no `.raw` result exists for the design THEN the system SHALL return a diagnostic naming the design and SHALL NOT fabricate data.

### Requirement 11

**User Story:** As an agent, I want the generated schematic verified by round-trip against the intended connectivity, so that an AI-produced `.asc` is trustworthy despite ADI's warning that AI tools draw schematics poorly.

#### Acceptance Criteria

1. WHEN an `.asc` is generated from a description THEN the system SHALL netlist the generated `.asc` (Requirement 4) and compare its device set and net connectivity against the intended connectivity derived from the description.
2. IF the round-trip netlist matches the intended connectivity THEN the system SHALL return the `.asc` with a `verified: true` result and the compared net/device counts.
3. IF the round-trip netlist does not match THEN the system SHALL return a `GENERATE_UNVERIFIED` result listing each differing net or pin and SHALL NOT present the schematic as verified, and WHERE strict mode is set the system SHALL treat the mismatch as an error and not write the file.

### Requirement 12

**User Story:** As an agent, I want to apply `.meas` and `.step` helpers and parameterize values on netlist text, so that I can set up measurements and sweeps as text edits.

#### Acceptance Criteria

1. WHEN a `.meas` helper is applied with a measurement specification THEN the system SHALL insert or update the corresponding `.meas` directive in the netlist text and SHALL return the edited text without running a simulation.
2. WHEN a `.step` helper is applied for a named parameter and value set THEN the system SHALL insert or update the `.param` and `.step` directives so the sweep is defined, and SHALL return the edited text.
3. WHEN a value is parameterized THEN the system SHALL replace the literal device value with a `{name}` reference and add a `.param name=<value>` directive, preserving the original value as the default.
4. IF a helper targets a device, parameter, or directive that is not present THEN the system SHALL return a diagnostic identifying it and SHALL NOT alter the text.

### Requirement 13

**User Story:** As an agent, I want a reference lookup that uses locally available docs, so that I can answer how-to questions without OpenSPICE bundling copyrighted help.

#### Acceptance Criteria

1. WHEN reference docs are listed THEN the system SHALL return the entries it can index: OpenSPICE's own bundled docs, pointers to the ngspice manual, and the user's local `LTspiceHelp` folder when it is installed and inside an allowed location, each tagged with its source.
2. WHEN a reference entry is fetched THEN the system SHALL return the text of an OpenSPICE-owned doc directly, and for a local `LTspiceHelp` entry SHALL return content read from the user's installed file rather than any copy shipped with OpenSPICE.
3. WHERE the `LTspiceHelp` folder is not installed or not inside an allowed location THEN the system SHALL omit those entries and SHALL still return OpenSPICE docs and the ngspice pointers.
4. THE system SHALL NOT bundle, redistribute, or embed Analog Devices' LTspice documentation in the package.

### Requirement 14

**User Story:** As a maintainer, I want a compatibility test corpus that runs in CI, so that parse, netlisting, ngspice runs, and measurements stay correct against known-good expectations.

#### Acceptance Criteria

1. WHEN the test suite runs THEN it SHALL exercise a fixtures corpus with golden expectations for parsing, `.asc`-to-netlist conversion, ngspice simulation, and measurement values, and CI SHALL run it on every push and pull request.
2. WHERE a fixture records expected measurement or waveform values (from a reference LTspice run when available) THEN the comparison SHALL pass only when the ngspice result is within the fixture's stated tolerance.
3. IF a fixture has no recorded reference values THEN the suite SHALL still assert that parse and netlist outputs match the golden text and that the ngspice run completes without error.
4. WHEN a new construct is marked unsupported or newly translated (Requirement 15) THEN a corpus fixture SHALL cover that behavior.

### Requirement 15

**User Story:** As an agent, I want LTspice-only constructs handled predictably under ngspice, so that an LTspice-flavoured netlist either runs correctly or fails with a clear reason.

#### Acceptance Criteria

1. WHEN a netlist is prepared for ngspice THEN the system SHALL apply LTspice compatibility through a per-run `.spiceinit`/control block setting `ngbehavior=lt` (and the `ltps`/`ltpsa` variants when PSpice-style libraries are pulled in), and SHALL NOT edit the user's global config (Requirement 8.5).
2. WHEN a netlist uses an LTspice-only construct that the compatibility layer can translate safely THEN the system SHALL translate it to the ngspice equivalent and record the translation in the run diagnostics.
3. IF a netlist uses an LTspice-only construct that cannot be run or safely translated THEN the system SHALL return an `UNSUPPORTED_LTSPICE_FEATURE` error naming the construct and the 1-based line, rather than running a silently incorrect simulation.
4. IF a netlist pulls in an encrypted or proprietary vendor model library that cannot be run with ngspice THEN the system SHALL return `UNSUPPORTED_LTSPICE_FEATURE` explaining that OpenSPICE cannot run or ship that library and that an open, user-supplied model is required.
5. WHERE LTspice standard libraries (`standard.dio`, `standard.bjt`, `standard.mos`) are needed THEN the system SHALL read them from the user's LTspice install when present and inside an allowed location, and otherwise SHALL require a user-supplied model and report which is missing.

### Requirement 16

**User Story:** As an operator on Windows x64, I want an optional native LTspice simulation backend, so that I can run with LTspice itself when I choose, while ngspice remains the default.

#### Acceptance Criteria

1. WHERE the native LTspice backend is enabled AND a native LTspice executable is present THEN the status tool SHALL report it available with its path and version.
2. WHEN a simulation explicitly selects the LTspice backend AND it is available THEN the system SHALL run native LTspice batch and return the same result shape as the ngspice path.
3. IF the LTspice backend is not enabled, not available, or not selected THEN the system SHALL use ngspice; the LTspice backend SHALL never be required and SHALL never be the default.

### Requirement 17

**User Story:** As an agent on Windows x64, I want OpenSPICE to optionally delegate to the official LTspice MCP bridge, so that I can drive a live LTspice instance when I choose.

#### Acceptance Criteria

1. WHERE delegation is enabled AND the host is Windows x64 AND `ltspice-mcp-bridge.exe` (LTspice 26.1.1 or later) is present THEN the system SHALL start the bridge as an MCP client subprocess and expose its availability through the status tool.
2. WHEN delegation is requested for a supported operation THEN the system SHALL forward the call to the bridge in headless mode by default, attaching to the user's open GUI instance (`--pid`/`--port`, loopback only) only when the caller explicitly asks for live-GUI edits.
3. IF delegation is disabled, unavailable, or the host is not Windows x64 THEN the system SHALL use the file-based ngspice path, which SHALL remain the default for every operation.
4. IF the bridge process exits or fails a forwarded call THEN the system SHALL return a `BRIDGE_UNAVAILABLE` error and SHALL fall back to the file-based path when the operation has a file-based equivalent.

### Requirement 18

**User Story:** As a user, I want generated and exported files to open in LTspice, so that OpenSPICE's output is interchangeable with LTspice even though simulation uses ngspice.

#### Acceptance Criteria

1. WHEN the system writes an `.asc` or `.asy` THEN it SHALL use the byte format LTspice reads for those files (line structure, keyword grammar, and the encoding/line-ending convention LTspice emits), so that LTspice opens the file without repair.
2. WHEN the system produces an LTspice-compatible `.raw` THEN it SHALL write the LTspice binary rawfile structure (a header, a `Flags:` line describing real/complex/double/stepped/forward, the variable list, and the binary payload in the trace widths LTspice uses) and SHALL retain ngspice's original `.raw` alongside it.
3. WHEN the system writes an LTspice-compatible `.raw` THEN it SHALL verify fidelity by re-reading the written file with its own parser and confirming the variables, point count, and sample values match the source within tolerance, and SHALL mark as uncertain any format detail not yet confirmed against a real LTspice file.
4. IF a requested interchange cannot be produced reliably THEN the system SHALL return the ngspice-native artifact plus a diagnostic that an LTspice-openable version was not produced, rather than writing a file LTspice would reject.
