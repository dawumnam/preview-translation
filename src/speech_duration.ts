import fs from "fs";
import path from "path";
import { formatTimestamp } from "./parser";

// Measures billable foreign-dialogue minutes from stt_results*/ and writes
// speech_duration.json next to the plan.
//
// Billable = foreign DIALOGUE time, not just vocal-sound time:
//   - the span of each utterance in the target language (pauses between words
//     are inside the span, so they count)
//   - overlapping speech counted once (two people talking at once is one
//     stretch of program time)
//   - plus true pauses of <= PAUSE_SEC between consecutive foreign lines. A
//     pause is "true" only if nothing else was said in it — a Korean line in
//     the gap makes it Korean dialogue, not a beat in the foreign exchange.
// Measured on one episode, true pauses cluster at 1s and drop off sharply, so
// the threshold moves the total by well under 1% between 2s and 5s.
//
// Also reported, for reference:
//   speech    — plain sum of target-language utterance durations (no pause
//               credit, overlap double-counted). ~4% under billable.
//   nonKorean — everything not plain 한국어, same dialogue rule. Sweeps up stray
//               영어/독일어 labels, usually noise in a single-language episode.
//
// If several STT passes exist (stt_results, stt_results_2, ...) every total is
// the mean across passes and the spread is reported. A single pass lands within
// ±4% of the mean, the mean of three within ±2%. The unstable chunks are the
// ones with a constant noise bed (running water, machinery), so a wide
// per-chunk range points at hard audio, not a bad run.

const PAUSE_SEC = 2;

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

const runDirs = fs
  .readdirSync(baseDir)
  .filter((n) => /^stt_results(_\d+)?$/.test(n))
  .sort((a, b) => a.length - b.length || a.localeCompare(b));
if (runDirs.length === 0) {
  console.error(`No stt_results*/ directory under ${baseDir}`);
  process.exit(1);
}

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
const target = targets.length ? targets.join("/") : "(non-Korean)";

interface Utt {
  start_sec: number;
  end_sec: number;
  duration: number;
  language: string;
}

const isNonKorean = (u: Utt) => u.language !== "한국어";
const isTarget = (u: Utt) =>
  targets.length === 0 ? isNonKorean(u) : targets.some((t) => u.language.includes(t));

/**
 * Dialogue seconds for the utterances selected by `pick`: union of their spans,
 * bridging gaps of <= PAUSE_SEC when no other utterance falls in the gap.
 */
function dialogueSec(all: Utt[], pick: (u: Utt) => boolean): number {
  const sel = all.filter(pick);
  if (sel.length === 0) return 0;
  const others = all.filter((u) => !pick(u));
  const gapIsEmpty = (a: Utt, b: Utt) =>
    !others.some((o) => o.start_sec < b.start_sec && o.end_sec > a.end_sec);

  let total = 0;
  let bs = sel[0].start_sec;
  let be = sel[0].end_sec;
  let prev = sel[0];
  for (const u of sel.slice(1)) {
    const gap = u.start_sec - be;
    if (gap <= 0 || (gap <= PAUSE_SEC && gapIsEmpty(prev, u))) {
      be = Math.max(be, u.end_sec);
    } else {
      total += be - bs;
      bs = u.start_sec;
      be = u.end_sec;
    }
    prev = u;
  }
  return total + (be - bs);
}

interface ChunkTotals {
  chunk_id: string;
  utterances: number;
  billable_sec: number; // target dialogue
  target_speech_sec: number; // plain sum, reference
  non_korean_sec: number; // broad dialogue
  speech_sec: number; // all languages, plain sum
}
interface RunTotals {
  dir: string;
  billable_sec: number;
  target_speech_sec: number;
  non_korean_sec: number;
  all_speech_sec: number;
  utterances: number;
  missing: string[];
  by_language: Map<string, number>;
  chunks: ChunkTotals[];
}

function summarizeRun(dirName: string): RunTotals {
  const dir = path.join(baseDir, dirName);
  const run: RunTotals = {
    dir: dirName,
    billable_sec: 0,
    target_speech_sec: 0,
    non_korean_sec: 0,
    all_speech_sec: 0,
    utterances: 0,
    missing: [],
    by_language: new Map(),
    chunks: [],
  };
  for (const chunk of plan.chunks) {
    const f = path.join(dir, `${chunk.chunk_id}.json`);
    if (!fs.existsSync(f)) {
      run.missing.push(chunk.chunk_id);
      continue;
    }
    const d = JSON.parse(fs.readFileSync(f, "utf-8"));
    const utts: Utt[] = (d.utterances ?? [])
      .map((u: any) => ({
        start_sec: Number(u.start_sec) || 0,
        end_sec: Number(u.end_sec) || 0,
        duration: Number(u.duration) || 0,
        language: String(u.language ?? "").trim(),
      }))
      .sort((a: Utt, b: Utt) => a.start_sec - b.start_sec || a.end_sec - b.end_sec);

    const ct: ChunkTotals = {
      chunk_id: chunk.chunk_id,
      utterances: utts.length,
      billable_sec: dialogueSec(utts, isTarget),
      target_speech_sec: 0,
      non_korean_sec: dialogueSec(utts, isNonKorean),
      speech_sec: 0,
    };
    for (const u of utts) {
      ct.speech_sec += u.duration;
      if (isTarget(u)) ct.target_speech_sec += u.duration;
      run.by_language.set(u.language, (run.by_language.get(u.language) ?? 0) + u.duration);
    }
    run.chunks.push(ct);
    run.utterances += ct.utterances;
    run.all_speech_sec += ct.speech_sec;
    run.target_speech_sec += ct.target_speech_sec;
    run.non_korean_sec += ct.non_korean_sec;
    run.billable_sec += ct.billable_sec;
  }
  return run;
}

const runs = runDirs.map(summarizeRun);
for (const r of runs) {
  if (r.missing.length) {
    console.error(`WARNING: ${r.dir} has no result for chunks ${r.missing.join(", ")} — its total is incomplete`);
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

const billables = runs.map((r) => r.billable_sec);
const billableMean = mean(billables);
const billableSd = sd(billables);
const billableSe = billableSd / Math.sqrt(runs.length);
const targetSpeechMean = mean(runs.map((r) => r.target_speech_sec));
const nonKoreanMean = mean(runs.map((r) => r.non_korean_sec));
const allSpeechMean = mean(runs.map((r) => r.all_speech_sec));

// Per-chunk mean and spread, to spot audio that transcribes unstably.
const chunkRows = plan.chunks.map((chunk: any) => {
  const per = runs
    .map((r) => r.chunks.find((c) => c.chunk_id === chunk.chunk_id))
    .filter(Boolean) as ChunkTotals[];
  const b = per.map((c) => c.billable_sec);
  return {
    chunk_id: chunk.chunk_id,
    scene: chunk.scene,
    markers: chunk.marker_indices.length,
    runs_present: per.length,
    billable_mean_sec: b.length ? mean(b) : 0,
    billable_range_sec: b.length ? Math.max(...b) - Math.min(...b) : 0,
    utterances: per.map((c) => c.utterances),
  };
});

// Language table averaged across runs.
const langNames = new Set<string>();
for (const r of runs) for (const k of r.by_language.keys()) langNames.add(k);
const byLanguage: Record<string, number> = {};
for (const lang of langNames) {
  byLanguage[lang] = mean(runs.map((r) => r.by_language.get(lang) ?? 0));
}

// --- report ---
const pad = (s: string | number, n: number) => String(s).padStart(n);
const ts = (s: number) => formatTimestamp(Math.round(s));
console.error(
  `\n${"chunk".padEnd(9)}${pad("markers", 8)}${pad("billable", 10)}${pad("range", 7)}  utterances/run`,
);
for (const c of chunkRows) {
  console.error(
    `${c.chunk_id.padEnd(9)}${pad(c.markers, 8)}${pad(ts(c.billable_mean_sec), 10)}${pad(c.billable_range_sec + "s", 7)}  ${c.utterances.join("/")}`,
  );
}

if (runs.length > 1) {
  console.error(`\nper run:`);
  for (const r of runs) {
    console.error(`  ${r.dir.padEnd(16)} ${ts(r.billable_sec)}`);
  }
}

console.error(`\nby language (plain sum, mean of ${runs.length} run${runs.length > 1 ? "s" : ""}):`);
for (const [lang, sec] of Object.entries(byLanguage).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${lang.padEnd(18)} ${ts(sec)}`);
}

const pct = (x: number) => ((100 * x) / billableMean).toFixed(1) + "%";
console.error(
  `\nBILLABLE — ${target} dialogue (utterances + true pauses ≤${PAUSE_SEC}s, overlap once): ${ts(billableMean)}  = ${(billableMean / 60).toFixed(2)} min`,
);
if (runs.length > 1) {
  console.error(
    `  ${runs.length} runs, sd ${Math.round(billableSd)}s (${pct(billableSd)}), standard error of the mean ${Math.round(billableSe)}s (${pct(billableSe)})`,
  );
} else {
  console.error(
    `  single run — expect ±4%. For ±2%, run stt_chunks.ts twice more into stt_results_2 and stt_results_3.`,
  );
}
console.error(`  reference: plain sum of ${target} utterances (no pause credit)  ${ts(targetSpeechMean)}`);
console.error(`  reference: non-Korean dialogue (broad)                        ${ts(nonKoreanMean)}`);
console.error(`  all speech in chunks, every language                          ${ts(allSpeechMean)}`);

const out = {
  hwpx_path: plan.hwpx_path,
  target_language: target,
  definition: `dialogue: union of ${target} utterance spans + true pauses <= ${PAUSE_SEC}s (no other speech in the gap); overlap counted once`,
  pause_sec: PAUSE_SEC,
  billable_sec: Math.round(billableMean),
  billable_min: Math.round((billableMean / 60) * 100) / 100,
  n_runs: runs.length,
  billable_sd_sec: Math.round(billableSd),
  billable_se_sec: Math.round(billableSe),
  runs: runs.map((r) => ({
    dir: r.dir,
    billable_sec: r.billable_sec,
    target_speech_sec: r.target_speech_sec,
    non_korean_sec: r.non_korean_sec,
    all_speech_sec: r.all_speech_sec,
    utterances: r.utterances,
    missing_chunks: r.missing,
  })),
  target_speech_sec: Math.round(targetSpeechMean),
  non_korean_sec: Math.round(nonKoreanMean),
  all_speech_sec: Math.round(allSpeechMean),
  markers: plan.total_markers,
  by_language: byLanguage,
  chunks: chunkRows,
};
const outPath = path.join(baseDir, "speech_duration.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.error(`\nWrote ${outPath}`);
console.log(
  JSON.stringify({
    billable_min: out.billable_min,
    billable_sec: out.billable_sec,
    n_runs: runs.length,
    se_pct: runs.length > 1 ? Math.round((1000 * billableSe) / billableMean) / 10 : null,
    target,
  }),
);
