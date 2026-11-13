// Usage: bun previewgen/study/takes.ts [ids...]
// For each camera cut: does the writer have a shot line after it? By the length of the take
// and by the talk around the cut. Nine human previews, no model call.
import fs from "fs";
import { loadGt } from "../gt";
import { cutsOf, ROOT } from "./lib";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];

interface Take {
  id: string;
  start: number;
  len: number;
  human: boolean; // a human shot line from 2 s before to 12 s after the cut
  talkAcross: boolean; // human speech lines with a TC in the 8 s before and in the 8 s after the cut
  speechIn: number; // human speech lines inside the take
  firstSpeech: number; // seconds from the cut to the first human speech line with a TC in the take
}
const takes: Take[] = [];
for (const id of ids) {
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  const cuts = cutsOf(id);
  const shots = gt.filter((l) => l.kind === "shot" && l.tc !== undefined).map((l) => l.tc!);
  const speech = gt.filter((l) => (l.kind === "speech" || l.kind === "foreign") && l.tc !== undefined).map((l) => l.tc!);
  const all = gt.filter((l) => l.kind === "speech" || l.kind === "foreign");
  const last = Math.max(...gt.filter((l) => l.tc !== undefined).map((l) => l.tc!));
  cuts.forEach((c, k) => {
    if (c > last) return;
    const next = cuts[k + 1] ?? last;
    takes.push({
      id,
      start: c,
      len: next - c,
      human: shots.some((t) => t >= c - 2 && t <= c + 12 && t < next + 2),
      talkAcross: speech.some((t) => t >= c - 8 && t < c) && speech.some((t) => t >= c && t <= c + 8),
      speechIn: all.filter((l) => l.tcPrev >= c && l.tcPrev < next).length,
      firstSpeech: Math.min(Infinity, ...speech.filter((t) => t >= c - 1 && t < next).map((t) => t - c)),
    });
  });
}
const pc = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
const rate = (name: string, f: (t: Take) => boolean) => {
  const x = takes.filter(f);
  console.log(`  ${name.padEnd(40)} cuts with a human shot line: ${pc(x.filter((t) => t.human).length, x.length)}`);
};
console.log(`${takes.length} cuts in ${ids.length} episodes`);
rate("all", () => true);
console.log(" by the length of the take:");
for (const [a, b] of [[0, 3], [3, 5], [5, 8], [8, 12], [12, 20], [20, 40], [40, 120], [120, 1e9]]) rate(`${a} to ${b > 1e8 ? "…" : b} s`, (t) => t.len >= a && t.len < b);
console.log(" by talk:");
rate("talk goes on across the cut", (t) => t.talkAcross);
rate("no talk across the cut", (t) => !t.talkAcross);
// This split does not predict the choice: when the writer puts the TC on the shot line, the speech line after it has none.
console.log(" takes of 8 s and more, by the first human speech line with a TC after the cut:");
for (const [a, b] of [[0, 3], [3, 6], [6, 12], [12, 30], [30, 1e9]]) rate(`speech ${a} to ${b > 1e8 ? "…" : b} s after the cut`, (t) => t.len >= 8 && t.firstSpeech >= a && t.firstSpeech < b);
console.log(" takes of 8 s and more, by the share of the take with talk (speech lines for each minute):");
for (const [a, b] of [[0, 0.01], [0.01, 2], [2, 5], [5, 1e9]]) rate(`${a} to ${b > 1e8 ? "…" : b} lines a minute`, (t) => t.len >= 8 && (t.speechIn / t.len) * 60 >= a && (t.speechIn / t.len) * 60 < b);
console.log(" by episode:");
for (const id of ids) rate(id, (t) => t.id === id);
console.log(" takes under 5 s, by episode:");
for (const id of ids) rate(id, (t) => t.id === id && t.len < 5);
