# Parity with the official LTspice MCP server

Every official LTspice-MCP capability maps first to an ngspice-backed, file-based
OpenSPICE tool (the default, works on every platform). The Windows-x64 bridge is
only an optional alternative route for the same tools.

| Official LTspice MCP capability | OpenSPICE tool (default, file-based ngspice) | Optional alternative |
| --- | --- | --- |
| `list_open_designs` | `openspice_designs` (list) | — |
| `open_design` | `openspice_designs` (open) | — |
| `get_active_design_path` | `openspice_designs` (active) | — |
| `get_design_content` | `openspice_designs` (get_content) | bridge |
| `set_design_content` | `openspice_designs` (set_content, snapshot) | bridge |
| `get_schematic_netlist` | `openspice_schematic_to_netlist` | bridge |
| run sim + read error log | `openspice_simulate` + `openspice_get_log` | LTspice backend / bridge |
| `get_spice_log` | `openspice_get_log` | bridge |
| `get_raw_info` | `openspice_raw_info` | bridge |
| `read_raw_waveforms` | `openspice_read_raw` | bridge |
| `export_raw_waveforms` | `openspice_export_waveforms` (CSV/ASCII) | bridge |
| `list_changed` | `openspice_designs` (list_changed, cursor) | bridge |
| list/get reference docs | `openspice_reference` (list / get) | bridge |
| add `.meas`, parameterize, `.step` (text) | `openspice_netlist_edit` | bridge |
| explain schematic / netlist | `openspice_read_schematic` + `openspice_parse_netlist` | — |
| **Beyond official** — generate `.asc` with round-trip verification | `openspice_generate_schematic` | — |
| **Beyond official** — in-process `.raw` parsing + LTspice-compatible raw writer | `openspice_read_raw`, `openspice_raw_info` | — |
| **Beyond official** — macOS, Linux, Windows ARM64 (ngspice everywhere) | all tools | — |
| **Beyond official** — LTspice compatibility layer with clear unsupported errors | all run paths | — |

The native LTspice backend (`backend: "ltspice"`) and the bridge
(`delegate: true`) are Windows-x64-only extras, off by default, and never
required. Off Windows x64 the status tool reports both unavailable with a reason.
