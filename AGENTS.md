# AGENTS.md

Guide for coding agents working in this repository. `CLAUDE.md` includes this file.

## What this is

`@sohampatwardhan/openspice-mcp` (bin `openspice-mcp`) is an MCP stdio server that lets calling agents work with SPICE circuits through a fixed, strict set of typed tools: open/list designs and get/set their content as files; parse/validate SPICE netlists and LTspice `.asc`/`.asy`; convert a schematic to a netlist; generate a readable LTspice-openable `.asc` from a description and verify it by round-trip; run a simulation with **ngspice**; read the SPICE log, `.raw` metadata, waveforms, and measurements; apply `.meas`/`.step`/parameterize text helpers; list changes; and answer how-to questions from locally available docs. It is the SPICE sibling of `kiro-mcp-server` and follows its layout and conventions. The spec, including every decision, lives in `.kiro/specs/openspice-mcp/`. Steering is in `.kiro/steering/`.

ngspice is the sole required simulation engine, on every platform and in CI. LTspice was the inspiration for the file formats, not a runtime dependency: files OpenSPICE writes must open in LTspice, but circuits are simulated with ngspice in its LTspice compatibility mode (`set ngbehavior=lt`). A native LTspice backend and a proxy to ADI's official LTspice MCP bridge are optional, Windows-x64-only extras, never required.

## Architecture

| Path | Owns |
| --- | --- |
| `src/index.ts` | Config load (exit 2 on `ConfigError`), stdio transport, shutdown on stdin close and signals |
| `src/server.ts` | `createServer` composition root, `SERVER_INSTRUCTIONS`, shutdown |
| `src/core.ts` | The `Core` bundle every tool group receives |
| `src/config.ts` | Environment variables and fixed `LIMITS` |
| `src/errors.ts` | `ErrorCode`, `ToolError`, result helpers |
| `src/paths.ts` | `Roots`: realpath and the root check; `ensureWritable`, `makeRunDir`, `snapshotDir` |
| `src/argv.ts` | The only place an ngspice argv is built; no shell, no free-form flags |
| `src/children.ts` | The only module that spawns and signals processes: detached, tracked, `stopAll` |
| `src/netlist.ts`, `src/asc.ts`, `src/generate.ts`, `src/raw.ts`, `src/rawwrite.ts`, `src/compat.ts`, `src/steps.ts`, `src/plot.ts`, `src/edits.ts`, `src/refdoc.ts` | The dependency-light engine |
| `src/ngspice.ts`, `src/runner.ts`, `src/designs.ts` | ngspice probe, the simulation runner, the open-designs session |
| `src/ltspice.ts`, `src/bridge.ts` | Optional Windows-x64 extras (off by default, never required) |
| `src/tools/*.ts` | One file per tool group. Tools call engine and process modules; engine and process modules never import tools |
| `test/fixtures/fake-ngspice.mjs` | Stand-in ngspice selected via `OPENSPICE_NGSPICE_BIN` so tests never need a real engine |
| `skills/` | Agent skills installed with `npx skills` |

## Setup, build, test

```bash
npm ci
npm run build   # tsc -p tsconfig.json; strict tsc is the static check (no lint script)
npm test        # build, then node --test dist/test/*.test.js
```

## Coding conventions

- TypeScript strict with `noUncheckedIndexedAccess` and `noImplicitOverride`, ESM with `.js` extensions on relative imports.
- Double quotes, semicolons, trailing commas, 2-space indent, numeric separators.
- Runtime dependencies are `@modelcontextprotocol/sdk` and `zod` only. Parsers, codecs, the `.asc` emitter, the `.raw` reader/writer, and the text helpers are written in-repo.
- Check MCP SDK APIs against the installed `.d.ts`, not memory.

## Testing

- Tests never require a real LTspice or the bridge. ngspice is the CI engine; optional-extra paths use fake executables selected through `OPENSPICE_NGSPICE_BIN`, `OPENSPICE_LTSPICE_BIN`, and `OPENSPICE_BRIDGE_BIN`, so CI is deterministic.
- `test/smoke-*.test.ts` drive the built server over stdio with the SDK `Client`; `test/smoke.test.ts` holds the suite-wide checks (exact tool list, schemas, error shapes, shutdown).
- The compatibility corpus under `test/corpus/` pins parse, netlisting, ngspice runs, and measurements against golden expectations within tolerance.

## Safety

- No shell tool, no raw argv, no free-form flag field. The ngspice (and optional extra) command vector is built in one module (`argv.ts`); children are spawned detached, `shell: false`, tracked, and group-killed (`children.ts`).
- Every path goes through `Roots` (`realpath`) before any read, write, or spawn; outputs refuse to overwrite unless asked. Compatibility settings go in a per-run file inside the run directory, never the user's global `.spiceinit`.
- LTspice-only constructs ngspice cannot run identically are translated when safe, else fail with `UNSUPPORTED_LTSPICE_FEATURE` naming the construct and line.
- A new tool needs a spec change (requirement + design), a strict schema, an `outputSchema`, smoke coverage, and any new error code added to the `ErrorCode` union and the README error table.

## Pull requests and commits

- Conventional commits (`feat(scope): ...`), one per task, with the task number, requirement ids, and `Refs #<issue>` in the body. No AI attribution trailers.
- Spec and steering changes are committed to the default branch. Implementation goes through one PR per spec on `feat/<issue>-<slug>`; a human merges it.
- Questions go on the issue, never in a PR body.
