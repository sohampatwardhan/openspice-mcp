# `.raw` reader fixtures

Fixtures for `src/raw.ts`. The three ngspice files were produced by **real
ngspice 44.2** on Linux; the LTspice-style file is hand-crafted to the widely
documented LTspice binary conventions, with the uncertain details called out.

## ngspice fixtures (real engine output)

| File | Analysis | Flags | Format | Points | Vars |
| --- | --- | --- | --- | --- | --- |
| `test_tran_bin.raw` | `.tran` | `real` | Berkeley binary | 67 | time, V(in), V(out), I(V1) |
| `test_tran_ascii.raw` | `.tran` (control block, `set filetype=ascii`) | `real` | Berkeley ASCII | 67 | same |
| `test_ac_bin.raw` | `.ac` | `complex` | Berkeley binary | 3 | frequency, V(in), V(out), I(V1) |

ngspice Berkeley layout, confirmed against these files (certainty: high):

- ASCII header lines `Title:`, `Date:`, `Command:`, `Plotname:`, `Flags:`,
  `No. Variables:`, `No. Points:`, a `Variables:` block (`\t<index>\t<name>\t<type>[\tgrid=...]`),
  then a terminator line `Binary:` or `Values:`.
- Binary `real`: every value is little-endian IEEE-754 **float64**, stored
  row-major (all variables of point 0, then point 1, ...). The time axis is also
  float64 — ngspice does not narrow it the way LTspice does.
- Binary `complex` (`.ac`): every value is a pair of float64 (real, imag).
- ASCII `Values:`: each point starts `<point-index>\t<value0>`, the remaining
  variables are tab-indented on their own lines, points separated by a blank
  line; complex values are written `real,imag`.
- **Uncertain**: a host built for single precision would write float32 payloads.
  The reader detects precision from the payload size against the header's point
  and variable counts rather than assuming float64.

## LTspice-style fixture (hand-crafted)

`test_ltspice_bin.raw` is **not** produced by LTspice (LTspice is not available
in CI and is not a dependency). It is hand-crafted to the conventions documented
for the LTspice binary rawfile so the reader's LTspice path has a test:

- **UTF-16LE** header with a BOM and CRLF line endings.
- `Flags: real forward`.
- 3 variables: `time` (`time`), `V(out)` (`voltage`), `I(R1)` (`device_current`),
  4 points.
- Payload per point: the **time axis as float64**, then each remaining trace as
  **float32** — the mixed-width layout LTspice uses for a real transient.

**Uncertain** (tagged per the design's fidelity notes, pinned here rather than
guessed, to be confirmed against a real LTspice file / the compatibility corpus):

- Exact field widths per analysis kind (`double`, `stepped`, and `.ac`/`complex`
  runs differ from the real-transient layout modelled here).
- Whether a given LTspice build writes UTF-16LE vs UTF-8 for `.raw` headers.
- The precise set and spelling of `Flags:` tokens and variable `type` names.

The reader keys its LTspice vs ngspice decision on the UTF-16LE BOM / header
encoding and the trace-width layout, and reports the detected format back so a
caller can see which path was taken.
