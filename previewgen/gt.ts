// A human-written preview document as a list of lines. This is the reference
// that the generated preview is compared with.
import AdmZip from "adm-zip";
import { parseTimestamp } from "../src/parser";
import { longestNonDecreasing } from "../src/script";

export type Kind = "scene" | "shot" | "speech" | "foreign" | "note";

export interface PreviewLine {
  /** Seconds from the start of the video. Not set when the line has no TC. */
  tc?: number;
  /** Generated shot lines at a camera cut: the TC that the document shows (a little after the cut, as the human writers do). */
  tcDoc?: number;
  kind: Kind;
  speaker?: string;
  /** Korean text, shot description, scene title or note. Empty for a foreign-language turn. */
  text: string;
  /** Language code of a foreign-language turn as the document writes it: 조, 영 ... */
  lang?: string;
  /** Generated lines only: part of the programme, a request of the crew, or talk off the record. */
  use?: "take" | "ask" | "direct";
  /** Generated scene lines only: 1 = a new place, 2 = a new activity at the same place. */
  level?: 1 | 2;
}

export interface GtLine extends PreviewLine {
  no: number;
  /** Last TC at or before this line. */
  tcPrev: number;
  /** First TC after this line that is later than tcPrev. Infinity at the end. */
  tcNext: number;
  scene: string;
  /** True when the writer marked the line for translation (bold). Not used for scoring. */
  raw: string;
}

const HANGUL = /[가-힣]/;

function paragraphText(para: string): string {
  return [...para.matchAll(/<hp:t>(.*?)<\/hp:t>/gs)]
    .map((m) => m[1].replace(/<hp:tab[^/]*\/>/g, "\t").replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Reads the document. The table of contents at the top is left out. */
export function loadGt(hwpxPath: string): GtLine[] {
  const zip = new AdmZip(hwpxPath);
  const entry = zip.getEntry("Contents/section0.xml");
  if (!entry) throw new Error(`Contents/section0.xml not found in ${hwpxPath}`);
  const xml = entry.getData().toString("utf-8");
  const paragraphs = [...xml.matchAll(/<hp:p[^>]*>.*?<\/hp:p>/gs)].map((m) => m[0]);

  const lines: GtLine[] = [];
  let scene = "";
  let separators = 0;
  for (const para of paragraphs) {
    const raw = paragraphText(para);
    const fields = raw.split("\t").map((f) => f.trim());
    const flat = fields.filter(Boolean).join(" ");
    if (!flat) continue;
    if (/^-{5,}$/.test(flat)) {
      separators++;
      continue;
    }
    // Title (date) and table of contents: all that comes before the third rule.
    if (separators < 3) continue;

    const base = { no: lines.length, tcPrev: 0, tcNext: Infinity, raw };
    if (/^#/.test(flat) && !flat.includes("@@")) {
      scene = flat.replace(/^#+\s*/, "").trim();
      lines.push({ ...base, kind: "scene", text: scene, scene });
      continue;
    }

    let tc: number | undefined;
    // "0126<tab>…" and, where the writer typed a space, "12323 코<tab>…".
    const m = fields[0]?.match(/^(\d{3,6})(?:\s+(.*))?$/);
    if (m) {
      tc = parseTimestamp(m[1]);
      if (m[2]) fields[0] = m[2];
      else fields.shift();
    } else if (fields[0] === "") {
      fields.shift();
    }
    const rest = fields.filter(Boolean);
    let speaker: string | undefined;
    let text = rest.join(" ");
    if (rest.length >= 2 && rest[0].length <= 6 && HANGUL.test(rest[0])) {
      speaker = rest[0];
      text = rest.slice(1).join(" ");
    }
    const foreign = text.match(/^@@\s*(?:\(([^)]*)\))?\s*$/);
    if (speaker && foreign) lines.push({ ...base, tc, kind: "foreign", speaker, text: "", lang: foreign[1] ?? "", scene });
    else if (speaker) lines.push({ ...base, tc, kind: "speech", speaker, text, scene });
    else if (tc !== undefined) lines.push({ ...base, tc, kind: "shot", text, scene });
    else lines.push({ ...base, kind: "note", text, scene });
  }

  // A TC that goes back in time is a typo (see src/script.ts). It is not used.
  const withTc = lines.filter((l) => l.tc !== undefined);
  const keep = longestNonDecreasing(withTc.map((l) => l.tc!));
  withTc.forEach((l, i) => {
    if (!keep.has(i)) l.tc = undefined;
  });
  let prev = 0;
  for (const l of lines) {
    if (l.tc !== undefined) prev = l.tc;
    l.tcPrev = prev;
  }
  let next = Infinity;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    l.tcNext = next;
    if (l.tc !== undefined) next = l.tc;
  }
  return lines;
}

/** "0126", "10011": the TC as the preview documents write it. */
export function tcText(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}${mm}${ss}` : `${mm}${ss}`;
}

/** One line as the preview documents write it (tab-separated). */
export function renderLine(l: PreviewLine, showTc = true): string {
  const at = l.tcDoc ?? l.tc;
  const tc = showTc && at !== undefined ? tcText(at) : "";
  if (l.kind === "scene") return l.level === 2 ? `# - ${l.text}` : `# ${l.text}`;
  if (l.kind === "note") return l.text;
  if (l.kind === "shot") return `${tc}\t${l.text}`;
  if (l.kind === "foreign") return `${tc}\t${l.speaker}\t@@(${l.lang || "조"})`;
  return `${tc}\t${l.speaker}\t${l.text}`;
}

if (import.meta.main) {
  const [file, from, to] = process.argv.slice(2);
  const a = from ? parseFloat(from) : 0;
  const b = to ? parseFloat(to) : Infinity;
  const lines = loadGt(file).filter((l) => l.tcPrev >= a && l.tcPrev < b);
  const count: Record<string, number> = {};
  for (const l of lines) count[l.kind] = (count[l.kind] ?? 0) + 1;
  for (const l of lines) console.log(renderLine(l));
  console.error(JSON.stringify(count));
}
