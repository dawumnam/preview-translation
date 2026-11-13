// Usage: bun previewgen/study/shot_vocab.ts
import { loadGt } from "../gt";

const dir = "exp/previewgen/gt";
const tok: Record<string, number> = {};
const full: Record<string, number> = {};
let n = 0;
let len = 0;
const gaps: number[] = [];
let speechLines = 0;
let speechWithTc = 0;
for (const id of ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"]) {
  const lines = loadGt(`${dir}/${id}.hwpx`);
  let prevTc: number | undefined;
  for (const l of lines) {
    if (l.kind === "shot") {
      n++;
      len += l.text.length;
      full[l.text] = (full[l.text] ?? 0) + 1;
      for (const t of l.text.split(/[\s,]+/).filter(Boolean)) tok[t] = (tok[t] ?? 0) + 1;
    }
    if (l.kind === "speech" || l.kind === "foreign") {
      speechLines++;
      if (l.tc !== undefined) speechWithTc++;
    }
    if (l.tc !== undefined) {
      if (prevTc !== undefined) gaps.push(l.tc - prevTc);
      prevTc = l.tc;
    }
  }
}
const top = (o: Record<string, number>, k: number) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([t, c]) => `${t}(${c})`)
    .join("  ");
console.log("shot lines", n, "mean length", (len / n).toFixed(1));
console.log("TOKENS:", top(tok, 110));
console.log("FULL:", top(full, 60));
gaps.sort((a, b) => a - b);
const q = (p: number) => gaps[Math.floor(gaps.length * p)];
console.log("gap between consecutive TCs (s): p10", q(0.1), "p25", q(0.25), "p50", q(0.5), "p75", q(0.75), "p90", q(0.9));
console.log("speech lines", speechLines, "with TC", speechWithTc, (speechWithTc / speechLines).toFixed(2));
