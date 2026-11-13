// A second layout for the preview document: the camera file is the unit.
//
// The human previews are one flat list. A shot line there can mean "a new
// camera file starts" or "the writer saw something new inside the take", and
// the reader cannot tell which. The first kind is a fact (code finds the cuts,
// and two runs of the model agree on 98 to 100% of these lines). The second
// kind is a note (two runs agree on 58 to 87%, and a human writer and the
// model on 50 to 66%).
//
// In this layout each camera file has one head line with its exact start and
// its length. The notes and the spoken turns of the file stand below it, each
// with its own TC. So the TC of a head line has one meaning, every file is in
// the document, and a note more or less does not change the frame.
//
// CLI: bun previewgen/cliplayout.ts <work-dir> [--template <preview.hwpx>] [--out <file without extension>]
//      (the work directory of a finished run: preview.json and windows.json)
import fs from "fs";
import path from "path";
import { tcText, type PreviewLine } from "./gt";
import { writeHwpx, writeTxt, type Row } from "./write";

const RULE = "-".repeat(103);

export interface Person {
  label: string;
  look: string;
  from: number;
  to: number;
  turns: number;
}

const mss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec) % 60).padStart(2, "0")}`;

/** The rows of the document in the camera-file layout. `lines` are the finished lines, scene lines included. */
export function clipRows(title: string, lines: PreviewLine[], cuts: number[], durationSec: number, persons: Person[] = []): Row[] {
  const rows: Row[] = [
    { text: RULE, style: "rule" },
    { text: title, style: "title" },
    { text: RULE, style: "rule" },
  ];
  // Who is who: the labels of the locals are made up for this day, so the document says what they mean.
  if (persons.length) {
    for (const p of persons) rows.push({ text: `${p.label}\t${p.look} (${tcText(p.from)}~)`, style: "body" });
    rows.push({ text: RULE, style: "rule" });
  }
  for (const l of lines) if (l.kind === "scene") rows.push({ text: `# ${l.text}`, style: "scene" });
  rows.push({ text: RULE, style: "rule" });

  // Camera files: from one cut to the next. A file of under one second is a glitch of the join.
  const starts = [0, ...cuts.filter((c) => c > 0.5 && c < durationSec - 0.5)];
  const files = starts.map((s, i) => ({ start: s, end: starts[i + 1] ?? durationSec })).filter((f) => f.end - f.start >= 1);
  let k = 0; // next file whose head line is not written yet
  let firstScene = true;
  const head = (text: string) => {
    const f = files[k++];
    rows.push({ text: `${tcText(f.start)}\t■ ${text} (${mss(f.end - f.start)})`, style: "clip" });
  };
  for (const l of lines) {
    if (l.kind === "scene") {
      // The scene line stands before the head line of the file that it starts with.
      if (!firstScene) rows.push({ text: "", style: "body" });
      firstScene = false;
      rows.push({ text: `# ${l.text}`, style: "scene" });
      continue;
    }
    const t = l.tc ?? 0;
    // Files that end before this line and have no line of their own: the picture went on with no new note.
    while (k < files.length && files[k].start <= t - 2.5 && (files[k + 1]?.start ?? Infinity) <= t - 2.5) head("이어서");
    if (k < files.length && Math.abs(files[k].start - t) <= 2.5 && l.kind === "shot") {
      head(l.text);
      continue;
    }
    if (k < files.length && files[k].start <= t + 2.5) head("이어서");
    const tc = tcText(l.tcDoc ?? t);
    if (l.kind === "shot") rows.push({ text: `${tc}\t· ${l.text}`, style: "body" });
    else if (l.kind === "foreign") rows.push({ text: `${tc}\t${l.speaker}\t@@(${l.lang || "조"})`, style: "body" });
    else rows.push({ text: `${tc}\t${l.speaker}\t${l.text}`, style: "body" });
  }
  while (k < files.length) head("이어서");
  rows.push({ text: `${tcText(durationSec)}\t영상종료`, style: "body" });
  return rows;
}

if (import.meta.main) {
  const workDir = process.argv[2];
  const arg = (name: string) => (process.argv.indexOf(`--${name}`) >= 0 ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);
  if (!workDir || workDir.startsWith("--")) {
    console.error("Usage: bun previewgen/cliplayout.ts <work-dir> [--template <preview.hwpx>] [--out <file without extension>]");
    process.exit(1);
  }
  const preview = JSON.parse(fs.readFileSync(path.join(workDir, "preview.json"), "utf-8"));
  const cuts = JSON.parse(fs.readFileSync(path.join(workDir, "windows.json"), "utf-8")).cuts as number[];
  const id = path.basename(workDir).match(/\d{4}/)?.[0] ?? "preview";
  const rows = clipRows(id, preview.lines, cuts, preview.duration, preview.persons ?? []);
  const out = arg("out") ?? path.join(path.dirname(workDir), `${id}_preview_by_camera_file`);
  writeTxt(rows, `${out}.txt`);
  if (arg("template")) writeHwpx(rows, arg("template")!, `${out}.hwpx`);
  const files = rows.filter((r) => r.style === "clip").length;
  console.log(`${files} camera files, ${rows.filter((r) => r.style === "clip" && r.text.includes("■ 이어서")).length} of them with no note of their own → ${out}.txt${arg("template") ? " and .hwpx" : ""}`);
}
