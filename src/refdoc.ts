/**
 * Reference indexer (Requirement 13). Answers how-to questions from docs that
 * are available locally, without bundling any copyrighted help. Three sources,
 * each tagged on every entry:
 *
 *   - `openspice`: OpenSPICE's own documentation, written here and returned
 *     verbatim. These are our words and carry no Analog Devices / LTspice help
 *     content (Requirement 13.4).
 *   - `ngspice`: pointers to the ngspice manual as URLs. OpenSPICE does not
 *     fetch or redistribute the manual; `get` returns the URL, not its text.
 *   - `ltspice-help`: the user's locally installed `LTspiceHelp` folder, read
 *     only when it is present and inside an allowed location. The content comes
 *     from the user's own files, never a copy shipped with OpenSPICE
 *     (Requirement 13.2, 13.3).
 *
 * The tool layer passes the `LTspiceHelp` directory already confined to the
 * roots (or null); this module reads only inside it.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

import { ToolError } from "./errors.js";

/** Where a reference entry comes from. */
export type RefSource = "openspice" | "ngspice" | "ltspice-help";

/** A listed reference entry. */
export interface RefEntry {
  /** Stable id used to fetch the entry. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** One-line description of what the entry covers. */
  summary: string;
  /** The source the entry comes from. */
  source: RefSource;
  /** For a local LTspice-help entry, the absolute file path; otherwise null. */
  path: string | null;
  /** For an ngspice pointer, the manual URL; otherwise null. */
  url: string | null;
}

/** A fetched reference entry. Either `text` (owned/local doc) or `url` (pointer) is set. */
export interface RefDoc {
  id: string;
  title: string;
  source: RefSource;
  /** Doc text for an OpenSPICE-owned or local LTspice-help entry; null for a pointer. */
  text: string | null;
  /** The manual URL for an ngspice pointer; null otherwise. */
  url: string | null;
}

/** An OpenSPICE-owned document, written here (no external content). */
interface OwnedDoc {
  id: string;
  title: string;
  summary: string;
  text: string;
}

/** An ngspice manual pointer (URL only; never fetched or redistributed). */
interface NgspicePointer {
  id: string;
  title: string;
  summary: string;
  url: string;
}

/**
 * OpenSPICE's own docs, returned verbatim by `get`. Deliberately generic and
 * engine-neutral; they describe OpenSPICE's behaviour and point at ngspice, and
 * contain no Analog Devices / LTspice help text.
 */
const OWNED_DOCS: readonly OwnedDoc[] = [
  {
    id: "openspice-overview",
    title: "OpenSPICE overview",
    summary: "What OpenSPICE does and how its tools fit together.",
    text: [
      "OpenSPICE works with SPICE circuits through typed, file-based tools.",
      "ngspice is the one required simulation engine, on every platform. Files",
      "OpenSPICE writes are meant to open in LTspice, but circuits are simulated",
      "with ngspice in its LTspice compatibility mode (set ngbehavior=lt).",
      "",
      "A typical flow: call openspice_status first to confirm ngspice is present,",
      "open or parse a design, optionally generate a schematic (verified by",
      "round-trip), simulate, then read the log and the .raw result.",
    ].join("\n"),
  },
  {
    id: "openspice-simulate",
    title: "Running a simulation",
    summary: "How openspice_simulate runs ngspice and what it returns.",
    text: [
      "openspice_simulate accepts a SPICE netlist (a path inside the roots or",
      "inline text) or an LTspice .asc, which is converted to a netlist first.",
      "The analysis comes from the deck's .tran/.ac/.dc/.op/.noise directive.",
      "",
      "Compatibility settings (set ngbehavior=lt) are written into a per-run",
      "config inside the run directory, never your global .spiceinit. A .step",
      "sweep is emulated with a control loop and assembled into a stepped result.",
      "A failed or timed-out run returns SIM_FAILED or SIM_TIMEOUT with a log",
      "tail; an LTspice-only construct ngspice cannot run returns",
      "UNSUPPORTED_LTSPICE_FEATURE naming the construct and line.",
    ].join("\n"),
  },
  {
    id: "openspice-netlist-edit",
    title: "Editing netlist text",
    summary: "Adding .meas, .step, and parameterizing values as text edits.",
    text: [
      "openspice_netlist_edit applies text helpers to a netlist without running a",
      "simulation. add_meas inserts or updates a .meas directive, add_step defines",
      "a .param plus a .step sweep, and parameterize replaces a device value with",
      "a {name} reference and adds a .param with the original value as default.",
      "A helper that targets a device or directive that is not present returns a",
      "diagnostic and leaves the text unchanged.",
    ].join("\n"),
  },
];

/** Pointers to the ngspice manual. URLs only; OpenSPICE does not ship the manual. */
const NGSPICE_POINTERS: readonly NgspicePointer[] = [
  {
    id: "ngspice-manual",
    title: "ngspice user manual",
    summary: "The official ngspice manual (analyses, devices, control language).",
    url: "https://ngspice.sourceforge.io/docs.html",
  },
  {
    id: "ngspice-manual-pdf",
    title: "ngspice user manual (PDF)",
    summary: "The ngspice manual as a downloadable PDF.",
    url: "https://ngspice.sourceforge.io/docs/ngspice-manual.pdf",
  },
];

/** File extensions treated as readable LTspice-help documents. */
const HELP_EXTENSIONS = new Set([".html", ".htm", ".txt"]);

export interface ReferenceOptions {
  /** The user's LTspiceHelp directory, already confined to the roots, or null. */
  helpDir: string | null;
}

/** Indexes local docs, OpenSPICE docs, and ngspice pointers (Requirement 13). */
export class ReferenceIndex {
  constructor(private readonly opts: ReferenceOptions) {}

  /** List every indexable entry, each tagged with its source (Requirement 13.1). */
  async list(): Promise<RefEntry[]> {
    const entries: RefEntry[] = [];
    for (const doc of OWNED_DOCS) {
      entries.push({ id: doc.id, title: doc.title, summary: doc.summary, source: "openspice", path: null, url: null });
    }
    for (const ptr of NGSPICE_POINTERS) {
      entries.push({ id: ptr.id, title: ptr.title, summary: ptr.summary, source: "ngspice", path: null, url: ptr.url });
    }
    for (const help of await this.listHelp()) {
      entries.push(help);
    }
    return entries;
  }

  /** Fetch one entry by id (Requirement 13.2). */
  async get(id: string): Promise<RefDoc> {
    const owned = OWNED_DOCS.find((d) => d.id === id);
    if (owned !== undefined) return { id: owned.id, title: owned.title, source: "openspice", text: owned.text, url: null };

    const ptr = NGSPICE_POINTERS.find((p) => p.id === id);
    if (ptr !== undefined) return { id: ptr.id, title: ptr.title, source: "ngspice", text: null, url: ptr.url };

    const help = (await this.listHelp()).find((h) => h.id === id);
    if (help !== undefined && help.path !== null) {
      const raw = await readFile(help.path, "utf8");
      return { id: help.id, title: help.title, source: "ltspice-help", text: toPlainText(raw), url: null };
    }

    throw new ToolError("INVALID_ARGUMENT", `unknown reference id ${JSON.stringify(id)}`, { id });
  }

  /**
   * List readable documents inside the user's LTspiceHelp folder (Requirement
   * 13.1, 13.3). Returns an empty list when no folder is configured. Reads only
   * inside the configured directory.
   */
  private async listHelp(): Promise<RefEntry[]> {
    const dir = this.opts.helpDir;
    if (dir === null) return [];
    const files = await walk(dir);
    files.sort();
    return files.map((file) => {
      const rel = relative(dir, file).split(/[\\/]/).join("/");
      return {
        id: `ltspice-help:${rel}`,
        title: basename(file),
        summary: `Local LTspice help document (${rel}), read from your installed LTspiceHelp folder.`,
        source: "ltspice-help" as const,
        path: file,
        url: null,
      };
    });
  }
}

/** Recursively collect readable help files under `dir`. Missing/unreadable dirs yield nothing. */
async function walk(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const dirent of dirents) {
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (dirent.isFile() && HELP_EXTENSIONS.has(extname(dirent.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

/** Reduce an HTML/text document to readable plain text (tags stripped, entities unescaped). */
function toPlainText(raw: string): string {
  const withoutScripts = raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  const unescaped = withoutTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return unescaped.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
