// Usage: bun previewgen/study/peek.ts <id> <work dir> <from s> <to s>
// The human preview and the machine log side by side, in time order. No model call.
import { loadGt, tcText } from "../gt";
import { candidates } from "./candidates";

const [id, dir, a, b] = process.argv.slice(2);
const from = parseFloat(a);
const to = parseFloat(b);
const { cands, lines, cuts } = candidates(id, dir);
const byI = new Map(cands.map((c) => [c.i, c]));
const gt = loadGt(`exp/previewgen/gt/${id}.hwpx`);
type Row = { t: number; s: string };
const rows: Row[] = [];
for (const c of cuts) if (c >= from && c < to) rows.push({ t: c - 0.01, s: `         ---- cut ${tcText(c)} ----` });
for (const l of gt) {
  const t = l.tc ?? l.tcPrev;
  if (t < from || t >= to) continue;
  const tc = l.tc !== undefined ? tcText(l.tc).padStart(6) : "     .";
  if (l.kind === "scene") rows.push({ t: l.tcNext - 0.02, s: `H ${"".padStart(6)} # ${l.text}` });
  else if (l.kind === "shot") rows.push({ t, s: `H ${tc} SHOT ${l.text}` });
  else rows.push({ t: t + 0.001 * l.no, s: `H ${tc}    ${l.speaker}: ${l.kind === "foreign" ? "@@" : l.text.slice(0, 40)}` });
}
lines.forEach((l, i) => {
  const t = l.tc!;
  if (t < from || t >= to) return;
  const c = byI.get(i);
  if (c) rows.push({ t, s: `                                                          M ${tcText(t).padStart(6)} SHOT${c.atCut ? "*" : " "} ${c.human ? "=" : "x"} ${c.inMain && c.inPicture ? "2" : c.inMain ? "s" : "p"} ${l.text}` });
  else rows.push({ t, s: `                                                          M ${tcText(t).padStart(6)}    ${l.speaker}: ${l.kind === "foreign" ? "@@" : l.text.slice(0, 30)}` });
});
rows.sort((x, y) => x.t - y.t);
if (process.argv.includes("--shots")) {
  // Speech rows become one count line.
  const out: string[] = [];
  let h = 0;
  let m = 0;
  const flush = () => {
    if (h || m) out.push(`         … speech lines: human ${h}, machine ${m}`);
    h = m = 0;
  };
  for (const r of rows) {
    const speech = !/SHOT|cut|#/.test(r.s);
    if (speech) r.s.startsWith("H") ? h++ : m++;
    else {
      flush();
      out.push(r.s);
    }
  }
  flush();
  console.log(out.join("\n"));
} else console.log(rows.map((r) => r.s).join("\n"));
