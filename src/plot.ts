/**
 * Minimal SVG waveform plotter (Requirement 7.7). Plotting is off by default and
 * only renders a file when it is explicitly enabled (`OPENSPICE_ALLOW_PLOTS`).
 * A disabled request is not an error: `renderPlot` returns `written: false` with
 * a diagnostic, and the caller still returns the numeric summary. The SVG is
 * written in-repo (no image dependency) as a simple line chart of the selected
 * variables against the first (axis) variable.
 *
 * Complex (`.ac`) data is plotted as magnitude; the caller is expected to pair
 * this with the numeric summary that carries magnitude and phase. Only the
 * requested variables that exist in the rawfile are plotted; an unknown name is
 * reported as a diagnostic rather than silently dropped.
 */

import { writeFileSync } from "node:fs";

import type { RawFile } from "./raw.js";

export interface PlotOptions {
  /** Whether plotting is enabled for this server (from config). */
  allowPlots: boolean;
  /** SVG pixel size; defaults to a 640x360 chart. */
  width?: number;
  height?: number;
}

export interface PlotResult {
  /** True when an SVG file was written. */
  written: boolean;
  /** The written path, or null when nothing was written. */
  path: string | null;
  /** Set when plotting was disabled or could not render; non-fatal. */
  diagnostic: string | null;
}

/** Escape text for inclusion in SVG markup. */
function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** A fixed palette so colours are deterministic across runs. */
const PALETTE = ["#1d4ed8", "#b45309", "#047857", "#b91c1c", "#6d28d9", "#0e7490"];

/**
 * Render selected variables to an SVG line chart (Requirement 7.7). Returns a
 * diagnostic without writing when plotting is disabled, when no variables are
 * requestable, or when a requested variable is not present.
 */
export function renderPlot(raw: RawFile, vars: string[], path: string, options: PlotOptions): PlotResult {
  if (!options.allowPlots) {
    return { written: false, path: null, diagnostic: "plotting is disabled (set OPENSPICE_ALLOW_PLOTS=1 to enable); the numeric summary is returned instead" };
  }

  const axisVar = raw.variables[0];
  if (axisVar === undefined || raw.pointCount === 0) {
    return { written: false, path: null, diagnostic: "the rawfile has no axis variable or no points to plot" };
  }

  const names = (vars.length > 0 ? vars : raw.variables.slice(1).map((v) => v.name)).filter((n) => n.toLowerCase() !== axisVar.name.toLowerCase());
  const missing = names.filter((n) => !raw.variables.some((v) => v.name.toLowerCase() === n.toLowerCase()));
  if (missing.length > 0) {
    return { written: false, path: null, diagnostic: `cannot plot unknown variable(s): ${missing.join(", ")}` };
  }
  if (names.length === 0) {
    return { written: false, path: null, diagnostic: "no plottable variables were selected" };
  }

  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const pad = { left: 64, right: 24, top: 24, bottom: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const axis = raw.values(axisVar.name);
  const series = names.map((name) => ({ name, data: raw.values(name) }));

  const xMin = Math.min(...axis);
  const xMax = Math.max(...axis);
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const s of series) {
    for (const v of s.data) {
      if (Number.isFinite(v)) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { written: false, path: null, diagnostic: "selected variables have no finite samples to plot" };
  }
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const xSpan = xMax - xMin || 1;
  const ySpan = yMax - yMin || 1;

  const sx = (x: number): number => pad.left + ((x - xMin) / xSpan) * plotW;
  const sy = (y: number): number => pad.top + plotH - ((y - yMin) / ySpan) * plotH;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  // Axes.
  parts.push(`<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#111827" stroke-width="1"/>`);
  parts.push(`<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#111827" stroke-width="1"/>`);
  // Axis labels.
  parts.push(`<text x="${pad.left}" y="${height - 16}" font-family="sans-serif" font-size="11" fill="#374151">${escapeXml(axisVar.name)}: ${fmt(xMin)} .. ${fmt(xMax)}</text>`);
  parts.push(`<text x="4" y="${pad.top + 10}" font-family="sans-serif" font-size="11" fill="#374151">${fmt(yMax)}</text>`);
  parts.push(`<text x="4" y="${pad.top + plotH}" font-family="sans-serif" font-size="11" fill="#374151">${fmt(yMin)}</text>`);

  series.forEach((s, i) => {
    const colour = PALETTE[i % PALETTE.length];
    const pointsStr = s.data.map((v, p) => `${sx(axis[p] ?? 0).toFixed(2)},${sy(v).toFixed(2)}`).join(" ");
    parts.push(`<polyline fill="none" stroke="${colour}" stroke-width="1.5" points="${pointsStr}"/>`);
    parts.push(`<text x="${pad.left + 8 + i * 120}" y="${pad.top + 14}" font-family="sans-serif" font-size="11" fill="${colour}">${escapeXml(s.name)}</text>`);
  });

  parts.push("</svg>");
  writeFileSync(path, parts.join("\n"), "utf8");
  return { written: true, path, diagnostic: null };
}

/** Compact number formatting for axis labels. */
function fmt(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e4 || abs < 1e-3) return n.toExponential(2);
  return Number(n.toPrecision(4)).toString();
}
