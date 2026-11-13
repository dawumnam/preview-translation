// Usage: bun previewgen/study/annot.ts <id> <from s> <to s>
// The human preview with, for each TC line: C when a hard cut lies within 12 s before it, and the seconds since the TC before.
import fs from "fs";
import { loadGt, renderLine } from "../gt";

const [id, a, b] = process.argv.slice(2);
const ROOT = "exp/previewgen";
const text = fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8");
const t: number[] = [];
const s: number[] = [];
let cur = 0;
for (const line of text.split("\n")) {
  if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
  else if (line.startsWith("lavfi.scene_score=")) {
    t.push(cur);
    s.push(parseFloat(line.slice(18)));
  }
}
const cuts: number[] = [];
for (let i = 0; i < s.length; i++) {
  if (s[i] < 0.03) continue;
  const nb: number[] = [];
  for (let k = Math.max(0, i - 12); k <= Math.min(s.length - 1, i + 12); k++) if (k !== i) nb.push(s[k]);
  nb.sort((x, y) => x - y);
  if (s[i] >= 3 * Math.max(nb[nb.length - 2] ?? 0, 0.002) && (!cuts.length || t[i] - cuts[cuts.length - 1] >= 1)) cuts.push(t[i]);
}
const gt = loadGt(`${ROOT}/gt/${id}.hwpx`).filter((l) => l.tcPrev >= parseFloat(a) && l.tcPrev < parseFloat(b));
let prev: number | undefined;
for (const l of gt) {
  let mark = "      ";
  if (l.tc !== undefined) {
    const c = cuts.filter((x) => x >= l.tc! - 12 && x <= l.tc! + 2).pop();
    const gap = prev === undefined ? "" : String(Math.round(l.tc - prev)).padStart(3);
    mark = `${c !== undefined ? `C${String(Math.round(l.tc - c)).padStart(2)}` : "   "}${gap.padStart(3)}`;
    prev = l.tc;
  }
  console.log(`${mark} ${renderLine(l).slice(0, 80)}`);
}
