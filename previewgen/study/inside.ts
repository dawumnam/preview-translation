// Usage: bun previewgen/study/inside.ts [--dump file.json] [ids...]
// The writer's shot lines that are not at a camera cut: how many stand in talk, how many in silence,
// and how long after the line before. Nine human previews, no model call.
import fs from "fs";
import { loadGt, type GtLine } from "../gt";
import { cutsOf, ROOT } from "./lib";

const args = process.argv.slice(2);
const di = args.indexOf("--dump");
const dump = di >= 0 ? args.splice(di, 2)[1] : undefined;
const ids = args.length ? args : ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];

export interface InsideLine {
  id: string;
  no: number;
  tc: number;
  text: string;
  prev: string; // the shot line before
  talk: "none" | "before" | "after" | "both";
  /** Lines of the preview around the shot line (3 before, 3 after), for a reader. */
  around: string[];
}
const out: InsideLine[] = [];
let atCut = 0;
let minutesTalk = 0;
let minutesAll = 0;
for (const id of ids) {
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`).filter((l) => l.kind !== "scene" && l.kind !== "note");
  const cuts = cutsOf(id);
  const speechAt = gt.filter((l) => l.kind === "speech" || l.kind === "foreign").map((l) => l.tc ?? l.tcPrev);
  const last = Math.max(...gt.filter((l) => l.tc !== undefined).map((l) => l.tc!));
  // Share of the time with talk: 20 s steps that hold a speech line.
  for (let t = 0; t < last; t += 20) {
    minutesAll += 1 / 3;
    if (speechAt.some((x) => x >= t && x < t + 20)) minutesTalk += 1 / 3;
  }
  let prevShot = "";
  const row = (l: GtLine) => `${l.tc !== undefined ? String(Math.floor(l.tc / 60)).padStart(2, "0") + ":" + String(Math.floor(l.tc % 60)).padStart(2, "0") : "  -  "} ${l.kind === "shot" ? "SHOT " + l.text : l.speaker + ": " + (l.kind === "foreign" ? "@@" : l.text.slice(0, 50))}`;
  gt.forEach((l, k) => {
    if (l.kind !== "shot" || l.tc === undefined || l.text === "영상종료") return;
    const isCut = cuts.some((c) => c >= l.tc! - 12 && c <= l.tc! + 2);
    if (isCut) atCut++;
    else {
      // Talk next to the line: the lines before and after it in the document are speech, close in time.
      const b = gt[k - 1];
      const a = gt[k + 1];
      const before = !!b && b.kind !== "shot" && l.tc - (b.tc ?? b.tcPrev) <= 20;
      const after = !!a && a.kind !== "shot" && (a.tc === undefined || a.tc - l.tc <= 12);
      out.push({ id, no: l.no, tc: l.tc, text: l.text, prev: prevShot, talk: before && after ? "both" : before ? "before" : after ? "after" : "none", around: gt.slice(Math.max(0, k - 3), k + 4).map((x) => (x === l ? ">> " : "   ") + row(x)) });
    }
    prevShot = l.text;
  });
}
const pc = (a: number, b: number) => `${a} (${b ? Math.round((100 * a) / b) : 0}%)`;
const n = out.length;
console.log(`shot lines at a cut: ${atCut}; not at a cut: ${n}`);
console.log(`not at a cut, by the lines next to it in the document: no speech ${pc(out.filter((x) => x.talk === "none").length, n)} | speech before only ${pc(out.filter((x) => x.talk === "before").length, n)} | speech after only ${pc(out.filter((x) => x.talk === "after").length, n)} | speech before and after ${pc(out.filter((x) => x.talk === "both").length, n)}`);
console.log(`same words as the shot line before: ${pc(out.filter((x) => x.text.replace(/\s/g, "") === x.prev.replace(/\s/g, "")).length, n)}`);
console.log(`share of the time with talk (20 s steps with a speech line): ${Math.round((100 * minutesTalk) / minutesAll)}% of ${Math.round(minutesAll)} min`);
for (const id of ids) {
  const x = out.filter((o) => o.id === id);
  console.log(`  ${id}: ${x.length} lines not at a cut; in talk (before and after) ${pc(x.filter((o) => o.talk === "both").length, x.length)}, no speech next to it ${pc(x.filter((o) => o.talk === "none").length, x.length)}`);
}
if (dump) fs.writeFileSync(dump, JSON.stringify(out, null, 1));
