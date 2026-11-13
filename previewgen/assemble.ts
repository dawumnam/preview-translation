// From the lines of all windows to the lines of the preview document.
//
// The model writes down all that it hears and tags each turn (take / ask /
// direct). The house style of the human writers is applied here, by code, so
// a change of style needs no new model call:
// - a stretch of talk off the record becomes one line "피<tab>디렉";
// - a shot line at the start of a window that began inside a take is dropped;
// - a shot time next to a cut moves to the cut.
import type { PreviewLine } from "./gt";
import type { WindowOut } from "./gen";

export interface StyleOptions {
  /** "house" = talk off the record becomes 디렉 lines. "full" = every turn stays as the model wrote it. */
  direct: "house" | "full";
  /** A speech line shows its TC when it starts at least this many seconds after the last TC shown. */
  tcGap: number;
  /** A foreign-language turn of the same speaker gets a new line only after this many seconds. */
  foreignGap: number;
  /** Foreign-language turns inside talk off the record: "drop" all, keep those of "locals", or "keep" all. */
  directForeign: "drop" | "locals" | "keep";
  /** Talk off the record gets a 디렉 line when the crew says at least this many Hangul characters in it. */
  directMin: number;
}

export const HOUSE_STYLE: StyleOptions = { direct: "house", tcGap: 8, foreignGap: 10, directForeign: "drop", directMin: 30 };

const CREW = new Set(["피", "카감"]);
const CAST = new Set(["큐", "코", "피", "카감"]);
const hangul = (s: string) => s.replace(/[^가-힣]/g, "").length;

/** Lines of all windows in time order, with the shot lines cleaned. */
export function mergeWindows(windows: WindowOut[], cuts: number[]): PreviewLine[] {
  const out: PreviewLine[] = [];
  for (const w of [...windows].sort((a, b) => a.start - b.start)) {
    for (const l of w.lines) {
      if (l.kind === "shot") {
        // The take was already running when the window started.
        if (!w.startsAtCut && l.tc! - w.start < 2.5) continue;
        const cut = cuts.find((c) => Math.abs(c - l.tc!) <= 2.5);
        const tc = cut ?? l.tc!;
        const last = out[out.length - 1];
        if (last?.kind === "shot" && Math.abs(last.tc! - tc) < 1.5) continue;
        out.push({ ...l, tc });
      } else out.push({ ...l });
    }
  }
  return out.map((l, i) => ({ l, i })).sort((a, b) => Math.floor(a.l.tc!) - Math.floor(b.l.tc!) || a.i - b.i).map((x) => x.l);
}

/**
 * Applies the house style to merged lines.
 *
 * Between two turns that stay in the document there is at most one 디렉 line,
 * as in the human previews: it stands where the talk off the record starts.
 * Requests of the crew in several pieces become one line.
 */
export function applyStyle(lines: PreviewLine[], o: StyleOptions = HOUSE_STYLE): PreviewLine[] {
  if (o.direct === "full") return lines.map((l) => ({ ...l }));
  const out: PreviewLine[] = [];
  // The talk off the record since the last turn that stays.
  let words = new Map<string, number>();
  let at = -1; // position in `out` where the 디렉 line goes
  let tc = 0;
  const flush = () => {
    const total = [...words.values()].reduce((a, b) => a + b, 0);
    // "네", "컷" and the like are not a direction worth a line.
    if (at >= 0 && total >= o.directMin) {
      // Who directs: the crew member with the most words.
      const who = [...words].sort((a, b) => b[1] - a[1])[0][0];
      out.splice(at, 0, { tc, kind: "speech", speaker: who, text: "디렉", use: "direct" });
    }
    words = new Map();
    at = -1;
  };
  for (const l of lines) {
    if (l.kind === "shot") {
      out.push({ ...l });
      continue;
    }
    const keepForeign = l.kind === "foreign" && (o.directForeign === "keep" || (o.directForeign === "locals" && !CAST.has(l.speaker!)));
    if (l.use === "direct" && !keepForeign) {
      if (at < 0) {
        at = out.length;
        tc = l.tc!;
      }
      if (l.kind === "speech" && CREW.has(l.speaker!)) words.set(l.speaker!, (words.get(l.speaker!) ?? 0) + hangul(l.text));
      continue;
    }
    // A foreign turn that stays inside talk off the record does not end that talk.
    if (!(l.use === "direct" && keepForeign)) flush();
    const last = out[out.length - 1];
    if (l.use === "ask" && l.kind === "speech" && last?.kind === "speech" && last.use === "ask" && last.speaker === l.speaker && l.tc! - last.tc! <= 20) {
      last.text = `${last.text} ${l.text}`;
      continue;
    }
    out.push({ ...l });
  }
  flush();
  // One person who goes on in a foreign language: a new line about every half
  // minute, as the human writers do (the model starts one at each pause).
  const merged: PreviewLine[] = [];
  for (const l of out) {
    const last = merged[merged.length - 1];
    if (l.kind === "foreign" && last?.kind === "foreign" && last.speaker === l.speaker && l.tc! - last.tc! < o.foreignGap) continue;
    merged.push(l);
  }
  return merged;
}

/** True for each line that shows its TC in the document. */
export function tcShown(lines: PreviewLine[], o: StyleOptions = HOUSE_STYLE): boolean[] {
  let last = -Infinity;
  return lines.map((l) => {
    if (l.tc === undefined || l.kind === "scene" || l.kind === "note") return false;
    const sec = Math.floor(l.tc);
    const show = l.kind === "shot" ? sec !== last : sec - last >= o.tcGap;
    if (show) last = sec;
    return show;
  });
}
