// CLI: bun previewgen/checklayout.ts <work-dir> <id>_preview_by_camera_file.txt [from s] [to s]
//
// Facts about the camera-file layout of a finished run, with no model call:
// does each camera recording that the code found have one head line at its
// start second, do the blocks cover the video with no gap, and is each length
// right? It does not check the words of a line, and it cannot know about a
// cut that the detector did not find.
import fs from "fs";
import path from "path";

const [workDir, txt, a, b] = process.argv.slice(2);
const cuts = JSON.parse(fs.readFileSync(path.join(workDir, "windows.json"), "utf-8")).cuts as number[];
const dur = JSON.parse(fs.readFileSync(path.join(workDir, "preview.json"), "utf-8")).duration as number;

// The recordings as the layout defines them (see clipRows in previewgen/cliplayout.ts).
const starts = [0, ...cuts.filter((c) => c > 0.5 && c < dur - 0.5)];
const all = starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? dur }));
const files = all.filter((f) => f.end - f.start >= 1);
const dropped = all.filter((f) => f.end - f.start < 1);

const tcSec = (tc: string) => (tc.length <= 4 ? parseInt(tc.slice(0, -2) || "0", 10) * 60 + parseInt(tc.slice(-2), 10) : parseInt(tc.slice(0, -4), 10) * 3600 + parseInt(tc.slice(-4, -2), 10) * 60 + parseInt(tc.slice(-2), 10));
const heads = fs
  .readFileSync(txt, "utf-8")
  .split("\n")
  .map((l) => l.match(/^(\d{4,6})\t■ (.*) \((\d+):(\d\d)\)$/))
  .filter((m): m is RegExpMatchArray => !!m)
  .map((m) => ({ tc: tcSec(m[1]), text: m[2], len: parseInt(m[3], 10) * 60 + parseInt(m[4], 10) }));

const clock = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
let sameStart = 0;
files.forEach((f, i) => {
  if (heads[i] && heads[i].tc === Math.floor(f.start)) sameStart++;
});
const covered = files.reduce((x, f) => x + (f.end - f.start), 0);
console.log(`video length ${clock(dur)} (${dur.toFixed(1)} s)`);
console.log(`recordings that the code found: ${files.length} (pieces under 1 s left out: ${dropped.length}, ${dropped.reduce((x, f) => x + f.end - f.start, 0).toFixed(1)} s)`);
console.log(`head lines in the document: ${heads.length}; head line k starts at the second of recording k: ${sameStart} of ${files.length}`);
console.log(`the recordings cover ${covered.toFixed(1)} s of ${dur.toFixed(1)} s; first starts at ${files[0].start}, last ends at ${files[files.length - 1].end.toFixed(1)}`);
console.log(`sum of the lengths shown in the head lines: ${clock(heads.reduce((x, h) => x + h.len, 0))} (each length is rounded to a second)`);
const err = heads.map((h, i) => h.len - (files[i].end - files[i].start));
const worst = err.map((e, i) => ({ e, i })).sort((x, y) => Math.abs(y.e) - Math.abs(x.e)).slice(0, 4);
console.log(`length shown minus real length: sum ${err.reduce((x, e) => x + e, 0).toFixed(1)} s, largest ${worst.map((w) => `${w.e.toFixed(2)} s (line ${w.i + 1}, real ${(files[w.i].end - files[w.i].start).toFixed(2)} s, shown ${heads[w.i].len} s)`).join("; ")}`);
console.log(`head lines with their own description: ${heads.filter((h) => h.text !== "이어서").length}; marked 이어서: ${heads.filter((h) => h.text === "이어서").length}`);
const lens = files.map((f) => f.end - f.start).sort((x, y) => x - y);
console.log(`length of a recording: shortest ${lens[0].toFixed(1)} s, median ${lens[Math.floor(lens.length / 2)].toFixed(1)} s, longest ${lens[lens.length - 1].toFixed(1)} s; 2 s or shorter: ${lens.filter((l) => l <= 2).length}`);
if (a && b) {
  const [from, to] = [parseFloat(a), parseFloat(b)];
  console.log(`cuts between ${from} and ${to} s: ${cuts.filter((c) => c >= from && c <= to).map((c) => c.toFixed(2)).join(", ")}`);
}
