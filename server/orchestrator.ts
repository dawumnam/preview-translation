import fs from "fs";
import path from "path";
import { z } from "zod";
import { FunctionTool, InMemorySessionService, LlmAgent, Runner, getFunctionCalls, getFunctionResponses } from "@google/adk";
import { ROOT, type Job } from "./jobs";

// Agent orchestrator for one job, built on Google ADK.
//
// This plays the role Claude Code played when it ran the pipeline by hand:
// it does not just execute the steps in order, it looks at what each step
// produced, notices when something is off (a chunk no STT pass heard, a
// mapper that numbered its markers wrong, a translation span cut off at the
// chunk's audio edge) and takes the corrective action described in CLAUDE.md
// before moving on. The deterministic work stays in the CLI scripts; the
// agent's tools are thin, typed wrappers over them plus inspection helpers
// that summarise the work directory so the model never has to grep JSON.
//
// ADK runs tool calls one at a time, so anything that should run in parallel
// (STT passes, the per-chunk mappers) is parallel inside a single tool.

export const ORCHESTRATOR_MODEL = process.env.PT_ORCHESTRATOR_MODEL ?? "gemini-3.8-flash";
const MAX_LLM_CALLS = 200;
const MAX_NUDGES = 6;

export interface OrchestratorHooks {
  log: (line: string) => void;
  onStateChange: () => void; // tool finished → let the job re-derive its step statuses
  registerProc: (p: ReturnType<typeof Bun.spawn>) => void;
  unregisterProc: (p: ReturnType<typeof Bun.spawn>) => void;
  isCancelled: () => boolean;
  abortSignal: AbortSignal; // cancel → stops the model loop between calls
}
export interface OrchestratorResult {
  status: "done" | "failed";
  report: string;
  review: string[];
  llmCalls: number;
  tokens: { input: number; output: number; thoughts: number };
}

const STEP_IDS = ["convert", "plan", "extract", "stt", "merge_stt", "map", "merge_translations", "speech_duration", "apply"] as const;

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}
function exists(p: string) {
  return fs.existsSync(p);
}
function tenth(x: number) {
  return Math.round(x * 10) / 10;
}

export async function runOrchestrator(job: Job, hooks: OrchestratorHooks): Promise<OrchestratorResult> {
  const wd = path.dirname(job.files.hwpx);
  const plan = path.join(wd, "chunks_plan.json");
  const uploaded = path.join(wd, "chunks_uploaded.json");
  let result: OrchestratorResult | null = null;
  const tokens = { input: 0, output: 0, thoughts: 0 };
  let llmCalls = 0;

  // ------------------------------------------------------------ helpers

  const inside = (rel: string) => {
    const abs = path.resolve(wd, rel);
    if (abs !== wd && !abs.startsWith(wd + path.sep)) throw new Error(`path escapes the work directory: ${rel}`);
    return abs;
  };

  async function runProcess(label: string, cmd: string[]): Promise<{ ok: boolean; exit_code: number; seconds: number; log_tail: string[]; stdout: string }> {
    if (hooks.isCancelled()) throw new Error("cancelled");
    const t0 = Date.now();
    const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
    hooks.registerProc(proc);
    const lines: string[] = [];
    let stdout = "";
    const pipe = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        if (isStdout) stdout += text;
        buf += text;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
          buf = buf.slice(nl + 1);
          if (line.trim()) {
            hooks.log(`[${label}] ${line}`);
            lines.push(line);
          }
        }
      }
      if (buf.trim()) {
        const line = buf.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
        hooks.log(`[${label}] ${line}`);
        lines.push(line);
      }
    };
    await Promise.all([pipe(proc.stdout, true), pipe(proc.stderr, false)]);
    const code = await proc.exited;
    hooks.unregisterProc(proc);
    if (hooks.isCancelled()) throw new Error("cancelled");
    return { ok: code === 0, exit_code: code, seconds: Math.round((Date.now() - t0) / 1000), log_tail: lines.slice(-30), stdout };
  }

  const passDirs = () =>
    exists(wd)
      ? fs
          .readdirSync(wd)
          .filter((n) => /^stt_results(_\d+)?$/.test(n))
          .sort((a, b) => a.length - b.length || a.localeCompare(b))
      : [];
  const expectedPassDirs = () => Array.from({ length: job.options.sttPasses }, (_, i) => (i === 0 ? "stt_results" : `stt_results_${i + 1}`));

  function sttFileSummary(file: string) {
    if (!exists(file)) return null;
    try {
      const j = readJson(file);
      if (!Array.isArray(j.utterances) || j.utterances.length === 0) return null;
      return { utterances: j.utterances.length, foreign_speech_sec: j.foreign_speech_sec ?? 0 };
    } catch {
      return null;
    }
  }

  function inspect() {
    const out: any = { work_dir: wd, script: { hwpx: exists(job.files.hwpx), hwp: job.files.original ? exists(job.files.original) : undefined }, warnings: [] as string[] };
    if (!exists(plan)) {
      out.plan = null;
      return out;
    }
    const p = readJson(plan);
    const ids: string[] = p.chunks.map((c: any) => c.chunk_id);
    out.plan = {
      total_markers: p.total_markers,
      chunks: p.chunks.map((c: any) => ({ chunk_id: c.chunk_id, scene: c.scene, markers: c.marker_indices.length, marker_indices: `${c.marker_indices[0]}..${c.marker_indices[c.marker_indices.length - 1]}`, audio_start: c.audio_start, audio_end: c.audio_end, first_marker_sec: c.start_sec, last_marker_sec: c.end_sec })),
    };
    if (exists(uploaded)) {
      const u = readJson(uploaded);
      const withUri = u.chunks.filter((c: any) => c.uri).map((c: any) => c.chunk_id);
      out.uploaded = { chunks_with_uri: withUri.length, chunks_total: u.chunks.length, missing: ids.filter((i) => !withUri.includes(i)) };
    } else out.uploaded = null;

    out.stt_passes = passDirs().map((dir) => {
      const per: Record<string, any> = {};
      const missing: string[] = [];
      for (const id of ids) {
        const s = sttFileSummary(path.join(wd, dir, `${id}.json`));
        if (s) per[id] = s;
        else missing.push(id);
      }
      return { dir, missing, per_chunk: per };
    });
    out.stt_passes_requested = job.options.sttPasses;
    const incomplete = out.stt_passes.filter((p: any) => p.missing.length);
    if (out.stt_passes.length < job.options.sttPasses) out.warnings.push(`only ${out.stt_passes.length} of ${job.options.sttPasses} STT pass directories exist`);
    for (const p of incomplete) out.warnings.push(`${p.dir} is missing chunks ${p.missing.join(", ")}`);

    const mergedDir = path.join(wd, "stt_results_merged");
    if (exists(mergedDir)) {
      const per: Record<string, any> = {};
      const missing: string[] = [];
      for (const id of ids) {
        const f = path.join(mergedDir, `${id}.json`);
        if (!exists(f)) {
          missing.push(id);
          continue;
        }
        const j = readJson(f);
        per[id] = { utterances: j.utterances?.length ?? 0, foreign_speech_sec: j.foreign_speech_sec ?? 0, passes: j.passes?.length ?? 0 };
        const chunk = p.chunks.find((c: any) => c.chunk_id === id);
        if ((j.foreign_speech_sec ?? 0) < 1 && chunk?.marker_indices.length) out.warnings.push(`chunk ${id} has ${chunk.marker_indices.length} markers but only ${j.foreign_speech_sec ?? 0}s of foreign speech in the merged STT`);
      }
      out.merged = { missing, per_chunk: per };
    } else out.merged = null;

    const trDir = path.join(wd, "translations");
    if (exists(trDir)) {
      const per: Record<string, any> = {};
      const missing: string[] = [];
      for (const c of p.chunks) {
        const f = path.join(trDir, `${c.chunk_id}.json`);
        if (!exists(f)) {
          missing.push(c.chunk_id);
          continue;
        }
        try {
          const arr: any[] = readJson(f);
          const idx = arr.map((t) => t.markerIndex);
          const expected: number[] = c.marker_indices;
          const wrong = idx.filter((i) => !expected.includes(i));
          const absent = expected.filter((i) => !idx.includes(i));
          const conf = { high: 0, medium: 0, low: 0 } as Record<string, number>;
          for (const t of arr) conf[t.confidence ?? "medium"] = (conf[t.confidence ?? "medium"] ?? 0) + 1;
          per[c.chunk_id] = { entries: arr.length, expected: expected.length, ok: wrong.length === 0 && absent.length === 0, wrong_marker_indices: wrong.slice(0, 10), missing_marker_indices: absent.slice(0, 10), confidence: conf };
          if (wrong.length || absent.length) out.warnings.push(`translations/${c.chunk_id}.json does not cover exactly this chunk's markers (wrong: ${wrong.length}, missing: ${absent.length}) — re-run map for it with force`);
        } catch (e: any) {
          per[c.chunk_id] = { error: e.message };
        }
      }
      out.translations = { missing, per_chunk: per };
    } else out.translations = null;

    const trJson = path.join(wd, "translations.json");
    if (exists(trJson)) {
      const arr: any[] = readJson(trJson);
      const conf = { high: 0, medium: 0, low: 0 } as Record<string, number>;
      for (const t of arr) conf[t.confidence ?? "medium"] = (conf[t.confidence ?? "medium"] ?? 0) + 1;
      out.translations_json = { entries: arr.length, expected: p.total_markers, confidence: conf, multi_segment: arr.filter((t) => (t.segments?.length ?? 0) > 1).length };
    } else out.translations_json = null;

    const sd = path.join(wd, "speech_duration.json");
    if (exists(sd)) {
      const b = readJson(sd);
      const long = (b.per_marker ?? []).filter((m: any) => m.sec > 30).map((m: any) => ({ markerIndex: m.markerIndex, charName: m.charName, chunk: m.chunk, sec: Math.round(m.sec), speech_start: m.speech_start }));
      out.billing = { billable_min: b.billable_min, markers_measured: b.markers_measured, markers: b.markers, zero_span: b.markers_zero_span, unsupported_span: b.markers_unsupported_span, at_chunk_edge: b.markers_at_chunk_edge, long_spans_over_30s: long, reference_min: b.reference?.mean_sec ? { A: tenth(b.reference.mean_sec.A / 60), B: tenth(b.reference.mean_sec.B / 60), C: tenth(b.reference.mean_sec.C / 60) } : null };
      if (b.markers_at_chunk_edge?.length) out.warnings.push(`spans touching a chunk's audio edge (exchange may be cut off): markers ${b.markers_at_chunk_edge.join(", ")}`);
    } else out.billing = null;

    const outFile = job.files.hwpx.replace(/\.hwpx$/, "_translated.hwpx");
    out.output = exists(outFile) ? { file: path.basename(outFile), modified: fs.statSync(outFile).mtime.toISOString() } : null;
    return out;
  }

  // ------------------------------------------------------------ tools

  const inspectTool = new FunctionTool({
    name: "inspect_work_dir",
    description: "Summarise the job's work directory: which pipeline outputs exist and whether they are complete (plan chunks, upload URIs, per-pass STT results, merged STT, per-chunk translations, translations.json, billing figures, translated HWPX), plus computed warnings. Call this first, and again after any step whose outcome you need to judge.",
    execute: async () => {
      const r = inspect();
      hooks.onStateChange();
      return r;
    },
  });

  const runStepTool = new FunctionTool({
    name: "run_step",
    description:
      "Run one pipeline step as a subprocess and return its exit code and the tail of its log. Steps: " +
      "convert (.hwp → .hwpx, only when the script arrived as .hwp); plan (parse markers, write chunks_plan.json); " +
      "extract (ffmpeg-cut each chunk's audio and upload it to Gemini; skips chunks already done; writes chunks_uploaded.json); " +
      "stt (transcribe every chunk into the given pass directories, all passes running in parallel; a pass skips chunks that already have a result, so re-running fills gaps); " +
      "merge_stt (union of all stt_results* passes → stt_results_merged/); " +
      "map (Gemini mapper: one call per chunk in parallel, writes translations/<chunk>.json; skips chunks already done unless force; use only=[...] to redo specific chunks); " +
      "merge_translations (validate + merge → translations.json; fails if a chunk's markers are wrong or missing); " +
      "speech_duration (billing figure → speech_duration.json); apply (write <name>_translated.hwpx).",
    parameters: z.object({
      step: z.enum(STEP_IDS),
      pass_dirs: z.array(z.string()).optional().describe("stt only: pass directories to run, e.g. [\"stt_results\",\"stt_results_2\"]. Default: all requested passes."),
      only: z.array(z.string()).optional().describe("map only: chunk ids to (re)map"),
      force: z.boolean().optional().describe("map only: overwrite existing translations for the selected chunks"),
    }),
    execute: async ({ step, pass_dirs, only, force }) => {
      const bun = (script: string, ...args: string[]) => ["bun", path.join(ROOT, "src", script), ...args];
      let r;
      switch (step) {
        case "convert":
          if (!job.files.original) return { ok: false, error: "script did not arrive as .hwp; nothing to convert" };
          r = await runProcess("convert", [path.join(ROOT, "tools/hwp2hwpx/convert.sh"), job.files.original, job.files.hwpx]);
          break;
        case "plan":
          r = await runProcess("plan", bun("plan_chunks.ts", job.files.hwpx, job.files.media!));
          break;
        case "extract":
          r = await runProcess("extract", bun("extract_chunks.ts", exists(uploaded) ? uploaded : plan));
          break;
        case "stt": {
          const dirs = pass_dirs?.length ? pass_dirs : expectedPassDirs();
          const bad = dirs.filter((d) => !/^stt_results(_\d+)?$/.test(d));
          if (bad.length) return { ok: false, error: `pass_dirs must look like stt_results or stt_results_N: ${bad.join(", ")}` };
          const results = await Promise.all(dirs.map((d, i) => runProcess(`stt ${d}`, bun("stt_chunks.ts", uploaded, d))));
          r = { ok: results.every((x) => x.ok), exit_code: Math.max(...results.map((x) => x.exit_code)), seconds: Math.max(...results.map((x) => x.seconds)), log_tail: results.flatMap((x, i) => x.log_tail.slice(-8).map((l) => `[${dirs[i]}] ${l}`)), stdout: "" };
          break;
        }
        case "merge_stt":
          r = await runProcess("merge_stt", bun("merge_stt.ts", plan));
          break;
        case "map": {
          const args = [plan, "--concurrency", String(job.options.mapConcurrency)];
          if (only?.length) args.push("--only", only.join(","));
          if (force) args.push("--force");
          r = await runProcess("map", bun("map_chunks.ts", ...args));
          break;
        }
        case "merge_translations":
          r = await runProcess("merge", bun("merge_translations.ts", plan));
          break;
        case "speech_duration":
          r = await runProcess("billing", bun("speech_duration.ts", plan));
          break;
        case "apply":
          r = await runProcess("apply", bun("apply.ts", job.files.hwpx, path.join(wd, "translations.json")));
          break;
      }
      hooks.onStateChange();
      const { stdout, ...rest } = r;
      const last = stdout.trim().split("\n").filter(Boolean).pop();
      return last ? { ...rest, stdout_last_line: last } : rest;
    },
  });

  const readFileTool = new FunctionTool({
    name: "read_file",
    description: "Read a text/JSON file inside the work directory (path relative to it), e.g. stt_results_merged/03.json or translations/03.json. Returns at most max_chars characters starting at offset. Use it to look at the actual utterances or translations when the summaries are not enough.",
    parameters: z.object({
      path: z.string(),
      max_chars: z.number().int().min(200).max(60000).optional(),
      offset: z.number().int().min(0).optional(),
    }),
    execute: async ({ path: rel, max_chars, offset }) => {
      const abs = inside(rel);
      if (!exists(abs) || fs.statSync(abs).isDirectory()) return { error: `no such file: ${rel}` };
      const text = fs.readFileSync(abs, "utf-8");
      const start = offset ?? 0;
      const max = max_chars ?? 20000;
      return { path: rel, total_chars: text.length, offset: start, content: text.slice(start, start + max), truncated: start + max < text.length };
    },
  });

  const deleteTool = new FunctionTool({
    name: "delete_outputs",
    description: "Delete files or directories inside the work directory so a step redoes that work (each step skips outputs that already exist). Typical use: delete stt_results_2/03.json to re-transcribe one chunk in one pass, or translations/03.json to re-map it. The script, media, chunks_plan.json and chunks_uploaded.json cannot be deleted (use widen_chunk to change a chunk).",
    parameters: z.object({ paths: z.array(z.string()).min(1) }),
    execute: async ({ paths }) => {
      const deleted: string[] = [];
      const refused: string[] = [];
      for (const rel of paths) {
        const abs = inside(rel);
        const base = path.basename(abs);
        if (abs === job.files.hwpx || abs === job.files.original || abs === job.files.media || base === "chunks_plan.json" || base === "chunks_uploaded.json" || abs === wd) {
          refused.push(rel);
          continue;
        }
        if (exists(abs)) {
          fs.rmSync(abs, { recursive: true, force: true });
          deleted.push(rel);
        }
      }
      hooks.log(`[orchestrator] deleted ${deleted.join(", ") || "nothing"}${refused.length ? ` (refused: ${refused.join(", ")})` : ""}`);
      hooks.onStateChange();
      return { deleted, refused };
    },
  });

  const widenTool = new FunctionTool({
    name: "widen_chunk",
    description: "Enlarge one chunk's audio window when a translation's speech span touches the chunk's audio edge (the fixed 60s buffer cut the exchange off). Updates audio_start/audio_end in chunks_plan.json and chunks_uploaded.json, drops the chunk's upload URI, and deletes its audio file, STT results in every pass, merged STT and translation, so that extract → stt → merge_stt → map(only=[chunk], force) → merge_translations → speech_duration → apply redo just that chunk.",
    parameters: z.object({
      chunk_id: z.string(),
      extra_before_sec: z.number().min(0).max(600).optional().describe("seconds to add before audio_start (default 0)"),
      extra_after_sec: z.number().min(0).max(600).optional().describe("seconds to add after audio_end (default 120)"),
    }),
    execute: async ({ chunk_id, extra_before_sec, extra_after_sec }) => {
      const before = extra_before_sec ?? 0;
      const after = extra_after_sec ?? 120;
      const files = [plan, uploaded].filter(exists);
      let range: any = null;
      for (const f of files) {
        const j = readJson(f);
        const c = j.chunks.find((x: any) => x.chunk_id === chunk_id);
        if (!c) return { error: `no chunk ${chunk_id}` };
        c.audio_start = Math.max(0, c.audio_start - before);
        c.audio_end = c.audio_end + after;
        delete c.uri;
        delete c.mimeType;
        range = { audio_start: c.audio_start, audio_end: c.audio_end };
        fs.writeFileSync(f, JSON.stringify(j, null, 2));
      }
      const removed: string[] = [];
      const candidates = [path.join(wd, "chunks", `${chunk_id}.mp3`), ...passDirs().map((d) => path.join(wd, d, `${chunk_id}.json`)), path.join(wd, "stt_results_merged", `${chunk_id}.json`), path.join(wd, "translations", `${chunk_id}.json`)];
      for (const f of candidates) {
        if (exists(f)) {
          fs.rmSync(f);
          removed.push(path.relative(wd, f));
        }
      }
      hooks.log(`[orchestrator] widened chunk ${chunk_id} to ${range?.audio_start}–${range?.audio_end}s; removed ${removed.join(", ")}`);
      hooks.onStateChange();
      return { chunk_id, ...range, removed, next: ["extract", "stt", "merge_stt", `map only=[${chunk_id}] force`, "merge_translations", "speech_duration", "apply"] };
    },
  });

  const finishTool = new FunctionTool({
    name: "finish",
    description: "End the job. Call with status 'done' only when <name>_translated.hwpx has been written from a translations.json that covers every marker. Call with status 'failed' when a step keeps failing for the same reason and you cannot fix it with the tools you have. The report is shown to the editor.",
    parameters: z.object({
      status: z.enum(["done", "failed"]),
      report: z.string().describe("A short plain-language report: what was produced, marker and billable-minute figures, what was retried or fixed along the way, and what a human should review. Korean or English."),
      review: z.array(z.string()).optional().describe("Specific items an editor should look at, e.g. 'marker 21 (검여) span 83s — one continuous explanation, verified'"),
    }),
    execute: async ({ status, report, review }) => {
      result = { status, report, review: review ?? [], llmCalls, tokens };
      hooks.log(`[orchestrator] finish(${status}): ${report}`);
      return { ok: true };
    },
  });

  // ------------------------------------------------------------ agent

  const instruction = `You orchestrate a translation pipeline for a Korean variety-show production script. The script (HWPX) contains @@ markers where a cast member speaks a foreign language; the deliverable is the same script with a Korean translation written into every marker, plus a billing figure (minutes of audio the translations were written from). You work on one job's work directory with the tools provided. Nobody is watching in real time: decide and act, never ask questions.

## Pipeline (each step is a CLI script; outputs land next to the HWPX in the work directory)
1. convert — only if the script arrived as .hwp (script.hwp present, no .hwpx).
2. plan → chunks_plan.json: markers grouped into audio chunks (≤5 min each, 60s buffer both sides).
3. extract → chunks/<id>.mp3 + upload to Gemini → chunks_uploaded.json (every chunk needs a uri).
4. stt → stt_results/, stt_results_2/, … one directory per pass. The job asks for N passes: run them all in ONE run_step(stt) call (they run in parallel). A single pass misses quiet lines under noise that other passes hear, which is why several passes are merged.
5. merge_stt → stt_results_merged/<id>.json (union of passes, with heard_by counts).
6. map → translations/<id>.json: one Gemini mapper per chunk reads the merged transcript and writes a translation per marker with the audio span (speech_start/speech_end) it was written from.
7. merge_translations → translations.json (refuses if any chunk's markers are missing or numbered wrong).
8. speech_duration → speech_duration.json (billable minutes = union of the spans).
9. apply → <name>_translated.hwpx.

## How to work
- Start with inspect_work_dir. Outputs that already exist are from an earlier attempt: every step skips finished work, so simply continue from the first incomplete step. Do not delete good outputs.
- After stt: inspect. Every requested pass directory must have a result for every chunk; run_step(stt) again for the passes that have gaps (it only fills the gaps). If a chunk still has no result in any pass after a retry, continue without it but mention it in the report.
- After merge_stt: a chunk that has markers but under ~1s of foreign speech in the merged transcript is suspicious (the passes may have failed on it). Look at the per-pass figures; if the passes disagree wildly or a pass has near-zero utterances for that chunk, delete that pass's file for the chunk and re-run stt, then merge_stt again. If every pass agrees there is no foreign speech, accept it — the mapper will mark those markers low confidence.
- After map: inspect. A chunk whose translations file has wrong or missing marker indices must be re-mapped: run_step(map, only=[id], force=true). If merge_translations fails, read its log tail, fix the offending chunk the same way, and merge again.
- After speech_duration: inspect the billing summary. A span that touches a chunk's audio edge means the exchange was cut off by the buffer: widen_chunk (default +120s after; add time before instead if speech_start sits at audio_start), then extract → stt → merge_stt → map(only, force) → merge_translations → speech_duration → apply for that chunk. Do this at most once per chunk. Zero-length spans and spans over 30s are not errors; list them for review in the report.
- Then apply. The job is done when the translated HWPX exists and translations.json covers every marker. Call finish(status='done') with a report that states markers, billable minutes, confidence counts, what you retried or fixed, and the review items. If a step fails twice for the same reason (missing API key, ffmpeg error, upload failure, model refusing), call finish(status='failed') with the error — do not loop.
- Keep your own messages short; the log is read by editors. Tool results are truncated to their tails: use read_file when you need the real content.`;

  const agent = new LlmAgent({
    name: "pipeline_orchestrator",
    description: "Runs the HWPX translation pipeline for one job and fixes what goes wrong.",
    model: ORCHESTRATOR_MODEL,
    instruction,
    tools: [inspectTool, runStepTool, readFileTool, deleteTool, widenTool, finishTool],
    generateContentConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: "HIGH" as any } },
  });

  const sessionService = new InMemorySessionService();
  const appName = "preview-translation";
  const userId = "web";
  const session = await sessionService.createSession({ appName, userId, sessionId: job.id });
  const runner = new Runner({ appName, agent, sessionService });

  const task = `Job "${job.name}".
Work directory: ${wd}
Script: ${path.basename(job.files.hwpx)}${job.files.original ? ` (arrived as ${path.basename(job.files.original)} — convert first if the .hwpx is missing)` : ""}
Media: ${job.files.media}
STT passes requested: ${job.options.sttPasses} (${expectedPassDirs().join(", ")})
Run the pipeline to completion and call finish.`;

  const brief = (v: unknown, n = 160) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + "…" : s;
  };

  async function turn(text: string) {
    for await (const event of runner.runAsync({ userId, sessionId: session.id, newMessage: { role: "user", parts: [{ text }] }, abortSignal: hooks.abortSignal, runConfig: { maxLlmCalls: MAX_LLM_CALLS } })) {
      if (hooks.isCancelled()) throw new Error("cancelled");
      if (event.usageMetadata) {
        llmCalls++;
        tokens.input += event.usageMetadata.promptTokenCount ?? 0;
        tokens.output += event.usageMetadata.candidatesTokenCount ?? 0;
        tokens.thoughts += event.usageMetadata.thoughtsTokenCount ?? 0;
      }
      if (event.errorMessage) hooks.log(`[orchestrator] model error: ${event.errorCode ?? ""} ${event.errorMessage}`);
      if (event.partial) continue;
      for (const part of event.content?.parts ?? []) {
        if (part.text && !part.thought && event.author !== "user") hooks.log(`[orchestrator] ${part.text.trim()}`);
      }
      for (const fc of getFunctionCalls(event)) {
        if (fc.name !== "inspect_work_dir") hooks.log(`[orchestrator → ${fc.name}] ${brief(fc.args ?? {})}`);
        else hooks.log(`[orchestrator → inspect_work_dir]`);
      }
      for (const fr of getFunctionResponses(event)) {
        if (fr.name === "run_step") {
          const r: any = fr.response ?? {};
          hooks.log(`[${fr.name} ✓] ${r.ok ? "ok" : `FAILED exit ${r.exit_code}`}${r.seconds != null ? ` in ${r.seconds}s` : ""}${r.error ? ` — ${r.error}` : ""}`);
        } else if (fr.name === "inspect_work_dir") {
          const r: any = fr.response ?? {};
          hooks.log(`[inspect ✓] ${r.warnings?.length ? `warnings: ${r.warnings.join(" | ")}` : "no warnings"}`);
        }
      }
    }
  }

  hooks.log(`[orchestrator] model ${ORCHESTRATOR_MODEL}, up to ${MAX_LLM_CALLS} model calls`);
  await turn(task);
  for (let nudge = 0; !result && nudge < MAX_NUDGES; nudge++) {
    if (hooks.isCancelled()) throw new Error("cancelled");
    hooks.log(`[orchestrator] model stopped without calling finish — asking it to continue (${nudge + 1}/${MAX_NUDGES})`);
    await turn("You have not called finish yet. Call inspect_work_dir, continue from the first incomplete step, and call finish when the translated HWPX exists (or with status 'failed' if you are stuck).");
  }
  if (!result) {
    return { status: "failed", report: `The orchestrator stopped without finishing after ${MAX_NUDGES} reminders. Retry resumes from the current state.`, review: [], llmCalls, tokens };
  }
  return result;
}

// Step statuses derived from what is on disk, so the UI shows real progress
// whoever is driving the work directory.
export function deriveSteps(job: Job): { id: string; done: boolean; detail?: string }[] {
  const wd = path.dirname(job.files.hwpx);
  const plan = path.join(wd, "chunks_plan.json");
  const p = exists(plan) ? readJson(plan) : null;
  const ids: string[] = p ? p.chunks.map((c: any) => c.chunk_id) : [];
  const steps: { id: string; done: boolean; detail?: string }[] = [];
  if (job.files.original) steps.push({ id: "convert", done: exists(job.files.hwpx) });
  steps.push({ id: "plan", done: !!p, detail: p ? `${p.total_markers} markers in ${p.total_chunks} chunks` : undefined });
  const uploaded = path.join(wd, "chunks_uploaded.json");
  let up = 0;
  if (exists(uploaded)) up = readJson(uploaded).chunks.filter((c: any) => c.uri).length;
  steps.push({ id: "extract", done: ids.length > 0 && up >= ids.length, detail: up ? `${up}/${ids.length} chunks uploaded` : undefined });
  const dirs = exists(wd) ? fs.readdirSync(wd).filter((n) => /^stt_results(_\d+)?$/.test(n)) : [];
  let complete = 0;
  let files = 0;
  for (const d of dirs) {
    const have = ids.filter((id) => {
      const f = path.join(wd, d, `${id}.json`);
      try {
        return exists(f) && (readJson(f).utterances?.length ?? 0) > 0;
      } catch {
        return false;
      }
    }).length;
    files += have;
    if (ids.length && have === ids.length) complete++;
  }
  steps.push({ id: "stt", done: ids.length > 0 && complete >= job.options.sttPasses, detail: files ? `${complete}/${job.options.sttPasses} passes complete (${files} chunk results)` : undefined });
  const merged = ids.filter((id) => exists(path.join(wd, "stt_results_merged", `${id}.json`))).length;
  steps.push({ id: "merge_stt", done: ids.length > 0 && merged === ids.length, detail: merged ? `${merged}/${ids.length} chunks` : undefined });
  const tr = ids.filter((id) => exists(path.join(wd, "translations", `${id}.json`))).length;
  steps.push({ id: "map", done: ids.length > 0 && tr === ids.length, detail: tr ? `${tr}/${ids.length} chunks` : undefined });
  steps.push({ id: "merge", done: exists(path.join(wd, "translations.json")) });
  const sd = path.join(wd, "speech_duration.json");
  steps.push({ id: "billing", done: exists(sd), detail: exists(sd) && readJson(sd).billable_min != null ? `${readJson(sd).billable_min} min billable` : undefined });
  const out = job.files.hwpx.replace(/\.hwpx$/, "_translated.hwpx");
  steps.push({ id: "apply", done: exists(out), detail: exists(out) ? path.basename(out) : undefined });
  return steps;
}
