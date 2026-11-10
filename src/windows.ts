// Listening windows: where in the audio to listen for each marker, and which
// script lines to show the model for that stretch.
//
// A marker's speech lies between the TC before it and the TC after it. On
// eight Georgia episodes (949 markers) it was inside [tcPrev-8, tcNext+15] for
// 99.7% of markers, and tcNext-tcPrev had a median of 24 s. So a window is
// tens of seconds, not a 5-minute scene chunk. Markers that sit close together
// share a window, so the model hears the exchange as a whole.
import type { ScriptLine } from "./script";

export interface ListenWindow {
  id: string;
  /** Audio range in seconds from the start of the media. */
  start: number;
  end: number;
  /** The markers to fill in this window. */
  markers: ScriptLine[];
  /** Script lines to show: the markers and the lines around them, in order. */
  excerpt: ScriptLine[];
}

export interface WindowOptions {
  /** Seconds of audio before the marker's TC. */
  pre: number;
  /** Seconds of audio after the next TC. */
  post: number;
  /** A window grows with more markers up to this length in seconds. */
  maxLen: number;
  /** When the script gives no next TC, listen this long after the marker's TC. */
  openEnd: number;
  /** Longest stretch after the marker's TC to listen to when the next TC is far away. */
  maxGap: number;
  /** Length of the media in seconds. */
  mediaDur: number;
  /** Script lines of context to show beyond the window's own lines. */
  contextSec: number;
}

export const DEFAULT_WINDOW: Omit<WindowOptions, "mediaDur"> = {
  pre: 8,
  post: 15,
  maxLen: 100,
  openEnd: 60,
  maxGap: 150,
  contextSec: 25,
};

/** The audio range that must hold this marker's speech. */
export function markerRange(l: ScriptLine, o: WindowOptions): [number, number] {
  const lo = Math.max(0, l.tcPrev - o.pre);
  // The next TC bounds the turn. When the script has no TC for a long stretch,
  // do not listen to all of it: 99% of turns start within 30 s of their TC.
  let next = Math.min(Number.isFinite(l.tcNext) ? l.tcNext : l.tcPrev + o.openEnd, l.tcPrev + o.maxGap);
  // "@@ ~ 0934": the scriptwriter gave the end of the turn.
  const rangeEnd = l.marker?.endTimestamp;
  if (rangeEnd !== undefined && rangeEnd > l.tcPrev && rangeEnd - l.tcPrev < 600) next = Math.max(next, rangeEnd);
  const hi = Math.min(o.mediaDur, next + o.post);
  return [Math.min(lo, Math.max(0, o.mediaDur - 5)), Math.max(hi, Math.min(o.mediaDur, lo + 5))];
}

/**
 * Plans windows for all markers, or for `only` when given. `widen` can stretch
 * a marker's range (the focused listen covers the spans the passes reported).
 */
export function planWindows(
  lines: ScriptLine[],
  o: WindowOptions,
  only?: Set<number>,
  widen?: (markerIndex: number, range: [number, number]) => [number, number],
  idPrefix = "w",
): ListenWindow[] {
  const markerLines = lines.filter((l) => l.kind === "marker" && (!only || only.has(l.marker!.index)));
  const groups: { start: number; end: number; markers: ScriptLine[] }[] = [];
  for (const m of markerLines) {
    let [lo, hi] = markerRange(m, o);
    if (widen) {
      [lo, hi] = widen(m.marker!.index, [lo, hi]);
      lo = Math.max(0, lo);
      hi = Math.min(o.mediaDur, hi);
    }
    const g = groups[groups.length - 1];
    // Join the open group when the audio ranges touch and the group stays short.
    if (g && lo <= g.end && Math.max(g.end, hi) - Math.min(g.start, lo) <= o.maxLen) {
      g.start = Math.min(g.start, lo);
      g.end = Math.max(g.end, hi);
      g.markers.push(m);
    } else {
      groups.push({ start: lo, end: hi, markers: [m] });
    }
  }

  return groups.map((g, i) => {
    const first = g.markers[0].no;
    const last = g.markers[g.markers.length - 1].no;
    // Show the script from a little before the window to a little after it.
    let a = first;
    while (a > 0 && lines[a - 1].tcPrev >= g.start - o.contextSec && first - a < 25) a--;
    let b = last;
    while (b < lines.length - 1 && lines[b + 1].tcPrev <= g.end + o.contextSec && b - last < 25) b++;
    return {
      id: `${idPrefix}${String(i + 1).padStart(3, "0")}`,
      start: Math.floor(g.start),
      end: Math.ceil(g.end),
      markers: g.markers,
      excerpt: lines.slice(a, b + 1),
    };
  });
}
