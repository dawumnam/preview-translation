// Usage: bun previewgen/study/tcstudy.ts
// Where do the human writers put a line with a timecode? Statistics on the nine previews (no model call).
import fs from "fs";
import { loadGt, type GtLine } from "../gt";

const ROOT = "exp/previewgen";
const ids = ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];
const CAST = new Set(["큐", "코", "피", "카감", "카"]);

function cutsOf(id: string): number[] {
  const out: number[] = [];
  let cur = 0;
  for (const line of fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8").split("\n")) {
    if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
    else if (line.startsWith("lavfi.scene_score=") && parseFloat(line.slice(18)) >= 0.1 && (!out.length || cur - out[out.length - 1] >= 1)) out.push(cur);
  }
  return out;
}

const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN);
const dist = (xs: number[]) => `n=${xs.length} p10 ${q(xs, 0.1)} p25 ${q(xs, 0.25)} p50 ${q(xs, 0.5)} p75 ${q(xs, 0.75)} p90 ${q(xs, 0.9)} p95 ${q(xs, 0.95)}`;
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
const isDirect = (l: GtLine) => l.kind === "speech" && /^디렉/.test(l.text.trim());

class Tally {
  m = new Map<string, [number, number]>();
  add(key: string, hit: boolean) {
    const v = this.m.get(key) ?? [0, 0];
    v[1]++;
    if (hit) v[0]++;
    this.m.set(key, v);
  }
  print(title: string, order?: string[]) {
    console.log(`\n${title}`);
    const keys = order ?? [...this.m.keys()].sort();
    for (const k of keys) if (this.m.has(k)) console.log(`  ${k.padEnd(34)} with TC ${pct(...this.m.get(k)!)}`);
  }
}

const byKind = new Tally();
const bySpeaker = new Tally();
const byPrev = new Tally();
const byIndex = new Tally();
const byLinesSince = new Tally();
const byCharsSince = new Tally();
const gapPairs: Record<string, number[]> = {};
const repeatGap = { cut: [] as number[], inside: [] as number[] };
const insideGap: number[] = [];
const longGapInside: string[] = [];
let sameTextInside = 0;
let insideTotal = 0;
const gapsAll: number[] = [];

for (const id of ids) {
  const cuts = cutsOf(id);
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`).filter((l) => l.kind !== "scene" && l.kind !== "note");
  let lastTc: number | undefined;
  let lastTcKind = "";
  let linesSince = 0;
  let charsSince = 0;
  let runIndex = 0; // position in the run of speech lines since the last shot line
  let prevShotText = "";
  let prev: GtLine | undefined;
  let sinceLines: GtLine[] = [];
  for (const l of gt) {
    const has = l.tc !== undefined;
    const speechLike = l.kind === "speech" || l.kind === "foreign";
    const kind = l.kind === "shot" ? "shot" : isDirect(l) ? "디렉" : l.kind === "foreign" ? "foreign (@@)" : "Korean speech";
    byKind.add(kind, has);
    if (speechLike) {
      const sp = (l.speaker ?? "").replace(/\s/g, "");
      const who = sp === "큐" ? "큐 (host)" : sp === "코" ? "코 (interpreter)" : sp === "피" ? "피 (director)" : sp.startsWith("카") ? "카감 (camera)" : "local";
      bySpeaker.add(`${kind} / ${who}`, has);
      byPrev.add(`after ${prev ? (prev.kind === "shot" ? "a shot line" : prev.tc !== undefined ? "a speech line with TC" : "a speech line with no TC") : "start"}`, has);
      byIndex.add(`speech line no. ${Math.min(runIndex + 1, 8)}${runIndex + 1 >= 8 ? "+" : ""} after a shot line`, has);
      byLinesSince.add(`${Math.min(linesSince, 10)}${linesSince >= 10 ? "+" : ""} lines since the last TC`, has);
      const cb = charsSince < 20 ? "<20" : charsSince < 50 ? "20-49" : charsSince < 100 ? "50-99" : charsSince < 200 ? "100-199" : "200+";
      byCharsSince.add(`${cb} characters since the last TC`, has);
      runIndex++;
    } else runIndex = 0;

    if (has) {
      if (lastTc !== undefined) {
        const g = l.tc! - lastTc;
        gapsAll.push(g);
        const key = `${lastTcKind} -> ${l.kind === "shot" ? "shot" : "speech"}`;
        (gapPairs[key] ??= []).push(g);
        if (l.kind === "shot") {
          const atCut = cuts.some((c) => c >= l.tc! - 12 && c <= l.tc! + 2);
          const same = l.text.replace(/\s/g, "") === prevShotText.replace(/\s/g, "");
          if (!atCut) {
            insideTotal++;
            insideGap.push(g);
            if (same) sameTextInside++;
          }
          if (same) repeatGap[atCut ? "cut" : "inside"].push(g);
        }
        if (g > 60 && longGapInside.length < 400) {
          const kinds = sinceLines.map((x) => (x.kind === "foreign" ? "@" : isDirect(x) ? "D" : x.kind === "speech" ? (x.speaker === "피" || (x.speaker ?? "").startsWith("카") ? "P" : "K") : "S")).join("");
          longGapInside.push(`${id} ${l.tc} gap ${g}s: ${kinds}`);
        }
      }
      lastTc = l.tc!;
      lastTcKind = l.kind === "shot" ? "shot" : "speech";
      linesSince = 0;
      charsSince = 0;
      sinceLines = [];
    } else {
      linesSince++;
      charsSince += l.text.length;
      sinceLines.push(l);
    }
    if (l.kind === "shot") prevShotText = l.text;
    prev = l;
  }
}

byKind.print("A. Lines with a TC, by kind of line", ["shot", "Korean speech", "foreign (@@)", "디렉"]);
bySpeaker.print("B. Speech lines with a TC, by kind and speaker");
byPrev.print("C. Speech lines with a TC, by the line before");
byIndex.print("D. Speech lines with a TC, by position after a shot line");
byLinesSince.print("E. Speech lines with a TC, by the count of lines since the last TC", ["0 lines since the last TC", "1 lines since the last TC", "2 lines since the last TC", "3 lines since the last TC", "4 lines since the last TC", "5 lines since the last TC", "6 lines since the last TC", "7 lines since the last TC", "8 lines since the last TC", "9 lines since the last TC", "10+ lines since the last TC"]);
byCharsSince.print("F. Speech lines with a TC, by the characters written since the last TC", ["<20 characters since the last TC", "20-49 characters since the last TC", "50-99 characters since the last TC", "100-199 characters since the last TC", "200+ characters since the last TC"]);
console.log("\nG. Seconds between two TC lines that follow each other");
console.log(`  all: ${dist(gapsAll)}`);
for (const [k, v] of Object.entries(gapPairs)) console.log(`  ${k.padEnd(18)} ${dist(v)}`);
const hist = (xs: number[], edges: number[]) => edges.map((e, i) => `${e}-${edges[i + 1] ?? "+"}: ${xs.filter((x) => x >= e && x < (edges[i + 1] ?? Infinity)).length}`).join("  ");
console.log(`  histogram, all gaps: ${hist(gapsAll, [0, 5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 90, 120])}`);
console.log("\nH. Shot lines inside a take (no cut in the 12 s before)");
console.log(`  ${insideTotal} lines; same words as the shot line before: ${pct(sameTextInside, insideTotal)}`);
console.log(`  seconds since the TC before: ${dist(insideGap)}`);
console.log(`  same words as the shot line before, inside a take: ${dist(repeatGap.inside)}; histogram ${hist(repeatGap.inside, [0, 10, 15, 20, 25, 30, 35, 40, 50, 60])}`);
console.log(`  same words as the shot line before, at a cut:      ${dist(repeatGap.cut)}`);
console.log(`\nI. Gaps above 60 s between two TC lines: ${gapsAll.filter((g) => g > 60).length} of ${gapsAll.length}. What stands between (S shot, K Korean, @ foreign, D 디렉, P crew):`);
console.log(longGapInside.slice(0, 40).map((s) => `  ${s.slice(0, 150)}`).join("\n"));
