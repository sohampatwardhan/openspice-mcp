#!/usr/bin/env node
// A stand-in for ngspice, selected via OPENSPICE_NGSPICE_BIN so tests never need
// a real engine. It handles `--version` (prints an ngspice-style banner) and the
// batch form `-b -r <raw> -o <log> <deck>` (writes a tiny valid ngspice .raw and
// a log) so the probe, runner, and smoke tests are deterministic.
//
// Environment knobs for tests:
//   FAKE_NGSPICE_VERSION   version string to report (default 44.2)
//   FAKE_NGSPICE_EXIT      exit code for a batch run (default 0)
//   FAKE_NGSPICE_HANG      if "1", sleep forever on a batch run (timeout tests)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const version = process.env.FAKE_NGSPICE_VERSION ?? "44.2";

if (argv.includes("--version")) {
  process.stdout.write(
    [
      "******",
      `** ngspice-${version} : Circuit level simulation program`,
      "** Compiled with KLU Direct Linear Solver",
      "** The U. C. Berkeley CAD Group",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (process.env.FAKE_NGSPICE_HANG === "1") {
  setInterval(() => {}, 1 << 30);
} else {
  // Parse both batch forms:
  //   -b -r <raw> -o <log> <deck>           (plain rawfile via -r)
  //   -b -o <log> <deck>                     (control-block run; raw via `write`)
  const rawIdx = argv.indexOf("-r");
  const logIdx = argv.indexOf("-o");
  const logPath = logIdx >= 0 ? argv[logIdx + 1] : null;
  // The deck is the last non-flag argument.
  const deckPath = argv[argv.length - 1] ?? null;

  // For the control-block form, read the deck's `write <name>` target and
  // resolve it against the deck's directory (ngspice's cwd for the run).
  let rawPath = rawIdx >= 0 ? argv[rawIdx + 1] : null;
  if (rawPath === null && deckPath && existsSync(deckPath)) {
    const deck = readFileSync(deckPath, "utf8");
    const m = /^\s*write\s+(\S+)/m.exec(deck);
    if (m) rawPath = join(dirname(deckPath), m[1]);
  }

  if (logPath) writeFileSync(logPath, "fake-ngspice batch run\nNo. of Data Rows : 2\n");
  if (rawPath) {
    const header =
      "Title: * fake\n" +
      "Date: Tue Nov  3 00:00:00 2026\n" +
      "Plotname: Transient Analysis\n" +
      "Flags: real\n" +
      "No. Variables: 2\n" +
      "No. Points: 2\n" +
      "Variables:\n" +
      "\t0\ttime\ttime\n" +
      "\t1\tv(out)\tvoltage\n" +
      "Binary:\n";
    const payload = Buffer.alloc(2 * 2 * 8);
    payload.writeDoubleLE(0, 0);
    payload.writeDoubleLE(0, 8);
    payload.writeDoubleLE(1e-9, 16);
    payload.writeDoubleLE(0.5, 24);
    writeFileSync(rawPath, Buffer.concat([Buffer.from(header, "utf8"), payload]));
  }
  process.exit(Number(process.env.FAKE_NGSPICE_EXIT ?? "0"));
}
