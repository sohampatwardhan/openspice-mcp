# Failure recovery

Every failure returns `{ error: { code, message, details } }`. Read the `code`
first.

| Code | Meaning | What to do |
| --- | --- | --- |
| `PATH_OUTSIDE_ROOTS` | A path resolved outside the configured roots | Use a path inside a root from `openspice_status`; nothing was read, written, or spawned |
| `PATH_EXISTS` | A write target exists and overwrite was not set | Pass `overwrite: true` or choose a new path; the existing file is unchanged |
| `CONTENT_TOO_LARGE` | File or inline text over the limit | Trim the input or point at a path instead of inlining |
| `GENERATE_INVALID` | The circuit description is inconsistent | Fix the named element (unknown symbol, pin on no net, net with < 2 pins); no file was written |
| `GENERATE_UNVERIFIED` | A generated `.asc` did not round-trip | Inspect the listed net/pin diffs; in `strict` mode no file is written, so correct the description and retry |
| `UNSUPPORTED_LTSPICE_FEATURE` | An LTspice-only construct ngspice cannot run | The message names the construct and line; replace it with a supported equivalent (see compatibility.md) |
| `BACKEND_NOT_FOUND` | ngspice is missing, or the selected backend is unavailable | Show the install hint from `openspice_status`; for `backend: "ltspice"` confirm the Windows-x64 extra is enabled |
| `SIM_TIMEOUT` | The run exceeded the timeout | Read the log tail in `details`; simplify the deck or raise `timeout_ms` |
| `SIM_FAILED` | ngspice exited nonzero or hit a convergence/syntax error | Read the parsed errors and log tail; fix the deck. No partial result is returned as success |
| `RAW_PARSE_FAILED` | The `.raw` is truncated or its header is unknown | `details` reports where parsing stopped; re-run the simulation to regenerate it |
| `DESIGN_NOT_FOUND` | An unknown design id | Re-open the design or `list` the open set to get a valid id |
| `BRIDGE_UNAVAILABLE` | The LTspice MCP bridge is disabled/absent/failed | The file-based ngspice path is the fallback; drop `delegate` and run file-based |

Non-fatal diagnostics (not errors): a plot requested while plotting is disabled
still returns the numeric summary; an LTspice-compatible `.raw` that cannot be
produced reliably returns the ngspice-native file plus a note; a `set_content`
parse error leaves the file unchanged; a text-helper target that is absent
changes nothing.
