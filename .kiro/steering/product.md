---
inclusion: always
---

# Product

## Purpose

OpenSPICE-MCP is an MCP server that lets an AI agent work with SPICE circuits through typed tools: parse and validate SPICE netlists and LTspice schematics, convert a schematic to a netlist, generate a readable LTspice `.asc` from a structured description, run simulations on LTspice or ngspice, and turn the `.raw` results into measurements, waveform summaries, and optional plots. It is the SPICE sibling of `kiro-mcp-server` and follows its conventions.

## Users

For agents (and the engineers behind them) that need circuit analysis without driving a simulator GUI by hand. Not for interactive schematic editing, and not a replacement for LTspice or ngspice themselves.

## Objectives

When a trade-off appears, prefer: safety and confinement over convenience (no shell, paths inside roots, processes tracked and killed); correctness over partial results (a failed run is an error, never fake success); lean output over completeness (summaries and bounded samples over raw dumps); portability over backend breadth (ngspice works everywhere, LTspice where the host supports it).

```mermaid
---
config:
  layout: elk
---
flowchart LR
  agent["AI agent"] --> job["Analyze or build a circuit"]
  job --> simulate["Simulate safely"]
  simulate --> outcome["Measurements, waveforms, schematic"]
```

## In scope

- Parse/validate SPICE netlists (`.cir`, `.net`, `.sp`) and read LTspice `.asc`/`.asy`
- Convert `.asc` to a netlist; generate `.asc` from a circuit description
- Run `op`/`tran`/`ac`/`dc`/`noise` with `.step`/`.meas` on LTspice or ngspice
- Parse `.raw` (binary/ASCII, real/complex, stepped) into summaries, measurements, optional plots

## Out of scope

- In-place editing of existing `.asc` files
- Monte Carlo / worst-case orchestration beyond passing through `.step`
- Arbitrary shell execution or a GUI
