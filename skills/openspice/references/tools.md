# openspice-mcp tool cheat sheet

Every tool has a strict input schema (`additionalProperties: false`), an output
schema, and returns structured content. Failures return
`{ error: { code, message, details } }`. All paths must resolve inside the
configured roots.

| Tool | Key inputs | Returns |
| --- | --- | --- |
| `openspice_status` | (none) | ngspice path/version/compat-mode support, roots, plotting flag, optional-extras availability, warnings |
| `openspice_parse_netlist` | `path` or `text`, `validate?` | devices, nets, models, subckts, includes, directives, diagnostics |
| `openspice_read_schematic` | `path` (`.asc`/`.asy`) | components, wires, flags, directives, detected encoding, diagnostics |
| `openspice_schematic_to_netlist` | `path` (`.asc`), `write?`, `out?`, `overwrite?` | netlist text (and node order), connectivity warnings |
| `openspice_generate_schematic` | `circuit` description, `write?`, `out?`, `overwrite?`, `strict?` | `.asc` bytes/path, `verified` + counts, or `GENERATE_UNVERIFIED`/`GENERATE_INVALID` |
| `openspice_designs` | `action` (open/list/active/get_content/set_content/snapshot/restore/list_changed) | design id/path/kind/active, content + encoding, change list |
| `openspice_netlist_edit` | `text`, helper (`add_meas`/`add_step`/`parameterize`) + spec | edited text, or an absent-target diagnostic |
| `openspice_simulate` | `path`/`text`, `kind?`, `variables?`, `max_points?`, `timeout_ms?`, `step_device?`, `design_id?` | status, source, raw/log paths, summary, measurements, translations, warnings |
| `openspice_read_raw` | `path`, `variables?`, `max_points?`, plot/ltspice-raw options | summaries, samples, complex mag/phase, step keying |
| `openspice_raw_info` | `path` | `.raw` metadata only (no sample arrays) |
| `openspice_export_waveforms` | `path`, `variables`, `out`, `format?`, `overwrite?` | written CSV/ASCII path |
| `openspice_get_log` | design/run reference | log text or parsed error/warning lines, or "no log yet" |
| `openspice_reference` | `action` (list/get), `id?` | doc entries tagged by source; doc text |

Error codes: `INVALID_ARGUMENT`, `PATH_OUTSIDE_ROOTS`, `PATH_EXISTS`,
`CONTENT_TOO_LARGE`, `GENERATE_INVALID`, `GENERATE_UNVERIFIED`,
`UNSUPPORTED_LTSPICE_FEATURE`, `BACKEND_NOT_FOUND`, `SIM_TIMEOUT`, `SIM_FAILED`,
`RAW_PARSE_FAILED`, `DESIGN_NOT_FOUND`, `BRIDGE_UNAVAILABLE`, `INTERNAL_ERROR`.
