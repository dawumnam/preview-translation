// Usage: bun previewgen/study/tchazard.ts
// When does a human writer put a TC on a speech line? The human lines with no TC get a time from the
// matching line of the model output (episodes 1022 and 1023, where a full output exists).
import fs from "fs";
import { applyStyle, HOUSE_STYLE, joinShots, mergeWindows } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt, type GtLine } from "../gt";
import { score } from "../score";

const ROOT = "exp/previewgen";
const runs: [string, string, string?][] = [
  ["1022", `${ROOT}/out/1022_preview_work/windows.json`, `${ROOT}/out/1022_preview_work/shots.json`],
  ["1023", `${ROOT}/p2/1023_full_v3.json`],
];
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
const bins = [0, 3, 6, 9, 12, 15, 20, 25, 30, 40, 60, Infinity];
const label = (g: number) => {
  const k = bins.findIndex((b, i) => g >= b && g < bins[i + 1]);
  return `${bins[k]}-${bins[k + 1] === Infinity ? "" : bins[k + 1]} s`;
};
const byGap = new Map<string, [number, number]>();
const byGapKind: Record<string, Map<string, [number, number]>> = {};
const byPause = new Map<string, [number, number]>();
let known = 0;
let unknown = 0;

for (const [id, winPath, shotPath] of runs) {
  const gen = JSON.parse(fs.readFileSync(winPath, "utf-8")) as GenFile;
  let merged = mergeWindows(gen.windows, gen.cuts);
  if (shotPath) merged = joinShots(merged, mergeWindows((JSON.parse(fs.readFileSync(shotPath, "utf-8")) as GenFile).windows, gen.cuts), gen.cuts);
  // Every turn as the model wrote it: more human lines find their time.
  const lines = applyStyle(merged, { ...HOUSE_STYLE, direct: "full" });
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  const dur = Math.max(...gen.windows.map((w) => w.end));
  const s = score(lines, gt, [[0, dur + 1]], false, gen.cuts);
  const timeOf = new Map(s.lineTimes);
  let lastTc: number | undefined;
  let lastTime: number | undefined; // time of the line before (TC or matched time)
  for (const l of gt as GtLine[]) {
    if (l.kind === "scene" || l.kind === "note") continue;
    const t = l.tc ?? timeOf.get(l.no);
    if (l.kind !== "shot") {
      if (t === undefined || lastTc === undefined) unknown++;
      else {
        known++;
        const g = Math.max(0, t - lastTc);
        const key = label(g);
        const v = byGap.get(key) ?? [0, 0];
        v[1]++;
        if (l.tc !== undefined) v[0]++;
        byGap.set(key, v);
        const kind = l.kind === "foreign" ? "foreign (@@)" : /^디렉/.test(l.text.trim()) ? "디렉" : `Korean, ${l.speaker === "큐" ? "host" : "others"}`;
        const m = (byGapKind[kind] ??= new Map());
        const w = m.get(key) ?? [0, 0];
        w[1]++;
        if (l.tc !== undefined) w[0]++;
        m.set(key, w);
        if (lastTime !== undefined) {
          const p = Math.max(0, t - lastTime);
          const pk = p < 2 ? "under 2 s after the line before" : p < 5 ? "2-5 s" : p < 10 ? "5-10 s" : "10 s or more";
          const pv = byPause.get(pk) ?? [0, 0];
          pv[1]++;
          if (l.tc !== undefined) pv[0]++;
          byPause.set(pk, pv);
        }
      }
    }
    if (l.tc !== undefined) lastTc = l.tc;
    if (t !== undefined) lastTime = t;
  }
}
console.log(`speech lines with a known time: ${known}; with no time (no match in the output): ${unknown}`);
console.log("\nSpeech line has a TC, by the seconds since the TC before it (any kind of line):");
for (let i = 0; i < bins.length - 1; i++) {
  const key = `${bins[i]}-${bins[i + 1] === Infinity ? "" : bins[i + 1]} s`;
  if (byGap.has(key)) console.log(`  ${key.padEnd(10)} ${pct(...byGap.get(key)!)}`);
}
for (const [kind, m] of Object.entries(byGapKind)) {
  console.log(`\n  ${kind}:`);
  for (let i = 0; i < bins.length - 1; i++) {
    const key = `${bins[i]}-${bins[i + 1] === Infinity ? "" : bins[i + 1]} s`;
    if (m.has(key)) console.log(`    ${key.padEnd(10)} ${pct(...m.get(key)!)}`);
  }
}
console.log("\nSpeech line has a TC, by the seconds since the start of the line before it:");
for (const k of ["under 2 s after the line before", "2-5 s", "5-10 s", "10 s or more"]) if (byPause.has(k)) console.log(`  ${k.padEnd(34)} ${pct(...byPause.get(k)!)}`);
