// Usage: bun previewgen/study/cutscore.ts
// Does the size of the picture jump at a cut say if the writer has a shot line there?
// And: cuts with no human shot line, by the scene they are in. Nine human previews, no model call.
import fs from "fs";
import { loadGt } from "../gt";
import { ALL_IDS, ROOT } from "./lib";

interface Cut {
  id: string;
  t: number;
  score: number;
  len: number;
  human: boolean;
  scene: string;
  sceneShots: number; // shot lines of the scene for each minute
  sceneTurns: number; // speech lines of the scene for each minute
}
const cuts: Cut[] = [];
for (const id of ALL_IDS) {
  const text = fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8");
  const found: [number, number][] = [];
  let cur = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
    else if (line.startsWith("lavfi.scene_score=")) {
      const s = parseFloat(line.slice(18));
      if (s >= 0.1 && (!found.length || cur - found[found.length - 1][0] >= 1)) found.push([cur, s]);
    }
  }
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  const shots = gt.filter((l) => l.kind === "shot" && l.tc !== undefined).map((l) => l.tc!);
  const last = Math.max(...gt.filter((l) => l.tc !== undefined).map((l) => l.tc!));
  // Scenes: start time, title, lines.
  const scenes = gt.filter((l) => l.kind === "scene" && Number.isFinite(l.tcNext)).map((l) => ({ t: l.tcNext, title: l.text }));
  const sceneOf = (t: number) => {
    let k = -1;
    scenes.forEach((s, i) => s.t <= t + 1 && (k = i));
    if (k < 0) return { title: "(before the first scene)", shots: 0, turns: 0 };
    const a = scenes[k].t;
    const b = scenes[k + 1]?.t ?? last;
    const min = Math.max(0.5, (b - a) / 60);
    return {
      title: scenes[k].title,
      shots: gt.filter((l) => l.kind === "shot" && l.tc !== undefined && l.tc >= a && l.tc < b).length / min,
      turns: gt.filter((l) => (l.kind === "speech" || l.kind === "foreign") && l.tcPrev >= a && l.tcPrev < b).length / min,
    };
  };
  found.forEach(([t, s], k) => {
    if (t > last) return;
    const next = found[k + 1]?.[0] ?? last;
    const sc = sceneOf(t);
    cuts.push({ id, t, score: s, len: next - t, human: shots.some((x) => x >= t - 2 && x <= t + 12 && x < next + 2), scene: sc.title, sceneShots: sc.shots, sceneTurns: sc.turns });
  });
}
const pc = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
const rate = (name: string, f: (c: Cut) => boolean) => {
  const x = cuts.filter(f);
  console.log(`  ${name.padEnd(44)} cuts with a human shot line: ${pc(x.filter((c) => c.human).length, x.length)}`);
};
console.log(" by the size of the jump (scene score), takes of 8 s and more:");
for (const [a, b] of [[0.1, 0.15], [0.15, 0.25], [0.25, 0.4], [0.4, 0.6], [0.6, 1.01]]) rate(`${a} to ${b}`, (c) => c.len >= 8 && c.score >= a && c.score < b);
console.log(" by the kind of scene (speech lines for each minute of the scene), takes of 8 s and more:");
for (const [a, b] of [[0, 0.5], [0.5, 2], [2, 4], [4, 6], [6, 1e9]]) rate(`${a} to ${b > 1e8 ? "…" : b} speech lines a minute`, (c) => c.len >= 8 && c.sceneTurns >= a && c.sceneTurns < b);
console.log(" by the shot lines for each minute of the scene, takes of 8 s and more:");
for (const [a, b] of [[0, 0.3], [0.3, 1], [1, 2], [2, 1e9]]) rate(`${a} to ${b > 1e8 ? "…" : b} shot lines a minute`, (c) => c.len >= 8 && c.sceneShots >= a && c.sceneShots < b);
// Where the cuts with no human line are.
const miss = cuts.filter((c) => !c.human && c.len >= 8);
const by = new Map<string, number>();
for (const c of miss) by.set(`${c.id} ${c.scene}`, (by.get(`${c.id} ${c.scene}`) ?? 0) + 1);
console.log(` cuts (takes of 8 s and more) with no human shot line: ${miss.length}. Scenes with the most of them:`);
for (const [k, v] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  const c = miss.find((x) => `${x.id} ${x.scene}` === k)!;
  console.log(`   ${String(v).padStart(3)}  ${k}  (scene: ${c.sceneShots.toFixed(1)} shot lines, ${c.sceneTurns.toFixed(1)} speech lines a minute)`);
}
