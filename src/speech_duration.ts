import fs from "fs";
import path from "path";
import { formatTimestamp } from "./parser";

// Sums measured foreign-speech duration from stt_results/*.json.
//
// Two totals are reported because they differ by ~10% and the difference is a
// definition, not measurement error:
//   billable   — utterances containing the episode's target language, whether
//                pure or code-switched. A half-Korean line still needs translating.
//   nonKorean  — everything not plain 한국어. Also picks up stray 영어/독일어
//                labels, which in a single-language episode are usually noise.

const planPath = process.argv[2];
if (!planPath) {
  console.error("Usage: bun src/speech_duration.ts <hwpx-dir>/chunks_plan.json");
  process.exit(1);
}

// Script language code → name the STT step emits in `language`.
const LANG_NAME: Record<string, string> = {
  영: "영어",
  독: "독일어",
  오: "독일어",
  베: "베트남어",
};

const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
const baseDir = path.dirname(path.resolve(planPath));
const sttDir = path.join(baseDir, "stt_results");

// Target language: whatever the markers say. Warn if an episode mixes codes.
const codes = [
  ...new Set(
    plan.chunks.flatMap((c: any) => c.markers.map((m: any) => m.language)),
  ),
] as string[];
const targets = codes.map((c) => LANG_NAME[c]).filter(Boolean);
if (targets.length === 0) {
  console.error(`No known language code among markers (${codes.join(", ")}); billable = nonKorean`);
} else if (targets.length > 1) {
  console.error(`Markers use several languages (${codes.join(", ")}); billable counts any of them`);
}

const byLang = new Map<string, number>();
let billable = 0;
let nonKorean = 0;
let allSpeech = 0;
let utterances = 0;
const perChunk: any[] = [];
const missing: string[] = [];

for (const chunk of plan.chunks) {
  const f = path.join(sttDir, `${chunk.chunk_id}.json`);
  if (!fs.existsSync(f)) {
    missing.push(chunk.chunk_id);
    continue;
  }
  const d = JSON.parse(fs.readFileSync(f, "utf-8"));
  let cb = 0;
  let cn = 0;
  for (const u of d.utterances ?? []) {
    const lang = String(u.language ?? "").trim();
    const dur = Number(u.duration) || 0;
    utterances++;
    allSpeech += dur;
    byLang.set(lang, (byLang.get(lang) ?? 0) + dur);
    const isNonKorean = lang !== "한국어";
    const isTarget =
      targets.length === 0
        ? isNonKorean
        : targets.some((t) => lang.includes(t));
    if (isNonKorean) cn += dur;
    if (isTarget) cb += dur;
  }
  billable += cb;
  nonKorean += cn;
  perChunk.push({
    chunk_id: chunk.chunk_id,
    scene: chunk.scene,
    markers: chunk.marker_indices.length,
    utterances: (d.utterances ?? []).length,
    billable_sec: cb,
    non_korean_sec: cn,
    speech_sec: d.speech_sec ?? 0,
  });
}

if (missing.length) {
  console.error(`WARNING: no STT result for chunks: ${missing.join(", ")} — total is incomplete`);
}

console.error(
  `\n${"chunk".padEnd(9)}${"markers".padStart(8)}${"utts".padStart(6)}${"billable".padStart(10)}${"non-KR".padStart(8)}${"speech".padStart(8)}`,
);
for (const c of perChunk) {
  console.error(
    `${c.chunk_id.padEnd(9)}${String(c.markers).padStart(8)}${String(c.utterances).padStart(6)}${formatTimestamp(c.billable_sec).padStart(10)}${formatTimestamp(c.non_korean_sec).padStart(8)}${formatTimestamp(c.speech_sec).padStart(8)}`,
  );
}
console.error(`\nby language:`);
for (const [lang, sec] of [...byLang.entries()].sort((a, b) => b[1] - a[1])) {
  console.error(`  ${lang.padEnd(18)} ${formatTimestamp(sec)}`);
}

const target = targets.length ? targets.join("/") : "(non-Korean)";
console.error(`\nBILLABLE (${target}, incl. code-switched): ${formatTimestamp(billable)}  = ${(billable / 60).toFixed(2)} min`);
console.error(`non-Korean (broad):                      ${formatTimestamp(nonKorean)}  = ${(nonKorean / 60).toFixed(2)} min`);
console.error(`all speech in chunks:                    ${formatTimestamp(allSpeech)}`);

const out = {
  hwpx_path: plan.hwpx_path,
  target_language: target,
  billable_sec: billable,
  billable_min: Math.round((billable / 60) * 100) / 100,
  non_korean_sec: nonKorean,
  all_speech_sec: allSpeech,
  utterances,
  markers: plan.total_markers,
  missing_chunks: missing,
  by_language: Object.fromEntries(byLang),
  chunks: perChunk,
};
const outPath = path.join(baseDir, "speech_duration.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.error(`\nWrote ${outPath}`);
console.log(JSON.stringify({ billable_min: out.billable_min, billable_sec: billable, target }));
