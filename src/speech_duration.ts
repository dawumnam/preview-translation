import fs from "fs";
import path from "path";
import { formatTimestamp } from "./parser";

// Measures foreign-dialogue minutes from stt_results*/ and writes
// speech_duration.json next to the plan.
//
// Usage: bun src/speech_duration.ts <hwpx-dir>/chunks_plan.json [--rule A|B|C] [--prefix stt_results]
//
// All utterances from every chunk are pooled onto one episode timeline before
// anything is summed, so audio that two chunks' buffers both cover is counted
// once (adjacent chunks overlap by up to 120s; on the 0825 episode that was
// worth 20s of double-counting per pass).
//
// Dialogue time, not vocal-sound time: each target-language utterance's full
// span, overlapping speech counted once, plus true pauses of <= PAUSE_SEC
// between consecutive foreign lines. A pause counts only if nothing else was
// said in it — a Korean line in the gap makes it Korean dialogue. True pauses
// cluster at 1s and vanish past 2s, so the threshold is not a sensitive knob.
//
// Three attribution rules are always reported, because the raw footage holds
// far more foreign speech than the script marks for translation, and which of
// it is billable is a contract question:
//   A  everything in the scanned audio — includes discarded takes and lead-in
//      chatter the script never marks
//   B  excludes speech before each chunk's first marker. That window is where
//      NG takes live: on 0825 it held the first take of a haggle before the PD
//      called a redo, and a Q&A that was re-shot 30s later and marked there.
//   C  only blocks a marker lands in ([start-20s, end]). Strictest; penalises
//      a long exchange that a Korean aside splits into several blocks.
// On 0825, across three passes: A 10:37, B 8:39, C 7:01. --rule picks which
// one is written as `billable`; default B.
//
// If several passes exist (stt_results, stt_results_2, ...) every figure is
// the mean across passes and the spread is reported. Whole-second passes
// landed within ±4% of their mean; tenths-of-a-second passes are far tighter.

const PAUSE_SEC = 2;
const LEAD_IN_GRACE_SEC = 5; // markers are hand-typed and may trail the real start
const STRICT_LEAD_SEC = 20;

const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith("--"));
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const RULE = flag("rule", "B").toUpperCase() as "A" | "B" | "C";
const PREFIX = flag("prefix", "stt_results");
if (!planPath || !["A", "B", "C"].includes(RULE)) {
  console.error("Usage: bun src/speech_duration.ts <hwpx-dir>/chunks_plan.json [--rule A|B|C] [--prefix stt_results]");
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
const chunks: any[] = [...plan.chunks].sort((a, b) => a.audio_start - b.audio_start);

const dirRe = new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_\\d+)?$`);
const runDirs = fs
  .readdirSync(baseDir)
  .filter((n) => dirRe.test(n))
  .sort((a, b) => a.length - b.length || a.localeCompare(b));
if (runDirs.length === 0) {
  console.error(`No ${PREFIX}*/ directory under ${baseDir}`);
  process.exit(1);
}

// Target language: whatever the markers say. Warn if an episode mixes codes.
const codes = [...new Set(chunks.flatMap((c) => c.markers.map((m: any) => m.language)))] as string[];
const targets = codes.map((c) => LANG_NAME[c]).filter(Boolean);
if (targets.length === 0) {
  console.error(`No known language code among markers (${codes.join(", ")}); target = anything non-Korean`);
} else if (targets.length > 1) {
  console.error(`Markers use several languages (${codes.join(", ")}); target = any of them`);
}
const target = targets.length ? targets.join("/") : "(non-Korean)";

const markerTs: number[] = [...new Set(chunks.flatMap((c) => c.markers.map((m: any) => m.timestamp)))].sort((a, b) => a - b) as number[];
// Lead-in windows: from the chunk's audio start up to just before its first marker.
const leadIn: [number, number][] = chunks.map((c) => [
  c.audio_start,
  Math.min(...c.markers.map((m: any) => m.timestamp)) - LEAD_IN_GRACE_SEC,
]);

interface Utt {
  abs_start: number;
  abs_end: number;
  duration: number;
  language: string;
}
type Block = [number, number];

const isNonKorean = (u: Utt) => u.language !== "한국어";
const isTarget = (u: Utt) =>
  targets.length === 0 ? isNonKorean(u) : targets.some((t) => u.language.includes(t));

/** Dialogue blocks (absolute seconds) for utterances selected by `pick`. */
function dialogueBlocks(all: Utt[], pick: (u: Utt) => boolean): Block[] {
  const sel = all.filter(pick).sort((a, b) => a.abs_start - b.abs_start || a.abs_end - b.abs_end);
  if (sel.length === 0) return [];
  const others = all.filter((u) => !pick(u));
  const gapIsEmpty = (a: Utt, b: Utt) =>
    !others.some((o) => o.abs_start < b.abs_start && o.abs_end > a.abs_end);
  const blocks: Block[] = [];
  let bs = sel[0].abs_start;
  let be = sel[0].abs_end;
  let prev = sel[0];
  for (const u of sel.slice(1)) {
    const gap = u.abs_start - be;
    if (gap <= 0 || (gap <= PAUSE_SEC && gapIsEmpty(prev, u))) {
      be = Math.max(be, u.abs_end);
    } else {
      blocks.push([bs, be]);
      bs = u.abs_start;
      be = u.abs_end;
    }
    prev = u;
  }
  blocks.push([bs, be]);
  return blocks;
}

const overlap = (s: number, e: number, ws: number, we: number) => Math.max(0, Math.min(e, we) - Math.max(s, ws));
const leadInPart = ([s, e]: Block) => leadIn.reduce((acc, [ws, we]) => acc + overlap(s, e, ws, we), 0);
const hasMarker = ([s, e]: Block) => markerTs.some((m) => s - STRICT_LEAD_SEC <= m && m <= e);

function applyRule(blocks: Block[], rule: "A" | "B" | "C"): number {
  let total = 0;
  for (const b of blocks) {
    const len = b[1] - b[0];
    if (rule === "A") total += len;
    else if (rule === "B") total += len - leadInPart(b);
    else if (hasMarker(b)) total += len;
  }
  return total;
}

/** Which chunk a block belongs to, for the per-chunk table only. */
function chunkOf([s]: Block): string {
  const c = chunks.find((c) => c.audio_start <= s && s <= c.audio_end);
  return c ? c.chunk_id : "?";
}

interface RunTotals {
  dir: string;
  utterances: number;
  missing: string[];
  A: number;
  B: number;
  C: number;
  non_korean: number;
  target_speech_sum: number;
  all_speech_sum: number;
  by_language: Map<string, number>;
  per_chunk: Map<string, number>;
}

function summarizeRun(dirName: string): RunTotals {
  const dir = path.join(baseDir, dirName);
  const pooled: Utt[] = [];
  const missing: string[] = [];
  const byLang = new Map<string, number>();
  let targetSum = 0;
  let allSum = 0;
  for (const chunk of chunks) {
    const f = path.join(dir, `${chunk.chunk_id}.json`);
    if (!fs.existsSync(f)) {
      missing.push(chunk.chunk_id);
      continue;
    }
    const d = JSON.parse(fs.readFileSync(f, "utf-8"));
    for (const raw of d.utterances ?? []) {
      const u: Utt = {
        abs_start: Number(raw.abs_start),
        abs_end: Number(raw.abs_end),
        duration: Number(raw.duration) || 0,
        language: String(raw.language ?? "").trim(),
      };
      if (!Number.isFinite(u.abs_start) || !Number.isFinite(u.abs_end)) continue;
      pooled.push(u);
      allSum += u.duration;
      if (isTarget(u)) targetSum += u.duration;
      byLang.set(u.language, (byLang.get(u.language) ?? 0) + u.duration);
    }
  }
  const blocks = dialogueBlocks(pooled, isTarget);
  const perChunk = new Map<string, number>();
  for (const b of blocks) {
    const len = RULE === "A" ? b[1] - b[0] : RULE === "B" ? b[1] - b[0] - leadInPart(b) : hasMarker(b) ? b[1] - b[0] : 0;
    const id = chunkOf(b);
    perChunk.set(id, (perChunk.get(id) ?? 0) + len);
  }
  return {
    dir: dirName,
    utterances: pooled.length,
    missing,
    A: applyRule(blocks, "A"),
    B: applyRule(blocks, "B"),
    C: applyRule(blocks, "C"),
    non_korean: applyRule(dialogueBlocks(pooled, isNonKorean), RULE),
    target_speech_sum: targetSum,
    all_speech_sum: allSum,
    by_language: byLang,
    per_chunk: perChunk,
  };
}

const runs = runDirs.map(summarizeRun);
for (const r of runs) {
  if (r.missing.length) {
    console.error(`WARNING: ${r.dir} has no result for chunks ${r.missing.join(", ")} — its totals are incomplete`);
  }
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const n = runs.length;
const ruleMeans = { A: mean(runs.map((r) => r.A)), B: mean(runs.map((r) => r.B)), C: mean(runs.map((r) => r.C)) };
const billables = runs.map((r) => r[RULE]);
const billableMean = mean(billables);
const billableSd = sd(billables);
const billableSe = billableSd / Math.sqrt(n);

const chunkRows = chunks.map((c) => {
  const per = runs.map((r) => r.per_chunk.get(c.chunk_id) ?? 0);
  return {
    chunk_id: c.chunk_id,
    scene: c.scene,
    markers: c.marker_indices.length,
    billable_mean_sec: mean(per),
    billable_range_sec: Math.max(...per) - Math.min(...per),
  };
});

const langNames = new Set<string>();
for (const r of runs) for (const k of r.by_language.keys()) langNames.add(k);
const byLanguage: Record<string, number> = {};
for (const lang of langNames) byLanguage[lang] = mean(runs.map((r) => r.by_language.get(lang) ?? 0));

// --- report ---
const ts = (s: number) => formatTimestamp(Math.round(s));
const pad = (s: string | number, w: number) => String(s).padStart(w);
const pct = (x: number) => ((100 * x) / billableMean).toFixed(1) + "%";

console.error(`\n${"chunk".padEnd(9)}${pad("markers", 8)}${pad(`rule ${RULE}`, 9)}${pad("range", 7)}`);
for (const c of chunkRows) {
  console.error(`${c.chunk_id.padEnd(9)}${pad(c.markers, 8)}${pad(ts(c.billable_mean_sec), 9)}${pad(Math.round(c.billable_range_sec) + "s", 7)}`);
}

console.error(`\n${"pass".padEnd(18)}${pad("A: all", 8)}${pad("B: no lead-in", 15)}${pad("C: strict", 11)}${pad("utts", 6)}`);
for (const r of runs) {
  console.error(`${r.dir.padEnd(18)}${pad(ts(r.A), 8)}${pad(ts(r.B), 15)}${pad(ts(r.C), 11)}${pad(r.utterances, 6)}`);
}
if (n > 1) {
  console.error(`${"MEAN".padEnd(18)}${pad(ts(ruleMeans.A), 8)}${pad(ts(ruleMeans.B), 15)}${pad(ts(ruleMeans.C), 11)}`);
}

console.error(`\nby language (plain sum of utterance durations, mean of ${n} pass${n > 1 ? "es" : ""}):`);
for (const [lang, sec] of Object.entries(byLanguage).sort((a, b) => b[1] - a[1])) {
  console.error(`  ${lang.padEnd(18)} ${ts(sec)}`);
}

const ruleDesc = {
  A: "all foreign dialogue in scanned audio, discarded takes included",
  B: "foreign dialogue excluding speech before each chunk's first marker (discarded takes / lead-in)",
  C: "foreign dialogue in blocks a script marker lands in",
}[RULE];
console.error(`\nBILLABLE — rule ${RULE}, ${target}: ${ts(billableMean)}  = ${(billableMean / 60).toFixed(2)} min`);
console.error(`  ${ruleDesc}`);
console.error(`  dialogue = utterance spans + true pauses ≤${PAUSE_SEC}s, overlap once, chunks deduplicated`);
if (n > 1) {
  console.error(`  ${n} passes, sd ${Math.round(billableSd)}s (${pct(billableSd)}), standard error of the mean ${Math.round(billableSe)}s (${pct(billableSe)})`);
} else {
  console.error(`  single pass. For a tighter figure run stt_chunks.ts twice more into ${PREFIX}_2 and ${PREFIX}_3.`);
}
console.error(`  reference: plain sum of ${target} utterances (no pause credit, overlap double-counted)  ${ts(mean(runs.map((r) => r.target_speech_sum)))}`);
console.error(`  reference: non-Korean dialogue under rule ${RULE} (broad)                            ${ts(mean(runs.map((r) => r.non_korean)))}`);
console.error(`  all speech in scanned audio, every language                                       ${ts(mean(runs.map((r) => r.all_speech_sum)))}`);

const out = {
  hwpx_path: plan.hwpx_path,
  target_language: target,
  rule: RULE,
  definition: `rule ${RULE}: ${ruleDesc}; dialogue = union of ${target} utterance spans + true pauses <= ${PAUSE_SEC}s (no other speech in the gap), overlap once, chunks pooled onto one timeline`,
  pause_sec: PAUSE_SEC,
  billable_sec: Math.round(billableMean),
  billable_min: Math.round((billableMean / 60) * 100) / 100,
  n_passes: n,
  billable_sd_sec: Math.round(billableSd),
  billable_se_sec: Math.round(billableSe),
  rules_mean_sec: { A: Math.round(ruleMeans.A), B: Math.round(ruleMeans.B), C: Math.round(ruleMeans.C) },
  passes: runs.map((r) => ({
    dir: r.dir,
    A_sec: Math.round(r.A),
    B_sec: Math.round(r.B),
    C_sec: Math.round(r.C),
    non_korean_sec: Math.round(r.non_korean),
    target_speech_sum_sec: Math.round(r.target_speech_sum),
    all_speech_sum_sec: Math.round(r.all_speech_sum),
    utterances: r.utterances,
    missing_chunks: r.missing,
  })),
  markers: plan.total_markers,
  by_language: byLanguage,
  chunks: chunkRows,
};
const outPath = path.join(baseDir, "speech_duration.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.error(`\nWrote ${outPath}`);
console.log(
  JSON.stringify({
    rule: RULE,
    billable_min: out.billable_min,
    billable_sec: out.billable_sec,
    A_min: Math.round((ruleMeans.A / 60) * 100) / 100,
    B_min: Math.round((ruleMeans.B / 60) * 100) / 100,
    C_min: Math.round((ruleMeans.C / 60) * 100) / 100,
    n_passes: n,
    se_pct: n > 1 ? Math.round((1000 * billableSe) / billableMean) / 10 : null,
    target,
  }),
);
