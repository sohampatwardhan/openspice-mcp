# Requirements Document

## Introduction

OpenSPICE-MCP is an MCP stdio server that lets an AI agent work with SPICE circuits through typed tools instead of shell commands. It parses and validates SPICE netlists (`.cir`, `.net`, `.sp`) and LTspice schematic and symbol files (`.asc`, `.asy`), converts a schematic to a netlist, generates readable LTspice `.asc` schematics from a structured circuit description, runs simulations with LTspice or ngspice, and parses the resulting `.raw` waveform files (binary and ASCII, real and complex, stepped) into measurements, waveform summaries, and optional plots. It is the SPICE sibling of the owner's `kiro-mcp-server` and follows that repo's layout, tooling, CI, release, and safety conventions.

Scope calls made for this spec (rationale in `design.md`): the server exposes a fixed, strict tool set with no shell escape hatch; it shells out only to detected LTspice or ngspice backends, never to arbitrary commands; all file access is confined to configured roots; `.asc` generation targets readable auto-placement for small-to-medium circuits, not pixel-perfect reproduction of hand-drawn sheets; plotting is optional and off by default. Out of scope for this release: editing existing `.asc` files in place, Monte Carlo and worst-case analysis orchestration beyond passing through `.step`, waveform math expressions beyond the measurements the backend reports, and a GUI.

```mermaid
---
config:
  layout: elk
---
flowchart LR
  agent["AI agent"] --> parse["Parse / validate"]
  agent --> gen["Generate .asc"]
  parse --> sim["Run simulation"]
  gen --> sim
  sim --> raw["Parse .raw"]
  raw --> result["Measurements, waveforms, plot"]
  agent --> status["Probe backends"]
```

## Requirements

### Requirement 1

**User Story:** As an agent, I want to probe the host for SPICE backends, so that I know which simulators and file operations are available before I call other tools.

#### Acceptance Criteria

1. WHEN the probe tool is called THEN the system SHALL report, for each known backend (`ltspice`, `ngspice`), whether it is installed, its resolved executable path, its reported version when obtainable, and the invocation mode it will use (native `-b` batch, or Wine-wrapped on Linux).
2. WHEN LTspice is found on a non-Windows host THEN the system SHALL report the platform-specific launch method (native macOS app or Linux-via-Wine) and any reduced-capability warning for that method.
3. WHEN no backend is installed THEN the system SHALL return an empty backend list with a human-readable install hint per backend and SHALL NOT fail the call.
4. WHEN the probe tool is called THEN the system SHALL report the configured roots, the default backend selection order, and whether plotting is enabled.

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

**User Story:** As an agent, I want to convert an LTspice schematic into a SPICE netlist, so that I can simulate a captured design with any backend.

#### Acceptance Criteria

1. WHEN an `.asc` file is given THEN the system SHALL resolve each component's pins to nets derived from wire connectivity and net labels, and SHALL emit a SPICE netlist whose devices, nodes, values, and on-sheet directives match the schematic.
2. WHEN a component references an `.asy` symbol with a defined pin order THEN the system SHALL order the netlist node list to match that pin order.
3. IF two placed components or wires imply a short or an unconnected pin THEN the system SHALL emit the netlist and attach a connectivity warning naming the component and pin.
4. WHEN requested THEN the system SHALL write the netlist to a `.cir`/`.net` path inside the roots, refusing to overwrite an existing file unless overwrite is set, and otherwise SHALL return the netlist text only.

### Requirement 5

**User Story:** As an agent, I want to generate an LTspice `.asc` schematic from a structured circuit description, so that I can hand a user an editable, readable schematic rather than only a netlist.

#### Acceptance Criteria

1. WHEN a circuit description of components (type, reference, value, symbol) and connections (named nets joining component pins) is given THEN the system SHALL produce a valid `.asc` file that LTspice can open, with components placed on the LTspice grid and wires routed orthogonally between their pins.
2. WHEN placing components THEN the system SHALL assign grid coordinates so that components do not overlap and labels remain legible, and SHALL place a ground flag on every net named `0` or `GND`.
3. WHEN routing wires THEN the system SHALL connect every pin that shares a net and SHALL add a net-label flag for each named net other than ground.
4. IF the description includes analysis directives THEN the system SHALL place them as a SPICE directive on the sheet.
5. IF the description is inconsistent (an unknown symbol, a pin referenced on no net, or a net joining fewer than two pins) THEN the system SHALL reject the request with a diagnostic identifying the offending element and SHALL NOT write a file.
6. WHEN requested THEN the system SHALL write the `.asc` to a path inside the roots, refusing to overwrite unless overwrite is set, and SHALL be able to emit the equivalent netlist for the same description.

### Requirement 6

**User Story:** As an agent, I want to run a simulation on a netlist or schematic, so that I can get results without driving a simulator by hand.

#### Acceptance Criteria

1. WHEN a netlist path, inline netlist, or `.asc` path and an analysis (`op`, `tran`, `ac`, `dc`, `noise`, or "use directives in the file") is given THEN the system SHALL run it on the selected or default backend in batch mode and SHALL return the run status, the backend used, the produced `.raw` and log paths inside a working directory within the roots, and any solver diagnostics.
2. WHEN the input is an `.asc` file THEN the system SHALL convert it to a netlist first (Requirement 4) and simulate the netlist.
3. WHEN the netlist contains `.step` or `.meas` directives THEN the system SHALL preserve them so the backend produces stepped data and measurement output.
4. IF no backend is available, or the requested backend is not installed THEN the system SHALL return a `BACKEND_NOT_FOUND` error naming the missing backend and the install hint, without starting a process.
5. IF the simulation exceeds the configured timeout THEN the system SHALL stop the backend process group and return a `SIM_TIMEOUT` error with the captured log tail.
6. IF the backend exits nonzero or reports a convergence or syntax failure THEN the system SHALL return a `SIM_FAILED` error carrying the parsed error lines and the log tail, and SHALL NOT return partial results as success.
7. WHEN a simulation completes THEN every process it started SHALL be terminated, and the server SHALL leave no backend process running.

### Requirement 7

**User Story:** As an agent, I want parsed simulation results, so that I can report measurements and waveform behavior without handling binary files.

#### Acceptance Criteria

1. WHEN a `.raw` file produced by a run (or given by path inside the roots) is read THEN the system SHALL detect its format (LTspice binary, ngspice binary, or ASCII) and report the variable list (name, unit/kind), the number of points, and whether the data is real or complex.
2. WHEN the data is complex (an `.ac` run) THEN the system SHALL return magnitude and phase alongside the real and imaginary parts for requested variables.
3. WHEN the run was stepped (`.step`) THEN the system SHALL report the step count and the parameter values per step, and SHALL key returned waveforms by step index.
4. WHEN waveform data is requested THEN the system SHALL return a summary per variable (min, max, final value, and for time-domain data an approximate peak-to-peak and mean) and SHALL return downsampled sample arrays bounded by a configured maximum point count rather than every raw point.
5. WHEN the netlist contained `.meas` directives THEN the system SHALL parse the measurement results from the log and return them as name/value pairs.
6. IF the `.raw` file is truncated or its header is unrecognized THEN the system SHALL return a `RAW_PARSE_FAILED` error identifying where parsing stopped.
7. WHEN a plot is requested AND plotting is enabled THEN the system SHALL render the selected variables to an image file inside the roots and return its path; WHERE plotting is disabled the system SHALL return a diagnostic that plotting is off and SHALL still return the numeric summary.

### Requirement 8

**User Story:** As an operator, I want file and process access confined and the tool surface fixed, so that an agent driving the server cannot reach outside the project or run arbitrary commands.

#### Acceptance Criteria

1. IF any input or output path resolves (via `realpath`) outside the configured roots THEN the system SHALL reject the call with `PATH_OUTSIDE_ROOTS` before any file read, file write, or process start.
2. WHEN a backend is launched THEN the system SHALL spawn only a resolved LTspice or ngspice executable with a fixed argument vector built in one module, with no shell and no caller-supplied free-form flags.
3. IF a requested write target exists and overwrite is not set THEN the system SHALL return `PATH_EXISTS` and SHALL NOT modify the existing file.
4. IF an input file exceeds the configured size limit, or an inline netlist exceeds its length limit THEN the system SHALL return `CONTENT_TOO_LARGE` without parsing it.
5. WHEN the server shuts down (stdin close, SIGINT, SIGTERM, or SIGHUP) THEN the system SHALL terminate every tracked backend process group and exit.
