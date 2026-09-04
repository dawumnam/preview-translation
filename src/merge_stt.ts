import fs from "fs";
import path from "path";
import { formatTimestamp } from "./parser";

// Merge every STT pass (stt_results, stt_results_2, ...) into one transcript
// per chunk: stt_results_merged/<chunk_id>.json.
//
// Why: quiet lines — a local's short reply under running water and the host's
// Korean — are heard by Gemini on some passes and not others. On the 0825
// episode six markers' speech was missed by the one pass the mappers read and
// caught by four or five of the other five. Any single pass is therefore the
// wrong input for mapping or billing; the union of passes is.
//
// Utterances from different passes that describe the same speech are
// clustered by time overlap (>= 50% of the shorter one) and same language
// family (Korean vs not — the host's Korean routinely overlaps a local's
// Vietnamese, and those must stay separate). Each cluster keeps the longest
// text, majority-vote speaker and language, and records how many passes heard
// it (`heard_by`) so the mapper can weigh a line heard once against one heard
// six times.

const planPath = process.argv[2];
if (!planPath) {
  console.error("Usage: bun src/merge_stt.ts <hwpx-dir>/chunks_plan.json");
  process.exit(1);
}
const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
const baseDir = path.dirname(path.resolve(planPath));
const passDirs = fs
  .readdirSync(baseDir)
  .filter((n) => /^stt_results(_\d+)?$/.test(n))
  .sort((a, b) => a.length - b.length || a.localeCompare(b));
if (passDirs.length === 0) {
  console.error(`No stt_results*/ under ${baseDir}`);
  process.exit(1);
}
const outDir = path.join(baseDir, "stt_results_merged");
fs.mkdirSync(outDir, { recursive: true });

interface Utt {
  start_sec: number;
  end_sec: number;
  abs_start: number;
  abs_end: number;
  speaker: string;
  language: string;
  text: string;
  translation: string;
  pass: number;
}
interface Cluster {
  members: Utt[];
  start: number;
  end: number;
  korean: boolean;
}

const isKorean = (lang: string) => lang.trim() === "한국어";
const tenth = (x: number) => Math.round(x * 10) / 10;
const majority = (xs: string[]) => {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
};

const clipTime = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
};

for (const chunk of plan.chunks) {
  const utts: Utt[] = [];
  const present: string[] = [];
  for (const [i, dir] of passDirs.entries()) {
    const f = path.join(baseDir, dir, `${chunk.chunk_id}.json`);
    if (!fs.existsSync(f)) continue;
    present.push(dir);
    for (const u of JSON.parse(fs.readFileSync(f, "utf-8")).utterances ?? []) {
      if (!Number.isFinite(u.abs_start) || !Number.isFinite(u.abs_end)) continue;
      utts.push({
        start_sec: Number(u.start_sec),
        end_sec: Number(u.end_sec),
        abs_start: Number(u.abs_start),
        abs_end: Number(u.abs_end),
        speaker: String(u.speaker ?? "").trim(),
        language: String(u.language ?? "").trim(),
        text: String(u.text ?? ""),
        translation: String(u.translation ?? ""),
        pass: i + 1,
      });
    }
  }
  if (utts.length === 0) {
    console.error(`${chunk.chunk_id}: no STT results in any pass`);
    continue;
  }

  utts.sort((a, b) => a.abs_start - b.abs_start || a.abs_end - b.abs_end);
  const clusters: Cluster[] = [];
  for (const u of utts) {
    const kor = isKorean(u.language);
    const dur = Math.max(0.1, u.abs_end - u.abs_start);
    let best: Cluster | null = null;
    let bestOv = 0;
    for (const c of clusters) {
      if (c.korean !== kor) continue;
      if (c.members.some((m) => m.pass === u.pass)) continue; // one per pass per cluster
      const ov = Math.min(c.end, u.abs_end) - Math.max(c.start, u.abs_start);
      const shorter = Math.min(dur, Math.max(0.1, c.end - c.start));
      if (ov / shorter >= 0.5 && ov > bestOv) {
        best = c;
        bestOv = ov;
      }
    }
    if (best) {
      best.members.push(u);
      // Widen a little toward the union so later passes still match; the
      // representative's own times are what gets written out.
      best.start = Math.min(best.start, u.abs_start);
      best.end = Math.max(best.end, u.abs_end);
    } else {
      clusters.push({ members: [u], start: u.abs_start, end: u.abs_end, korean: kor });
    }
  }

  const merged = clusters
    .map((c) => {
      const rep = [...c.members].sort((a, b) => b.text.length - a.text.length)[0];
      const speaker = majority(c.members.map((m) => m.speaker));
      const language = majority(c.members.map((m) => m.language));
      const abs_start = tenth(rep.abs_start);
      const abs_end = tenth(rep.abs_end);
      return {
        start: clipTime(rep.start_sec),
        end: clipTime(rep.end_sec),
        start_sec: tenth(rep.start_sec),
        end_sec: tenth(rep.end_sec),
        abs_start,
        abs_end,
        duration: tenth(abs_end - abs_start),
        speaker,
        language,
        text: rep.text,
        translation: rep.translation,
        heard_by: c.members.length,
        of_passes: present.length,
        speakers_heard: [...new Set(c.members.map((m) => m.speaker))],
      };
    })
    .sort((a, b) => a.abs_start - b.abs_start || a.abs_end - b.abs_end);

  const speechSec = tenth(merged.reduce((a, u) => a + u.duration, 0));
  const foreignSec = tenth(merged.filter((u) => !isKorean(u.language)).reduce((a, u) => a + u.duration, 0));
  const out = {
    chunk_id: chunk.chunk_id,
    scene: chunk.scene,
    audio_start: chunk.audio_start,
    marker_range: [chunk.start_sec, chunk.end_sec],
    markers: chunk.marker_indices,
    passes: present,
    speech_sec: speechSec,
    foreign_speech_sec: foreignSec,
    utterances: merged,
  };
  fs.writeFileSync(path.join(outDir, `${chunk.chunk_id}.json`), JSON.stringify(out, null, 2));
  const once = merged.filter((u) => u.heard_by === 1 && !isKorean(u.language)).length;
  console.error(
    `${chunk.chunk_id}: ${utts.length} utterances over ${present.length} passes → ${merged.length} merged (${formatTimestamp(Math.round(foreignSec))} foreign; ${once} foreign lines heard by only one pass)`,
  );
}
console.error(`\nWrote ${outDir}/`);
