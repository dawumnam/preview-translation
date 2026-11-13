// CLI: compare generated preview lines with the human-written preview.
//
//   bun previewgen/score.ts <gen.json> <reference.hwpx> [--list] [--json <out.json>]
//       [--ranges 820-1120,2850-3150] [--style full] [--direct-foreign drop|locals|keep]
//       [--foreign-gap s] [--direct-min n]
//
// <gen.json> is the output of gen.ts or the windows.json of a run. The style
// options change how the lines are made from it (see assemble.ts); they cost
// no model call.
//
// What it measures, on the stretch of video that the generated file covers:
// - Korean speech: how much of the reference text is in the output (recall)
//   and how much of the output text is in the reference (precision), by a
//   character alignment. This does not depend on how turns are split in lines.
// - Speaker of each Korean line that was found.
// - Foreign-language turns and "디렉" lines: between two Korean lines that both
//   documents have, do they hold the same sequence of turns?
// - Shot lines: is there a generated shot line at each reference shot line,
//   and how alike are the descriptions?
// - Times: how far the generated time is from the TC that the writer typed.
import fs from "fs";
import { loadGt, renderLine, type GtLine, type PreviewLine } from "./gt";
import { applyStyle, HOUSE_STYLE, mergeWindows, tcShown, type StyleOptions } from "./assemble";
import type { GenFile } from "./gen";

const CORE = new Set(["큐", "코", "피", "카감"]);

export function normSpeaker(s: string | undefined): string {
  const t = (s ?? "").replace(/[\s()]/g, "");
  if (t === "카" || t === "카감독") return "카감";
  if (t === "쿠") return "큐";
  if (t === "피디" || t === "PD") return "피";
  return t || "?";
}

const normText = (s: string) => [...s.replace(/[^0-9A-Za-z가-힣]/g, "")];
const isDirection = (l: PreviewLine) => l.kind === "speech" && /^디렉(션)?$/.test(l.text.replace(/[^가-힣]/g, ""));

interface Tok {
  ch: string;
  line: number;
}

/**
 * Edit-distance alignment of two character sequences. Returns, for each
 * position of `a`, the position of `b` it is matched with (same character),
 * or -1. `ok(i, j)` says if the two positions may be matched at all.
 */
function align(a: Tok[], b: Tok[], ok: (i: number, j: number) => boolean): Int32Array {
  const n = a.length;
  const m = b.length;
  const match = new Int32Array(n).fill(-1);
  if (!n || !m) return match;
  const back = new Uint8Array((n + 1) * (m + 1));
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
    back[j] = 2;
  }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    back[i * (m + 1)] = 1;
    const ai = a[i - 1].ch;
    const row = i * (m + 1);
    for (let j = 1; j <= m; j++) {
      // Unlike characters cost as much as leaving both out. With a cheaper
      // substitution, text that only one side has is paired with unrelated
      // text of the other side, and the true match next to it is lost.
      const same = ai === b[j - 1].ch && ok(i - 1, j - 1);
      let best = prev[j - 1] + (same ? 0 : 2);
      let dir = same ? 0 : 3;
      const up = prev[j] + 1;
      if (up < best) {
        best = up;
        dir = 1;
      }
      const left = cur[j - 1] + 1;
      if (left < best) {
        best = left;
        dir = 2;
      }
      cur[j] = best;
      back[row + j] = dir;
    }
    [prev, cur] = [cur, prev];
  }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const d = back[i * (m + 1) + j];
    if (d === 0) {
      match[i - 1] = j - 1;
      i--;
      j--;
    } else if (d === 3) {
      i--;
      j--;
    } else if (d === 1) i--;
    else j--;
  }
  // Single characters match by chance (이, 는, 요 ...). Keep a match only in a
  // run of three, or when it covers a whole short line on one side.
  const lineLen = (t: Tok[]) => {
    const c = new Map<number, number>();
    for (const x of t) c.set(x.line, (c.get(x.line) ?? 0) + 1);
    return c;
  };
  const la = lineLen(a);
  const lb = lineLen(b);
  for (let s = 0; s < n; ) {
    if (match[s] < 0) {
      s++;
      continue;
    }
    let e = s;
    while (e + 1 < n && match[e + 1] === match[e] + 1) e++;
    const run = e - s + 1;
    const whole = run >= la.get(a[s].line)! || run >= lb.get(b[match[s]].line)!;
    if (run < 3 && !whole) for (let k = s; k <= e; k++) match[k] = -1;
    s = e + 1;
  }
  return match;
}

/** Pairs of a monotone matching with the highest total weight. `w` is ≤ 0 for a pair that must not match. */
function matchWeighted<A, B>(a: A[], b: B[], w: (x: A, y: B) => number): [number, number][] {
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const x = w(a[i], b[j]);
      d[i][j] = Math.max(d[i + 1][j], d[i][j + 1], x > 0 ? d[i + 1][j + 1] + x : -1);
    }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const x = w(a[i], b[j]);
    if (x > 0 && d[i][j] === d[i + 1][j + 1] + x) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (d[i + 1][j] >= d[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function lcs<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): [number, number][] {
  const n = a.length;
  const m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) d[i][j] = eq(a[i], b[j]) ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j]) && d[i][j] === d[i + 1][j + 1] + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (d[i + 1][j] >= d[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function bigramDice(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/\s+/g, "");
    const g = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) g.set(t.slice(i, i + 2), (g.get(t.slice(i, i + 2)) ?? 0) + 1);
    return g;
  };
  const x = grams(a);
  const y = grams(b);
  let inter = 0;
  let nx = 0;
  let ny = 0;
  for (const [k, v] of x) {
    nx += v;
    inter += Math.min(v, y.get(k) ?? 0);
  }
  for (const v of y.values()) ny += v;
  return nx + ny ? (2 * inter) / (nx + ny) : a.replace(/\s+/g, "") === b.replace(/\s+/g, "") ? 1 : 0;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "-");

/**
 * A generated shot line is at the place of a human shot line when it stands
 * at most this many seconds before / after it. The writer's TC comes after
 * the start of the shot, so the window is wider to the front.
 */
export const SHOT_WINDOW: [number, number] = [10, 5];

export interface Score {
  range: [number, number][];
  korean: { refChars: number; genChars: number; matched: number; recall: number; precision: number; refLines: number; refFound: number; genLines: number; genSupported: number };
  speaker: { lines: number; same: number; core: number; coreSame: number; local: number; localSame: number; localSameName: number };
  foreign: { ref: number; gen: number; matched: number; matchedSpeaker: number };
  direction: { ref: number; gen: number; matched: number };
  shot: { ref: number; gen: number; matched: number; dice: number; medianOffset: number };
  /** Human shot lines apart: those that stand at a camera cut, and those inside a take. */
  shotAt: { cutRef: number; cutFound: number; insideRef: number; insideFound: number };
  time: { lines: number; medianAbs: number; within3: number; within5: number };
  /** Human lines with a TC (any kind) that have a generated line with a shown TC within 5 s / 10 s. */
  tc: { ref: number; within5: number; within10: number; gen: number; genNearRef5: number };
}

export function score(gen: PreviewLine[], gtAll: GtLine[], ranges: [number, number][], list = false, cuts: number[] = []): Score {
  const inRange = (t: number) => ranges.some(([a, b]) => t >= a && t < b);
  const gt = gtAll.filter((l) => inRange(l.tcPrev));
  // The times that the document shows are compared (see CUT_LAG in assemble.ts).
  const g = gen.filter((l) => inRange(l.tc!)).map((l) => (l.tcDoc !== undefined ? { ...l, tc: l.tcDoc } : l)).sort((a, b) => a.tc! - b.tc!);

  // --- Korean text ---
  const refSpeech = gt.filter((l) => l.kind === "speech" && !isDirection(l) && normText(l.text).length > 0);
  const genSpeech = g.filter((l) => l.kind === "speech" && !isDirection(l) && normText(l.text).length > 0);
  const a: Tok[] = refSpeech.flatMap((l, i) => normText(l.text).map((ch) => ({ ch, line: i })));
  const b: Tok[] = genSpeech.flatMap((l, i) => normText(l.text).map((ch) => ({ ch, line: i })));
  // A reference line may only match output that lies near its place in time.
  const SLACK = 20;
  // A generated line runs from its time to the time of the next line, or
  // longer when it is a long line (about 6 characters a second).
  const genEnd = genSpeech.map((x, k) => Math.max(genSpeech[k + 1]?.tc ?? x.tc! + 5, x.tc! + normText(x.text).length / 6));
  const ok = (i: number, j: number) => {
    const r = refSpeech[a[i].line];
    const k = b[j].line;
    return genEnd[k] >= r.tcPrev - SLACK && genSpeech[k].tc! <= (Number.isFinite(r.tcNext) ? r.tcNext : r.tcPrev + 600) + SLACK;
  };
  const m = align(a, b, ok);
  const refHit = new Array(refSpeech.length).fill(0);
  const refLen = new Array(refSpeech.length).fill(0);
  const genHit = new Array(genSpeech.length).fill(0);
  const genLen = new Array(genSpeech.length).fill(0);
  const votes: Map<number, number>[] = refSpeech.map(() => new Map());
  let matched = 0;
  a.forEach((t, i) => {
    refLen[t.line]++;
    if (m[i] >= 0) {
      matched++;
      refHit[t.line]++;
      const gl = b[m[i]].line;
      genHit[gl]++;
      votes[t.line].set(gl, (votes[t.line].get(gl) ?? 0) + 1);
    }
  });
  b.forEach((t) => genLen[t.line]++);
  const FOUND = 0.6;
  const found = refSpeech.map((_, i) => refHit[i] >= Math.ceil(refLen[i] * FOUND));
  const supported = genSpeech.map((_, i) => genHit[i] >= Math.ceil(genLen[i] * FOUND));
  /** For each found reference line: the generated line that holds most of it. */
  const partner = refSpeech.map((_, i) => (found[i] ? [...votes[i]].sort((x, y) => y[1] - x[1])[0][0] : -1));

  // --- Speakers of found Korean lines; names of locals by scene ---
  const co = new Map<string, Map<string, number>>(); // scene|genLabel → refLabel → count
  const bump = (scene: string, genLabel: string, refLabel: string, n = 1) => {
    const k = `${scene}|${genLabel}`;
    if (!co.has(k)) co.set(k, new Map());
    co.get(k)!.set(refLabel, (co.get(k)!.get(refLabel) ?? 0) + n);
  };
  refSpeech.forEach((r, i) => {
    if (partner[i] < 0) return;
    const gs = normSpeaker(genSpeech[partner[i]].speaker);
    const rs = normSpeaker(r.speaker);
    if (!CORE.has(gs) && !CORE.has(rs)) bump(r.scene, gs, rs);
  });

  // --- Foreign turns and directions, gap by gap between Korean anchors ---
  type Turn = { cls: "F" | "D"; speaker: string; scene: string; tc?: number };
  const refSeq: (Turn | { anchor: number })[] = [];
  {
    let k = 0;
    for (const l of gt) {
      if (l.kind === "foreign") refSeq.push({ cls: "F", speaker: normSpeaker(l.speaker), scene: l.scene, tc: l.tc });
      else if (isDirection(l)) refSeq.push({ cls: "D", speaker: normSpeaker(l.speaker), scene: l.scene, tc: l.tc });
      else if (l.kind === "speech" && normText(l.text).length > 0) {
        if (partner[k] >= 0) refSeq.push({ anchor: partner[k] });
        k++;
      }
    }
  }
  const genSeq: (Turn | { anchor: number })[] = [];
  {
    let k = 0;
    const anchors = new Set(partner.filter((p) => p >= 0));
    for (const l of g) {
      if (l.kind === "foreign") genSeq.push({ cls: "F", speaker: normSpeaker(l.speaker), scene: "", tc: l.tc });
      else if (isDirection(l)) genSeq.push({ cls: "D", speaker: normSpeaker(l.speaker), scene: "", tc: l.tc });
      else if (l.kind === "speech" && normText(l.text).length > 0) {
        if (anchors.has(k)) genSeq.push({ anchor: k });
        k++;
      }
    }
  }
  // Cut both sequences at the anchors that they share, in order.
  const cut = (seq: (Turn | { anchor: number })[], ids: number[]) => {
    const gaps: Turn[][] = [[]];
    let want = 0;
    for (const x of seq) {
      if ("anchor" in x) {
        if (want < ids.length && x.anchor === ids[want]) {
          gaps.push([]);
          want++;
        }
      } else gaps[gaps.length - 1].push(x);
    }
    return gaps;
  };
  const refAnchors = refSeq.filter((x): x is { anchor: number } => "anchor" in x).map((x) => x.anchor);
  // Keep a strictly increasing run of anchors, so that both sides cut at the same places.
  const ids: number[] = [];
  for (const id of refAnchors) if (!ids.length || id > ids[ids.length - 1]) ids.push(id);
  const refGaps = cut(refSeq.filter((x) => !("anchor" in x) || ids.includes(x.anchor)), ids);
  const genGaps = cut(genSeq, ids);
  const type = (t: Turn) => `${t.cls}:${CORE.has(t.speaker) ? t.speaker : "L"}`;
  const pairs: [Turn, Turn][] = [];
  const stat = { F: { ref: 0, gen: 0, matched: 0 }, D: { ref: 0, gen: 0, matched: 0 } };
  for (let k = 0; k < refGaps.length; k++) {
    const rg = refGaps[k];
    const gg = genGaps[k] ?? [];
    for (const t of rg) stat[t.cls].ref++;
    for (const t of gg) stat[t.cls].gen++;
    // Same class is enough for a match here; the speaker is compared after.
    for (const [i, j] of lcs(rg, gg, (x, y) => x.cls === y.cls && (x.cls === "D" || type(x) === type(y) || true))) {
      stat[rg[i].cls].matched++;
      pairs.push([rg[i], gg[j]]);
      if (rg[i].cls === "F" && !CORE.has(rg[i].speaker) && !CORE.has(gg[j].speaker)) bump(rg[i].scene, gg[j].speaker, rg[i].speaker);
    }
  }
  const nameOf = (scene: string, genLabel: string) => {
    const c = co.get(`${scene}|${genLabel}`);
    return c ? [...c].sort((x, y) => y[1] - x[1])[0][0] : genLabel;
  };
  const sameSpeaker = (scene: string, refLabel: string, genLabel: string) =>
    CORE.has(refLabel) || CORE.has(genLabel) ? refLabel === genLabel : nameOf(scene, genLabel) === refLabel;
  let fSpeaker = 0;
  for (const [r, x] of pairs) if (r.cls === "F" && sameSpeaker(r.scene, r.speaker, x.speaker)) fSpeaker++;

  const sp = { lines: 0, same: 0, core: 0, coreSame: 0, local: 0, localSame: 0, localSameName: 0 };
  refSpeech.forEach((r, i) => {
    if (partner[i] < 0) return;
    const gs = normSpeaker(genSpeech[partner[i]].speaker);
    const rs = normSpeaker(r.speaker);
    const same = sameSpeaker(r.scene, rs, gs);
    sp.lines++;
    if (same) sp.same++;
    if (CORE.has(rs)) {
      sp.core++;
      if (same) sp.coreSame++;
    } else {
      sp.local++;
      if (same) sp.localSame++;
      if (rs === gs) sp.localSameName++;
    }
  });

  // --- Times of found Korean lines that carry their own TC ---
  const dts: number[] = [];
  refSpeech.forEach((r, i) => {
    if (partner[i] >= 0 && r.tc !== undefined) dts.push(genSpeech[partner[i]].tc! - r.tc);
  });

  // --- Shot lines ---
  const refShot = gt.filter((l) => l.kind === "shot" && l.tc !== undefined && l.text !== "영상종료");
  const genShot = g.filter((l) => l.kind === "shot");
  // The writer's TC comes up to about 8 s after the cut; the model's time is at the cut.
  const near = (r: PreviewLine, x: PreviewLine) => x.tc! >= r.tc! - SHOT_WINDOW[0] && x.tc! <= r.tc! + SHOT_WINDOW[1];
  // Most pairs first; among equal counts, the pair with the more alike text and the nearer time.
  const shotPairs = matchWeighted(refShot, genShot, (r, x) => (near(r, x) ? 1 + 0.3 * bigramDice(r.text, x.text) - 0.01 * Math.abs(x.tc! - r.tc! + 3) : 0));
  const dice = shotPairs.map(([i, j]) => bigramDice(refShot[i].text, genShot[j].text));
  const offs = shotPairs.map(([i, j]) => genShot[j].tc! - refShot[i].tc!);
  // The writer's TC comes up to 12 s after the cut that starts the shot.
  const shotAt = { cutRef: 0, cutFound: 0, insideRef: 0, insideFound: 0 };
  const foundShot = new Set(shotPairs.map(([i]) => i));
  refShot.forEach((r, i) => {
    const atCut = cuts.some((c) => c >= r.tc! - 12 && c <= r.tc! + 2);
    if (atCut) {
      shotAt.cutRef++;
      if (foundShot.has(i)) shotAt.cutFound++;
    } else {
      shotAt.insideRef++;
      if (foundShot.has(i)) shotAt.insideFound++;
    }
  });

  // --- TC lines of any kind: is there a TC in the output where the writer put one? ---
  const shown = tcShown(g);
  const myTcs = g.filter((_, i) => shown[i]).map((l) => Math.floor(l.tc!));
  const refTcs = gt.filter((l) => l.tc !== undefined && l.kind !== "scene" && l.text !== "영상종료").map((l) => l.tc!);
  const nearAny = (t: number, xs: number[], tol: number) => xs.some((x) => Math.abs(x - t) <= tol);

  if (list) {
    console.log("\n--- reference Korean lines not found in the output ---");
    refSpeech.forEach((r, i) => !found[i] && console.log(`  ${renderLine({ ...r, tc: r.tc ?? r.tcPrev })}   [${refHit[i]}/${refLen[i]}]`));
    console.log("\n--- generated Korean lines with no support in the reference ---");
    genSpeech.forEach((x, i) => !supported[i] && console.log(`  ${renderLine(x)}   [${genHit[i]}/${genLen[i]}]`));
    console.log("\n--- speaker differs (reference → generated) ---");
    refSpeech.forEach((r, i) => {
      if (partner[i] < 0) return;
      const x = genSpeech[partner[i]];
      if (!sameSpeaker(r.scene, normSpeaker(r.speaker), normSpeaker(x.speaker))) console.log(`  ${normSpeaker(r.speaker)} → ${normSpeaker(x.speaker)}: ${renderLine({ ...r, tc: r.tc ?? r.tcPrev }).slice(0, 70)}`);
    });
    console.log("\n--- shot lines: reference | generated ---");
    const gi = new Map(shotPairs.map(([i, j]) => [i, j]));
    const used = new Set(shotPairs.map(([, j]) => j));
    const rows: [number, string][] = [];
    refShot.forEach((r, i) => rows.push([r.tc!, `${renderLine(r)}  |  ${gi.has(i) ? renderLine(genShot[gi.get(i)!]) : "-"}`]));
    genShot.forEach((x, j) => !used.has(j) && rows.push([x.tc!, `${" ".repeat(12)}-  |  ${renderLine(x)}`]));
    for (const [, s] of rows.sort((p, q) => p[0] - q[0])) console.log(`  ${s}`);
    console.log("\n--- names of locals (scene | generated → reference: count) ---");
    for (const [k, c] of co) console.log(`  ${k} → ${[...c].sort((x, y) => y[1] - x[1]).map(([n, v]) => `${n}:${v}`).join(" ")}`);
  }

  return {
    range: ranges,
    korean: {
      refChars: a.length, genChars: b.length, matched,
      recall: matched / Math.max(1, a.length), precision: matched / Math.max(1, b.length),
      refLines: refSpeech.length, refFound: found.filter(Boolean).length,
      genLines: genSpeech.length, genSupported: supported.filter(Boolean).length,
    },
    speaker: sp,
    foreign: { ...stat.F, matchedSpeaker: fSpeaker },
    direction: stat.D,
    shot: { ref: refShot.length, gen: genShot.length, matched: shotPairs.length, dice: dice.length ? dice.reduce((x, y) => x + y, 0) / dice.length : NaN, medianOffset: median(offs) },
    shotAt,
    tc: {
      ref: refTcs.length,
      within5: refTcs.filter((t) => nearAny(t, myTcs, 5)).length,
      within10: refTcs.filter((t) => nearAny(t, myTcs, 10)).length,
      gen: myTcs.length,
      genNearRef5: myTcs.filter((t) => nearAny(t, refTcs, 5)).length,
    },
    time: {
      lines: dts.length,
      medianAbs: median(dts.map(Math.abs)),
      within3: dts.filter((d) => Math.abs(d) <= 3).length / Math.max(1, dts.length),
      within5: dts.filter((d) => Math.abs(d) <= 5).length / Math.max(1, dts.length),
    },
  };
}

/** Scene starts: how many generated scenes start within `tol` seconds of a scene of the reference. */
export function scoreScenes(gen: PreviewLine[], gt: GtLine[], tol = 30): { ref: number; gen: number; matched: number; pairs: [string, string][] } {
  // A scene of the reference starts at the first TC after its "#" line.
  const ref = gt.filter((l) => l.kind === "scene" && Number.isFinite(l.tcNext)).map((l) => ({ t: l.tcNext, title: l.text }));
  const mine = gen.filter((l) => l.kind === "scene").map((l) => ({ t: l.tc ?? 0, title: l.text }));
  const pairs = lcs(ref, mine, (r, x) => Math.abs(r.t - x.t) <= tol);
  return { ref: ref.length, gen: mine.length, matched: pairs.length, pairs: pairs.map(([i, j]) => [ref[i].title, mine[j].title]) };
}

export function formatScore(s: Score): string {
  const k = s.korean;
  const f = s.foreign;
  const d = s.direction;
  const sh = s.shot;
  const sp = s.speaker;
  return [
    `Korean text   recall ${pct(k.recall)} (${k.matched}/${k.refChars} chars)   precision ${pct(k.precision)} (of ${k.genChars} chars)`,
    `Korean lines  found ${k.refFound}/${k.refLines} (${pct(k.refFound / Math.max(1, k.refLines))})   generated ${k.genLines}, of which in the reference ${k.genSupported} (${pct(k.genSupported / Math.max(1, k.genLines))})`,
    `Speaker       same ${sp.same}/${sp.lines} (${pct(sp.same / Math.max(1, sp.lines))})   cast ${sp.coreSame}/${sp.core} (${pct(sp.coreSame / Math.max(1, sp.core))})   locals ${sp.localSame}/${sp.local} (same name ${sp.localSameName})`,
    `Foreign turns reference ${f.ref}, generated ${f.gen}, matched ${f.matched} (recall ${pct(f.matched / Math.max(1, f.ref))}, precision ${pct(f.matched / Math.max(1, f.gen))}), same speaker ${f.matchedSpeaker} (${pct(f.matchedSpeaker / Math.max(1, f.matched))})`,
    `디렉 lines     reference ${d.ref}, generated ${d.gen}, matched ${d.matched}`,
    `Shot lines    reference ${sh.ref}, generated ${sh.gen}, matched ${sh.matched} (recall ${pct(sh.matched / Math.max(1, sh.ref))}, precision ${pct(sh.matched / Math.max(1, sh.gen))}), text likeness ${sh.dice.toFixed(2)}, median offset ${sh.medianOffset.toFixed(1)} s`,
    `  of these    at a camera cut ${s.shotAt.cutFound}/${s.shotAt.cutRef} (${pct(s.shotAt.cutFound / Math.max(1, s.shotAt.cutRef))}), inside a take ${s.shotAt.insideFound}/${s.shotAt.insideRef} (${pct(s.shotAt.insideFound / Math.max(1, s.shotAt.insideRef))})`,
    `Times         ${s.time.lines} Korean lines with a TC: median ${s.time.medianAbs.toFixed(1)} s off, ${pct(s.time.within3)} within 3 s, ${pct(s.time.within5)} within 5 s`,
    `TC lines      the writer's ${s.tc.ref} TCs (any kind of line): a shown TC of the output within 5 s for ${s.tc.within5} (${pct(s.tc.within5 / Math.max(1, s.tc.ref))}), within 10 s for ${s.tc.within10} (${pct(s.tc.within10 / Math.max(1, s.tc.ref))}); the output shows ${s.tc.gen} TCs, ${pct(s.tc.genNearRef5 / Math.max(1, s.tc.gen))} of them within 5 s of a TC of the writer`,
  ].join("\n");
}

if (import.meta.main) {
  const [genPath, gtPath] = process.argv.slice(2);
  if (!genPath || !gtPath) {
    console.error("Usage: bun previewgen/score.ts <gen.json> <reference.hwpx> [--list] [--json <out.json>]");
    process.exit(1);
  }
  const gen = JSON.parse(fs.readFileSync(genPath, "utf-8")) as GenFile;
  // --style full: score every turn as the model wrote it. Default: the house style (see assemble.ts).
  const si = process.argv.indexOf("--style");
  const style: StyleOptions = { ...HOUSE_STYLE, direct: si >= 0 && process.argv[si + 1] === "full" ? "full" : "house" };
  const opt = (name: string) => (process.argv.indexOf(`--${name}`) >= 0 ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
  if (opt("direct-foreign")) style.directForeign = opt("direct-foreign") as StyleOptions["directForeign"];
  if (opt("foreign-gap")) style.foreignGap = parseFloat(opt("foreign-gap")!);
  if (opt("direct-min")) style.directMin = parseFloat(opt("direct-min")!);
  if (opt("shot-window")) [SHOT_WINDOW[0], SHOT_WINDOW[1]] = opt("shot-window")!.split(",").map(parseFloat);
  const lines = applyStyle(mergeWindows(gen.windows, gen.cuts ?? []), style);
  // --ranges 820-1120,2850-3150 : score only these stretches.
  const ri = process.argv.indexOf("--ranges");
  const ranges: [number, number][] =
    ri >= 0
      ? process.argv[ri + 1].split(",").map((r) => r.split("-").map(parseFloat) as [number, number])
      : gen.windows.filter((w) => !w.error).map((w) => [w.start, w.end] as [number, number]);
  const s = score(lines, loadGt(gtPath), ranges, process.argv.includes("--list"), gen.cuts ?? []);
  console.log(formatScore(s));
  const j = process.argv.indexOf("--json");
  if (j >= 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(s, null, 1));
}
