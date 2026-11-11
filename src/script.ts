// The script as an ordered timeline of lines.
//
// parseMarkers() (parser.ts) stays the authority on which runs are markers and
// on each marker's index, speaker and TC, because replace.ts and verify.ts
// count markers the same way. This module adds what the listening steps need:
// every line of the script in document order, with its TC when it has one,
// and each marker placed on its line. A marker's speech lies between the TC
// lines around it (96% within 3 s on eight Georgia episodes), so the timeline
// says where to listen.
import { parseMarkers, parseTimestamp, type Marker } from "./parser";

export interface ScriptLine {
  /** Position in the timeline (document order). */
  no: number;
  /** Seconds, when this line carries its own TC and that TC is in sequence. */
  tc?: number;
  /** A TC that is out of sequence (a typo such as 140623 for 13623). Not used as a bound. */
  tcSuspect?: number;
  /** Last in-sequence TC at or before this line, in seconds. */
  tcPrev: number;
  /** First later in-sequence TC that is greater than tcPrev. Infinity at the end. */
  tcNext: number;
  speaker?: string;
  text: string;
  kind: "scene" | "dialogue" | "shot" | "marker" | "unrequested";
  /** Set when kind is "marker". */
  marker?: Marker;
  scene: string;
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

/** Indices of a longest non-decreasing subsequence of xs. */
function longestNonDecreasing(xs: number[]): Set<number> {
  const tails: number[] = []; // tails[k] = index of the smallest tail of a run of length k+1
  const prev: number[] = new Array(xs.length).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[tails[mid]] <= xs[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

export function parseScript(xml: string, selectedIds: Set<string>): { lines: ScriptLine[]; markers: Marker[] } {
  const { markers } = parseMarkers(xml, selectedIds);
  const paragraphs = [...xml.matchAll(/<hp:p[^>]*>.*?<\/hp:p>/g)].map((m) => m[0]);

  const lines: ScriptLine[] = [];
  let scene = "";
  let nextMarker = 0;

  for (const para of paragraphs) {
    // Count this paragraph's markers the way parseMarkers does: one for each
    // <hp:t> with "@@" inside a run in a requested style.
    let wanted = 0;
    let plain = 0;
    for (const [, id, content] of para.matchAll(/<hp:run\s+charPrIDRef="(\d+)">(.*?)<\/hp:run>/gs)) {
      for (const [, t] of content.matchAll(/<hp:t>(.*?)<\/hp:t>/gs)) {
        if (!t.replace(/<[^>]+>/g, "").includes("@@")) continue;
        if (selectedIds.has(id)) wanted++;
        else plain++;
      }
    }

    const raw = paragraphText(para);
    const fields = raw.split("\t").map((f) => f.trim());
    const flat = fields.filter(Boolean).join(" ");
    if (!flat && wanted === 0) continue;
    if (/^-+$/.test(flat)) continue;

    if (/^#(?!#)\s*\S/.test(flat) && wanted === 0 && plain === 0) {
      scene = flat.replace(/^#\s*/, "").trim();
      lines.push({ no: lines.length, tcPrev: 0, tcNext: Infinity, text: scene, kind: "scene", scene });
      continue;
    }

    let tc: number | undefined;
    const tcMatch = fields[0]?.match(/^(\d{4,6})$/);
    if (tcMatch) {
      tc = parseTimestamp(tcMatch[1]);
      fields.shift();
    } else if (fields[0] === "") {
      fields.shift();
    }

    let speaker: string | undefined;
    let text = fields.filter(Boolean).join(" ");
    if (fields.length >= 2 && fields[0] && fields[0].length <= 10 && HANGUL.test(fields[0])) {
      speaker = fields[0];
      text = fields.slice(1).filter(Boolean).join(" ");
    }

    const base = { tc, tcPrev: 0, tcNext: Infinity, scene };
    if (wanted > 0) {
      // One line for each marker on the paragraph (nearly always one).
      for (let k = 0; k < wanted; k++) {
        const marker = markers[nextMarker++];
        if (!marker) break;
        lines.push({
          ...base,
          no: lines.length,
          tc: k === 0 ? tc : undefined,
          speaker: marker.charName || speaker,
          text: marker.hint ?? "",
          kind: "marker",
          marker,
        });
      }
    } else if (plain > 0) {
      lines.push({ ...base, no: lines.length, speaker, text: text.replace(/@@(\([^)]*\))?/, "").trim(), kind: "unrequested" });
    } else {
      lines.push({ ...base, no: lines.length, speaker, text, kind: speaker ? "dialogue" : "shot" });
    }
  }

  // The footage runs forward, so the TCs must not go back. A TC outside the
  // longest non-decreasing run is a typo (1028: 140623 for 13623; 1024: 3224
  // for 32624) or the date in the title line. It stays in the document, but it
  // is not a bound: the line takes its place from the TCs around it.
  const withTc = lines.filter((l) => l.tc !== undefined);
  const keep = longestNonDecreasing(withTc.map((l) => l.tc!));
  withTc.forEach((l, i) => {
    if (!keep.has(i)) {
      l.tcSuspect = l.tc;
      l.tc = undefined;
    }
  });

  let tcPrev = 0;
  for (const l of lines) {
    if (l.tc !== undefined) tcPrev = l.tc;
    l.tcPrev = tcPrev;
  }
  let later: number[] = []; // in-sequence TCs after the current line, nearest last
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    while (later.length && later[later.length - 1] <= l.tcPrev) later.pop();
    l.tcNext = later.length ? later[later.length - 1] : Infinity;
    if (l.tc !== undefined && (!later.length || l.tc < later[later.length - 1])) later.push(l.tc);
  }
  return { lines, markers };
}

/** "H:MM:SS" or "M:SS" for prompts and logs. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
