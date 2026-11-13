// Usage: bun previewgen/study/lag.ts
// How many seconds after a camera cut does the human writer put the TC of the shot line?
import fs from "fs";
import { loadGt } from "../gt";

const ROOT = "exp/previewgen";
const ids = ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];

function cutsOf(id: string): number[] {
  const text = fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8");
  const out: number[] = [];
  let cur = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
    else if (line.startsWith("lavfi.scene_score=") && parseFloat(line.slice(18)) >= 0.1 && (!out.length || cur - out[out.length - 1] >= 1)) out.push(cur);
  }
  return out;
}

const hist = new Map<number, number>();
const perId: string[] = [];
let n = 0;
for (const id of ids) {
  const cuts = cutsOf(id);
  const lags: number[] = [];
  for (const l of loadGt(`${ROOT}/gt/${id}.hwpx`)) {
    if (l.kind !== "shot" || l.tc === undefined) continue;
    // The last cut before the TC, when no other cut and no long time lies between.
    const c = cuts.filter((x) => x <= l.tc! + 1.5 && x >= l.tc! - 12).pop();
    if (c === undefined) continue;
    const lag = Math.round(l.tc - c);
    lags.push(l.tc - c);
    hist.set(lag, (hist.get(lag) ?? 0) + 1);
    n++;
  }
  lags.sort((a, b) => a - b);
  perId.push(`${id}: median ${lags[Math.floor(lags.length / 2)].toFixed(1)} s, p25 ${lags[Math.floor(lags.length / 4)].toFixed(1)}, p75 ${lags[Math.floor((3 * lags.length) / 4)].toFixed(1)} (n=${lags.length})`);
}
console.log(perId.join("\n"));
console.log([...hist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}s:${v}`).join("  "));
for (const shift of [0, 1, 2, 3, 4]) {
  let w3 = 0;
  let w5 = 0;
  for (const [lag, v] of hist) {
    if (Math.abs(lag - shift) <= 3) w3 += v;
    if (Math.abs(lag - shift) <= 5) w5 += v;
  }
  console.log(`TC = cut + ${shift} s: within 3 s of the writer's TC ${((100 * w3) / n).toFixed(0)}%, within 5 s ${((100 * w5) / n).toFixed(0)}%`);
}
