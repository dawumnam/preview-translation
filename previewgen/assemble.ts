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

/**
 * The human writers put the TC of a shot line a little after the camera cut:
 * 0 to 3 s for most lines (median 1.4 s over nine episodes). With cut + 2 s
 * the TC is within 3 s of the writer's TC for 88% of the shot lines at a cut
 * (76% with the time of the cut itself).
 */
export const CUT_LAG = 2;

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
        const k = cuts.findIndex((c) => Math.abs(c - l.tc!) <= 2.5);
        const tc = k >= 0 ? cuts[k] : l.tc!;
        const last = out[out.length - 1];
        if (last?.kind === "shot" && Math.abs(last.tc! - tc) < 1.5) continue;
        // The order of the lines follows the cut; the document shows a TC a little after it.
        const next = k >= 0 ? (cuts[k + 1] ?? Infinity) : Infinity;
        out.push(k >= 0 ? { ...l, tc, tcDoc: Math.min(tc + CUT_LAG, Math.max(tc, next - 1)) } : { ...l, tc });
      } else out.push({ ...l });
    }
  }
  return out.map((l, i) => ({ l, i })).sort((a, b) => Math.floor(a.l.tc!) - Math.floor(b.l.tc!) || a.i - b.i).map((x) => x.l);
}

/**
 * Adds the shot lines of a picture-only pass to the lines of the usual pass.
 *
 * The usual pass (picture and sound in one call) finds the shot lines at a
 * camera cut, but only half of the human shot lines inside a take. A pass
 * that gets the picture alone finds more of them. On stretches of three
 * episodes the two together have a shot line at 94% of the human shot lines
 * (78% for the usual pass alone), with about 1.4 times the lines of the human.
 *
 * A line of the picture-only pass is added when the usual pass has no shot
 * line within `near` seconds of it. That pass does not hear the talk, so it
 * also writes a line where a new camera file only goes on with the same talk;
 * such a line is left out when the talk of the usual pass runs across the cut.
 */
export function joinShots(base: PreviewLine[], extra: PreviewLine[], cuts: number[], near = 6): PreviewLine[] {
  const baseShots = base.filter((l) => l.kind === "shot").map((l) => l.tc!);
  const talk = base.filter((l) => l.kind !== "shot" && l.use !== "direct").map((l) => l.tc!);
  const added: PreviewLine[] = [];
  for (const l of extra) {
    if (l.kind !== "shot") continue;
    const t = l.tc!;
    if (baseShots.some((b) => Math.abs(b - t) <= near)) continue;
    const last = added[added.length - 1];
    if (last && t - last.tc! <= near) continue;
    const atCut = cuts.some((c) => Math.abs(c - t) <= 2.5);
    if (atCut && talk.some((x) => x >= t - 4 && x < t) && talk.some((x) => x >= t && x <= t + 4)) continue;
    added.push({ ...l });
  }
  return [...base, ...added].map((l, i) => ({ l, i })).sort((a, b) => Math.floor(a.l.tc!) - Math.floor(b.l.tc!) || a.i - b.i).map((x) => x.l);
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
    const sec = Math.floor(l.tcDoc ?? l.tc);
    const show = l.kind === "shot" ? sec !== last : sec - last >= o.tcGap;
    if (show) last = sec;
    return show;
  });
}
