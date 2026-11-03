# OpenSPICE MCP Server

An MCP server for SPICE circuit work. It reads SPICE netlists (`.cir`, `.net`, `.sp`) and LTspice schematics (`.asc`, `.asy`), converts schematics to netlists, generates LTspice-openable schematics from a circuit description (verified by round-trip), and runs simulations with **ngspice** in LTspice-compatibility mode, returning measurements and waveform summaries from the `.raw` results.

ngspice is the one required simulation engine, on every platform and in CI. LTspice is the format inspiration, not a runtime dependency: files OpenSPICE writes are meant to open in LTspice, but circuits are simulated with ngspice in its LTspice compatibility mode (`set ngbehavior=lt`). A native LTspice backend and a proxy to ADI's official LTspice MCP bridge are optional, Windows-x64-only extras, never required.

> Status: in development. See [`.kiro/specs/openspice-mcp/`](.kiro/specs/openspice-mcp/) for requirements, design, and tasks. No release yet.

## Usage

```json
{
  "mcpServers": {
    "openspice": {
      "command": "npx",
      "args": ["-y", "@sohampatwardhan/openspice-mcp@latest"]
    }
  }
}
```

### Configuration

All configuration is through environment variables; there is no shell tool and no free-form flags.

| Variable | Purpose |
| --- | --- |
| `OPENSPICE_ROOTS` | Comma-separated absolute directories the server may read, write, and run in. Defaults to the working directory. |
| `OPENSPICE_NGSPICE_BIN` | Path or name of the ngspice binary (default `ngspice`, looked up on `PATH`). |
| `OPENSPICE_ALLOW_PLOTS` | Enable SVG waveform plots (off by default). |
| `OPENSPICE_LTSPICE_HELP_DIR` | The user's installed LTspice help directory, read only when inside an allowed location. |
| `OPENSPICE_SYMBOL_PATH` | Extra directories searched for `.asy` symbols. |
| `OPENSPICE_ENABLE_LTSPICE` / `OPENSPICE_LTSPICE_BIN` | Optional native LTspice backend (Windows x64 only), off by default. |
| `OPENSPICE_ENABLE_BRIDGE` / `OPENSPICE_BRIDGE_BIN` | Optional LTspice MCP bridge proxy (Windows x64 only), off by default. |
| `OPENSPICE_WINE_BIN` | Optional Wine binary for a Windows LTspice off Windows (never required). |

## Tools

Call `openspice_status` first. Every tool has a strict input schema, an output schema, and returns structured content; failures return `{ "error": { "code", "message", "details" } }`.

| Tool | Purpose |
| --- | --- |
| `openspice_status` | ngspice path, version, and compat-mode support; roots; plotting flag; optional-extras availability; warnings. |
| `openspice_parse_netlist` | Parse a netlist (path or inline), optionally validate structure. |
| `openspice_read_schematic` | Read an LTspice `.asc`/`.asy`, reporting the detected encoding. |
| `openspice_schematic_to_netlist` | Convert an `.asc` to a netlist (optionally written into the roots). |
| `openspice_generate_schematic` | Generate an LTspice-openable `.asc` from a description and verify it by round-trip. |
| `openspice_simulate` | Run a netlist or `.asc` with ngspice in LTspice-compatibility mode; returns summary, measurements, and translations. |
| `openspice_read_raw` | Parse a `.raw`, return a bounded summary, optionally write an LTspice-compatible raw and/or an SVG plot. |
| `openspice_raw_info` | `.raw` metadata only (no sample arrays). |
| `openspice_export_waveforms` | Export selected `.raw` variables to CSV/ASCII inside the roots. |
| `openspice_get_log` | Read a SPICE `.log` with parsed measurements and error lines. |

## Error codes

| Code | Condition |
| --- | --- |
| `INVALID_ARGUMENT` | A tool argument was invalid or inconsistent (e.g. both or neither of `path`/`text` supplied, or an undetermined file kind). |
| `PATH_OUTSIDE_ROOTS` | A path resolved outside every configured root; no IO or process started. |
| `PATH_EXISTS` | A write target exists and `overwrite` was not set; the existing file is unchanged. |
| `CONTENT_TOO_LARGE` | Input exceeds the configured file or inline-text size limit; it is not parsed. |
| `GENERATE_INVALID` | A circuit description was inconsistent; no file written. |
| `GENERATE_UNVERIFIED` | A generated `.asc` did not round-trip to the intended connectivity (strict mode). |
| `UNSUPPORTED_LTSPICE_FEATURE` | An LTspice-only construct ngspice cannot run or translate; the construct and line are named. |
| `BACKEND_NOT_FOUND` | ngspice could not be started; no process ran. |
| `SIM_TIMEOUT` | A simulation exceeded its timeout; the process group was killed and a log tail returned. |
| `SIM_FAILED` | ngspice exited nonzero or reported a convergence/syntax error; the log tail is returned. |
| `RAW_PARSE_FAILED` | A `.raw` file was truncated or had an unknown header. |
| `DESIGN_NOT_FOUND` | An unknown open-design id was referenced. |
| `BRIDGE_UNAVAILABLE` | The optional LTspice MCP bridge is disabled, absent, or failed; the file-based path is used when available. |
| `INTERNAL_ERROR` | An unexpected error; the message carries the detail. |

## License

MIT
