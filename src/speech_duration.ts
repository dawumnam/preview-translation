import fs from "fs";
import path from "path";
import { formatTimestamp } from "./parser";
import type { Translation } from "./translate";

// Billable minutes for an episode, written to speech_duration.json next to
// the plan.
//
// Usage: bun src/speech_duration.ts <hwpx-dir>/chunks_plan.json [--prefix stt_results] [--rule A|B|C]
//
// BILLABLE = the audio each translation was written from. The mapper records,
// per marker, speech_start/speech_end — the absolute span of the STT lines it
// drew on. Billable is the union of those spans: the audio that had to be
// transcribed to produce the end result, counted once where markers share an
// exchange. Nothing is inferred — if a translation was written from it, it
// counts; if no translation was written from it (a discarded take, chatter
// the script never marked), it doesn't. Read from translations.json.
//
// REFERENCE figures come from the STT transcripts alone, before mapping, and
// are printed for comparison and for runs where step 4 hasn't happened yet:
// foreign-dialogue time under three attribution rules (A all foreign speech in
// the scanned audio, B excluding speech before each chunk's first marker,
// C only blocks a marker lands in), averaged over every stt_results*/ pass.
// See the comments at `dialogueBlocks` for the pause/overlap treatment.

const PAUSE_SEC = 2;
const LEAD_IN_GRACE_SEC = 5;
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
  console.error("Usage: bun src/speech_duration.ts <hwpx-dir>/chunks_plan.json [--prefix stt_results] [--rule A|B|C]");
  process.exit(1);
}

const LANG_NAME: Record<string, string> = { 영: "영어", 독: "독일어", 오: "독일어", 베: "베트남어" };

const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
const baseDir = path.dirname(path.resolve(planPath));
const chunks: any[] = [...plan.chunks].sort((a, b) => a.audio_start - b.audio_start);
const markerChunk = new Map<number, string>();
for (const c of chunks) for (const i of c.marker_indices) markerChunk.set(i, c.chunk_id);

const codes = [...new Set(chunks.flatMap((c) => c.markers.map((m: any) => m.language)))] as string[];
const targets = codes.map((c) => LANG_NAME[c]).filter(Boolean);
const target = targets.length ? targets.join("/") : "(non-Korean)";

const ts = (s: number) => formatTimestamp(Math.round(s));
const pad = (s: string | number, w: number) => String(s).padStart(w);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
type Span = [number, number];
function unionLength(spans: Span[]): number {
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cs = -Infinity;
  let ce = -Infinity;
  for (const [a, b] of s) {
    if (a > ce) {
      if (ce > cs) total += ce - cs;
      cs = a;
      ce = b;
    } else if (b > ce) {
      ce = b;
    }
  }
  if (ce > cs) total += ce - cs;
  return total;
}

// ---------------------------------------------------------------------------
// BILLABLE: union of the spans each translation was written from.
// ---------------------------------------------------------------------------
const translationsPath = path.join(baseDir, "translations.json");
interface MarkerSpan { markerIndex: number; charName: string; chunk: string; speech_start: number; speech_end: number; sec: number }
interface Billable { sec: number; markers: number; measured: number; zero: number; perChunk: Map<string, number>; perMarker: MarkerSpan[] }
let billable: Billable | null = null;

if (fs.existsSync(translationsPath)) {
  const all: Translation[] = JSON.parse(fs.readFileSync(translationsPath, "utf-8"));
  const spans: Span[] = [];
  const byChunk = new Map<string, Span[]>();
  const perMarker: MarkerSpan[] = [];
  let measured = 0;
  let zero = 0;
  for (const t of all) {
    if (typeof t.speech_start !== "number" || typeof t.speech_end !== "number") continue;
    measured++;
    const span: Span = [t.speech_start, Math.max(t.speech_start, t.speech_end)];
    if (span[1] - span[0] === 0) zero++;
    spans.push(span);
    const cid = markerChunk.get(t.markerIndex) ?? "?";
    if (!byChunk.has(cid)) byChunk.set(cid, []);
    byChunk.get(cid)!.push(span);
    perMarker.push({ markerIndex: t.markerIndex, charName: t.charName, chunk: cid, speech_start: span[0], speech_end: span[1], sec: span[1] - span[0] });
  }
  const perChunk = new Map<string, number>();
  for (const [cid, s] of byChunk) perChunk.set(cid, unionLength(s));
  billable = { sec: unionLength(spans), markers: all.length, measured, zero, perChunk, perMarker };
}

// ---------------------------------------------------------------------------
// REFERENCE: foreign-dialogue time from the STT transcripts, three rules.
// ---------------------------------------------------------------------------
interface Utt { abs_start: number; abs_end: number; duration: number; language: string }
const isNonKorean = (u: Utt) => u.language !== "한국어";
const isTarget = (u: Utt) => (targets.length === 0 ? isNonKorean(u) : targets.some((t) => u.language.includes(t)));
const markerTs = [...new Set(chunks.flatMap((c) => c.markers.map((m: any) => m.timestamp)))].sort((a, b) => a - b) as number[];
const leadIn: Span[] = chunks.map((c) => [c.audio_start, Math.min(...c.markers.map((m: any) => m.timestamp)) - LEAD_IN_GRACE_SEC]);

// Dialogue blocks: union of utterance spans (overlap once), bridging gaps of
// <= PAUSE_SEC between consecutive foreign lines when nothing else was said in
// the gap. All chunks are pooled first so overlapping buffers count once.
function dialogueBlocks(all: Utt[], pick: (u: Utt) => boolean): Span[] {
  const sel = all.filter(pick).sort((a, b) => a.abs_start - b.abs_start || a.abs_end - b.abs_end);
  if (sel.length === 0) return [];
  const others = all.filter((u) => !pick(u));
  const gapIsEmpty = (a: Utt, b: Utt) => !others.some((o) => o.abs_start < b.abs_start && o.abs_end > a.abs_end);
  const out: Span[] = [];
  let bs = sel[0].abs_start, be = sel[0].abs_end, prev = sel[0];
  for (const u of sel.slice(1)) {
    const gap = u.abs_start - be;
    if (gap <= 0 || (gap <= PAUSE_SEC && gapIsEmpty(prev, u))) be = Math.max(be, u.abs_end);
    else { out.push([bs, be]); bs = u.abs_start; be = u.abs_end; }
    prev = u;
  }
  out.push([bs, be]);
  return out;
}
const ov = (s: number, e: number, ws: number, we: number) => Math.max(0, Math.min(e, we) - Math.max(s, ws));
const leadInPart = ([s, e]: Span) => leadIn.reduce((acc, [ws, we]) => acc + ov(s, e, ws, we), 0);
const hasMarker = ([s, e]: Span) => markerTs.some((m) => s - STRICT_LEAD_SEC <= m && m <= e);
const applyRule = (blocks: Span[], rule: "A" | "B" | "C") =>
  blocks.reduce((t, b) => t + (rule === "A" ? b[1] - b[0] : rule === "B" ? b[1] - b[0] - leadInPart(b) : hasMarker(b) ? b[1] - b[0] : 0), 0);

interface RunRef { dir: string; utterances: number; missing: string[]; A: number; B: number; C: number; all_speech: number; by_language: Map<string, number> }
function summarizeRun(dirName: string): RunRef {
  const dir = path.join(baseDir, dirName);
  const pooled: Utt[] = [];
  const missing: string[] = [];
  const byLang = new Map<string, number>();
  let allSum = 0;
  for (const chunk of chunks) {
    const f = path.join(dir, `${chunk.chunk_id}.json`);
    if (!fs.existsSync(f)) { missing.push(chunk.chunk_id); continue; }
    for (const raw of JSON.parse(fs.readFileSync(f, "utf-8")).utterances ?? []) {
      const u: Utt = { abs_start: Number(raw.abs_start), abs_end: Number(raw.abs_end), duration: Number(raw.duration) || 0, language: String(raw.language ?? "").trim() };
      if (!Number.isFinite(u.abs_start) || !Number.isFinite(u.abs_end)) continue;
      pooled.push(u);
      allSum += u.duration;
      byLang.set(u.language, (byLang.get(u.language) ?? 0) + u.duration);
    }
  }
  const blocks = dialogueBlocks(pooled, isTarget);
  return { dir: dirName, utterances: pooled.length, missing, A: applyRule(blocks, "A"), B: applyRule(blocks, "B"), C: applyRule(blocks, "C"), all_speech: allSum, by_language: byLang };
}
const dirRe = new RegExp(`^${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(_\\d+)?$`);
const runDirs = fs.readdirSync(baseDir).filter((n) => dirRe.test(n)).sort((a, b) => a.length - b.length || a.localeCompare(b));
const runs = runDirs.map(summarizeRun);
for (const r of runs) if (r.missing.length) console.error(`WARNING: ${r.dir} has no result for chunks ${r.missing.join(", ")}`);
const refMeans = { A: mean(runs.map((r) => r.A)), B: mean(runs.map((r) => r.B)), C: mean(runs.map((r) => r.C)) };
const refSel = runs.map((r) => r[RULE]);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (billable) {
  console.error(`\n${"chunk".padEnd(9)}${pad("markers", 8)}${pad("billable", 10)}  scene`);
  for (const c of chunks) {
    console.error(`${c.chunk_id.padEnd(9)}${pad(c.marker_indices.length, 8)}${pad(ts(billable.perChunk.get(c.chunk_id) ?? 0), 10)}  ${c.scene}`);
  }
  console.error(`\nBILLABLE — audio the ${billable.markers} translations were written from (union of per-marker spans):`);
  console.error(`  ${ts(billable.sec)}  = ${(billable.sec / 60).toFixed(2)} min`);
  if (billable.measured < billable.markers) {
    console.error(`  WARNING: only ${billable.measured} of ${billable.markers} entries carry speech_start/speech_end — the rest are NOT counted. Re-run step 4 with the current mapper.`);
  }
  if (billable.zero) console.error(`  ${billable.zero} marker(s) have a zero-length span (no STT match; confidence should be "low") — worth a look`);
} else {
  console.error(`\nNo translations.json in ${baseDir} — step 4 (MAP) has not run, so there is no billable figure yet. Reference figures only.`);
}

if (runs.length) {
  console.error(`\nreference — ${target} dialogue in the STT transcripts, before mapping (${runs.length} pass${runs.length > 1 ? "es" : ""}):`);
  console.error(`  ${"".padEnd(18)}${pad("A: all", 8)}${pad("B: no lead-in", 15)}${pad("C: strict", 11)}${pad("utts", 6)}`);
  for (const r of runs) console.error(`  ${r.dir.padEnd(18)}${pad(ts(r.A), 8)}${pad(ts(r.B), 15)}${pad(ts(r.C), 11)}${pad(r.utterances, 6)}`);
  if (runs.length > 1) {
    console.error(`  ${"MEAN".padEnd(18)}${pad(ts(refMeans.A), 8)}${pad(ts(refMeans.B), 15)}${pad(ts(refMeans.C), 11)}   rule ${RULE} sd ${Math.round(sd(refSel))}s`);
  }
  console.error(`  all speech in scanned audio, every language: ${ts(mean(runs.map((r) => r.all_speech)))}`);
}

const out = {
  hwpx_path: plan.hwpx_path,
  target_language: target,
  definition: "union over markers of [speech_start, speech_end] from translations.json — the audio each translation was written from, shared spans counted once",
  billable_sec: billable ? Math.round(billable.sec * 10) / 10 : null,
  billable_min: billable ? Math.round((billable.sec / 60) * 100) / 100 : null,
  markers: billable?.markers ?? plan.total_markers,
  markers_measured: billable?.measured ?? 0,
  markers_zero_span: billable?.zero ?? 0,
  per_chunk: billable ? chunks.map((c) => ({ chunk_id: c.chunk_id, scene: c.scene, markers: c.marker_indices.length, billable_sec: Math.round((billable!.perChunk.get(c.chunk_id) ?? 0) * 10) / 10 })) : [],
  per_marker: billable?.perMarker ?? [],
  reference: {
    note: `${target} dialogue in STT transcripts before mapping; A all, B excluding lead-in before each chunk's first marker, C only blocks a marker lands in; pause<=${PAUSE_SEC}s, overlap once, chunks pooled`,
    passes: runs.map((r) => ({ dir: r.dir, A_sec: Math.round(r.A), B_sec: Math.round(r.B), C_sec: Math.round(r.C), all_speech_sec: Math.round(r.all_speech), utterances: r.utterances, missing_chunks: r.missing })),
    mean_sec: { A: Math.round(refMeans.A), B: Math.round(refMeans.B), C: Math.round(refMeans.C) },
  },
};
const outPath = path.join(baseDir, "speech_duration.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.error(`\nWrote ${outPath}`);
console.log(JSON.stringify({ billable_min: out.billable_min, billable_sec: out.billable_sec, markers_measured: out.markers_measured, of: out.markers, reference_min: { A: Math.round((refMeans.A / 60) * 100) / 100, B: Math.round((refMeans.B / 60) * 100) / 100, C: Math.round((refMeans.C / 60) * 100) / 100 }, target }));
