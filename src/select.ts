// Which @@ lines to translate.
//
// The scriptwriter marks the requested lines with a text style: bold, and in
// most scripts also underline and a colour. The rule is given in plain words
// (--select "bold underline color") and is read by code, not by a model: the
// style is exact data in the file, and the selection sets the work and the
// bill, so the same script and the same words must always give the same lines.
//
// What code cannot know is the writer's intent. A line that has only a part of
// the usual style (bold with no underline, underline with no bold) can be a
// slip of the hand. styleReport() lists those lines so that a person decides.
import fs from "fs";
import path from "path";
import { formatTimestamp, parseTimestamp } from "./parser";

export interface CharStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Colour family of the text ("blue"), or null for black, grey and white. */
  color: string | null;
  /** The colour as written in the file ("#0000FF"), or null. */
  hex: string | null;
  highlight: boolean;
}

export interface Rule {
  bold?: true;
  italic?: true;
  underline?: true;
  highlight?: true;
  /** "any" (a colour of any family), a family name, or "#RRGGBB". */
  color?: string;
}

export const DEFAULT_SELECT = "bold";

const COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "pink"];
const FILLER = new Set([
  "a", "all", "an", "and", "are", "in", "is", "line", "lines", "marker", "markers", "of", "style", "text", "that", "the", "with",
]);
const KNOWN = `bold, italic, underline, color (a colour of any family), ${COLORS.join(", ")}, #RRGGBB, highlight`;

/** "#0000FF" → "blue". Black, grey, white and "none" have no colour family. */
export function colorFamily(hex: string | null | undefined): string | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d < 48) return null;
  const h = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  if (h < 15 || h >= 345) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 170) return "green";
  if (h < 260) return "blue";
  if (h < 300) return "purple";
  return "pink";
}

/** The character styles of Contents/header.xml, by id. */
export function readStyles(headerXml: string): Map<string, CharStyle> {
  const styles = new Map<string, CharStyle>();
  for (const [, id, attrs, body] of headerXml.matchAll(/<hh:charPr\s+id="(\d+)"([^>]*)>([\s\S]*?)<\/hh:charPr>/g)) {
    const hex = /textColor="([^"]*)"/.exec(attrs)?.[1] ?? null;
    const shade = /shadeColor="([^"]*)"/.exec(attrs)?.[1]?.toLowerCase() ?? "none";
    const underline = /<hh:underline\b([^>]*)>/.exec(body);
    const color = colorFamily(hex);
    styles.set(id, {
      bold: body.includes("<hh:bold"),
      italic: body.includes("<hh:italic"),
      underline: !!underline && /type="([^"]*)"/.exec(underline[1])?.[1] !== "NONE",
      color,
      hex: color ? hex!.toUpperCase() : null,
      highlight: shade !== "none" && shade !== "#ffffff",
    });
  }
  return styles;
}

/** Plain words → rule. Words that carry no style ("lines with", "and") are ignored. */
export function parseSelect(text: string): Rule {
  const rule: Rule = {};
  let named: string | undefined;
  for (const w of text.toLowerCase().split(/[^a-z0-9#]+/).filter(Boolean)) {
    if (FILLER.has(w)) continue;
    if (w === "bold") rule.bold = true;
    else if (w === "italic" || w === "italics") rule.italic = true;
    else if (w === "underline" || w === "underlined") rule.underline = true;
    else if (w === "highlight" || w === "highlighted" || w === "shade" || w === "shaded") rule.highlight = true;
    else if (w === "color" || w === "colour" || w === "colored" || w === "coloured") rule.color ??= "any";
    else if (COLORS.includes(w) || /^#[0-9a-f]{6}$/.test(w)) {
      const c = w.startsWith("#") ? w.toUpperCase() : w;
      if (named && named !== c) throw new Error(`--select names two colours ("${named}" and "${c}"). Give one colour, or "color" for a colour of any family.`);
      named = c;
    } else throw new Error(`--select: the word "${w}" is not known. Known words: ${KNOWN}.`);
  }
  if (named) rule.color = named;
  if (Object.keys(rule).length === 0) throw new Error(`--select names no style. Known words: ${KNOWN}.`);
  return rule;
}

/** The rule in its fixed spelling: "bold underline color". */
export function ruleText(rule: Rule): string {
  return [
    rule.bold && "bold", rule.italic && "italic", rule.underline && "underline",
    rule.color === "any" ? "color" : rule.color, rule.highlight && "highlight",
  ].filter(Boolean).join(" ");
}

/** A style matches when it has every property the rule names. More properties are allowed. */
export function matches(s: CharStyle, rule: Rule): boolean {
  if (rule.bold && !s.bold) return false;
  if (rule.italic && !s.italic) return false;
  if (rule.underline && !s.underline) return false;
  if (rule.highlight && !s.highlight) return false;
  if (rule.color === "any") return s.color !== null;
  if (rule.color?.startsWith("#")) return s.hex === rule.color;
  if (rule.color) return s.color === rule.color;
  return true;
}

export function selectIds(styles: Map<string, CharStyle>, rule: Rule): Set<string> {
  return new Set([...styles].filter(([, s]) => matches(s, rule)).map(([id]) => id));
}

const words = (s: CharStyle): string[] =>
  [s.bold && "bold", s.italic && "italic", s.underline && "underline", s.color, s.highlight && "highlight"].filter(Boolean) as string[];
const kinds = (s: CharStyle): string[] =>
  [s.bold && "bold", s.italic && "italic", s.underline && "underline", s.color && "color", s.highlight && "highlight"].filter(Boolean) as string[];

/** "bold underline blue", or "plain". */
export function describeStyle(s: CharStyle): string {
  return words(s).join(" ") || "plain";
}

export interface StyleReport {
  /** The rule in its fixed spelling. */
  select: string;
  selected: number;
  other: number;
  /** One row for each style that an @@ line has. */
  rows: { style: string; lines: number; selected: boolean }[];
  /** The most frequent style of the selected lines. */
  usual: string | null;
  /** Lines with only a part of the usual style: a person must decide these. */
  doubtful: { tc: string; text: string; style: string; selected: boolean; why: string }[];
}

const PLAIN: CharStyle = { bold: false, italic: false, underline: false, color: null, hex: null, highlight: false };

/**
 * The style of every @@ line, counted the way parseMarkers() counts markers:
 * one for each <hp:t> with "@@", by the style of its run.
 */
export function styleReport(xml: string, styles: Map<string, CharStyle>, rule: Rule): StyleReport {
  const found: { style: CharStyle; selected: boolean; tc: string; text: string }[] = [];
  let tc = "";
  for (const [para] of xml.matchAll(/<hp:p[^>]*>.*?<\/hp:p>/g)) {
    const runs = [...para.matchAll(/<hp:run\s+charPrIDRef="(\d+)">(.*?)<\/hp:run>/gs)].map(([, id, content]) => ({
      id,
      texts: [...content.matchAll(/<hp:t>(.*?)<\/hp:t>/gs)].map(([, t]) => t.replace(/<hp:tab[^/]*\/>/g, "\t").replace(/<[^>]+>/g, "")),
    }));
    const fields = runs.flatMap((r) => r.texts).join("").split("\t").map((f) => f.trim());
    // A TC opens a line that has more fields after it. (The title line holds only the date.)
    if (fields.length > 1 && /^\d{4,6}$/.test(fields[0])) tc = formatTimestamp(parseTimestamp(fields[0]));
    const text = fields.filter(Boolean).join(" ");
    for (const r of runs) {
      const style = styles.get(r.id) ?? PLAIN;
      for (const t of r.texts) if (t.includes("@@")) found.push({ style, selected: matches(style, rule), tc, text });
    }
  }

  const count = new Map<string, { style: string; lines: number; selected: boolean; sample: CharStyle }>();
  for (const f of found) {
    const key = `${describeStyle(f.style)}|${f.selected}`;
    const row = count.get(key) ?? { style: describeStyle(f.style), lines: 0, selected: f.selected, sample: f.style };
    row.lines++;
    count.set(key, row);
  }
  const rows = [...count.values()].sort((a, b) => Number(b.selected) - Number(a.selected) || b.lines - a.lines);
  const usual = rows.find((r) => r.selected) ?? null;

  const doubtful: StyleReport["doubtful"] = [];
  if (usual) {
    const usualWords = words(usual.sample);
    const usualKinds = kinds(usual.sample);
    for (const f of found) {
      const mine = words(f.style);
      let why = "";
      if (f.selected && describeStyle(f.style) !== usual.style) {
        const lacks = usualWords.filter((w) => !mine.includes(w)).map((w) => `no ${w}`);
        const extra = mine.filter((w) => !usualWords.includes(w)).map((w) => `has ${w}`);
        why = `will be translated, but: ${[...lacks, ...extra].join(", ")}`;
      } else if (!f.selected && kinds(f.style).some((k) => usualKinds.includes(k))) {
        why = `will not be translated, but it has: ${mine.join(", ")}`;
      }
      if (why) doubtful.push({ tc: f.tc, text: f.text.slice(0, 70), style: describeStyle(f.style), selected: f.selected, why });
    }
  }
  const selected = found.filter((f) => f.selected).length;
  return {
    select: ruleText(rule),
    selected,
    other: found.length - selected,
    rows: rows.map(({ style, lines, selected }) => ({ style, lines, selected })),
    usual: usual?.style ?? null,
    doubtful,
  };
}

/** The report as lines of text for the terminal. */
export function formatStyleReport(r: StyleReport, maxDoubtful = 40): string[] {
  const out = [`selection "${r.select}": ${r.selected} of ${r.selected + r.other} @@ lines`];
  for (const row of r.rows) out.push(`  ${row.selected ? "translate" : "leave    "} ${String(row.lines).padStart(5)}  ${row.style}`);
  if (r.selected === 0) {
    out.push("  No @@ line has this style. Give the style of the requested lines with --select.");
  } else if (r.doubtful.length === 0) {
    out.push("  doubtful lines: none");
  } else {
    out.push(`  doubtful lines: ${r.doubtful.length}. They have only a part of the usual style "${r.usual}". Check them in the script:`);
    for (const d of r.doubtful.slice(0, maxDoubtful)) out.push(`    ${d.tc ? `TC ${d.tc}` : "before the first TC"}  ${d.text}  → ${d.why}`);
    if (r.doubtful.length > maxDoubtful) out.push(`    ... and ${r.doubtful.length - maxDoubtful} more (see report.json in the work directory)`);
  }
  return out;
}

/**
 * The rule for a script file: the words given on the command line, else the
 * rule that run.ts saved in episode.json next to the working copy, else bold.
 */
export function selectFor(hwpxPath: string, given?: string): string {
  if (given !== undefined) return given;
  try {
    const ep = JSON.parse(fs.readFileSync(path.join(path.dirname(hwpxPath), "episode.json"), "utf-8"));
    if (typeof ep.select === "string" && path.resolve(ep.hwpx) === path.resolve(hwpxPath)) return ep.select;
  } catch {
    // No episode.json: the file is not a working copy of run.ts.
  }
  return DEFAULT_SELECT;
}

/** Takes `--select <words>` or `--select=<words>` out of an argument list. */
export function takeSelectArg(argv: string[]): string | undefined {
  const at = argv.findIndex((a) => a === "--select" || a.startsWith("--select="));
  if (at < 0) return undefined;
  const inline = argv[at].includes("=");
  const value = inline ? argv[at].slice("--select=".length) : argv[at + 1] ?? "";
  argv.splice(at, inline ? 1 : 2);
  return value;
}
