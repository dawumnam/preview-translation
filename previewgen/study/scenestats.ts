// Usage: bun previewgen/study/scenestats.ts
// How long are the scenes of the human previews, and what is at a scene start?
import { clock } from "../../src/script";
import { loadGt } from "../gt";

const ROOT = "exp/previewgen";
const ids = ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];
const lens: number[] = [];
const firstKind: Record<string, number> = {};
const sk: number[] = [];
const other: number[] = [];
for (const id of ids) {
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  const end = Math.max(...gt.filter((l) => l.tc !== undefined).map((l) => l.tc!));
  const scenes = gt.filter((l) => l.kind === "scene" && Number.isFinite(l.tcNext));
  const rows: string[] = [];
  scenes.forEach((s, i) => {
    const start = s.tcNext;
    const stop = i + 1 < scenes.length ? scenes[i + 1].tcNext : end;
    const len = stop - start;
    lens.push(len);
    const body = gt.filter((l) => l.no > s.no && (i + 1 >= scenes.length || l.no < scenes[i + 1].no));
    const shots = body.filter((l) => l.kind === "shot").length;
    const talk = body.filter((l) => l.kind === "speech" || l.kind === "foreign").length;
    const first = gt[s.no + 1]?.kind ?? "?";
    firstKind[first] = (firstKind[first] ?? 0) + 1;
    if (/sk|tr\b|풍경/.test(s.text) && talk <= shots / 3) sk.push(len);
    else other.push(len);
    rows.push(`${clock(start).padStart(7)} ${(len / 60).toFixed(1).padStart(5)} min  ${String(shots).padStart(3)} shots ${String(talk).padStart(3)} turns  ${s.text}`);
  });
  console.log(`${id}\n${rows.join("\n")}`);
}
const q = (xs: number[], p: number) => ([...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] / 60).toFixed(1);
console.log(`\nscene length in minutes: p10 ${q(lens, 0.1)} p25 ${q(lens, 0.25)} p50 ${q(lens, 0.5)} p75 ${q(lens, 0.75)} p90 ${q(lens, 0.9)} (n=${lens.length})`);
console.log(`scenery scenes (title with sk/tr/풍경, few turns): n=${sk.length}, p50 ${q(sk, 0.5)}; other scenes: n=${other.length}, p50 ${q(other, 0.5)}`);
console.log(`first line of a scene: ${JSON.stringify(firstKind)}`);
