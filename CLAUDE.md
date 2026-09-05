# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## HWPX Translation Pipeline

Korean variety show production script translator. The HWPX document contains a script with `@@(영)` / `@@(독)` / `@@(오)` markers where foreign-language speech (English/German/Austrian German) needs Korean translations inserted.

## Architecture

Claude Code is the **orchestrator**. Deterministic steps are CLI scripts; the intelligent mapping step (STT → marker assignment) is delegated to parallel `mapper` subagents.

## HWP input

If the script arrives as `.hwp` (not `.hwpx`), convert it first:

```bash
tools/hwp2hwpx/convert.sh <input.hwp>   # writes <input>.hwpx next to it
```

Uses the bundled [hwp2hwpx](https://github.com/neolord0/hwp2hwpx) Java sources (`tools/hwp2hwpx/upstream/`). First run auto-builds: downloads hwplib/hwpxlib jars from Maven Central and compiles with the Homebrew OpenJDK (`/opt/homebrew/opt/openjdk` — `brew install openjdk` if missing).

## Pipeline

All intermediate outputs are written next to the input HWPX file (not CWD). Paths in plan JSON are absolute, so steps can resume from any working directory.

```
1. PLAN      bun src/plan_chunks.ts <hwpx> <mp3|mp4>
              → <hwpx-dir>/chunks_plan.json

2. EXTRACT   bun src/extract_chunks.ts <hwpx-dir>/chunks_plan.json
              → <hwpx-dir>/chunks/ + <hwpx-dir>/chunks_uploaded.json

3. STT       bun src/stt_chunks.ts <hwpx-dir>/chunks_uploaded.json [stt_results_N]
              → <hwpx-dir>/stt_results/*.json   (run 3–5 passes: stt_results_2, _3, ...)

3b. MERGE STT bun src/merge_stt.ts <hwpx-dir>/chunks_plan.json
              → <hwpx-dir>/stt_results_merged/*.json   (union of all passes)

4. MAP       Orchestrator spawns one mapper agent per chunk in parallel
              → <hwpx-dir>/translations/<chunk_id>.json (per chunk)

5. MERGE     bun src/merge_translations.ts <hwpx-dir>/chunks_plan.json
              → <hwpx-dir>/translations.json

6. APPLY     bun src/apply.ts <hwpx> <hwpx-dir>/translations.json
              → <hwpx-dir>/<name>_translated.hwpx
```

Steps 2-3 support resume: already-extracted chunks and STT results are skipped on re-run.
Step 4 supports resume: chunks with existing `translations/<chunk_id>.json` are skipped on re-run.

### Step 4 detail — MAP

The orchestrator handles this directly (no skill needed):
1. Greps `chunks_plan.json` for `"chunk_id"` values
2. Spawns one `mapper` agent per chunk **in parallel** (subagent_type: "mapper"), passing file paths + chunk_id
3. Each agent reads its own chunk data from `chunks_plan.json` and `stt_results_merged/<chunk_id>.json` — never a single pass: quiet lines under noise are heard by one pass in five, and on 0825 six markers' speech was missed by the pass the mappers first read
4. Each agent matches speech to markers and writes `translations/<chunk_id>.json`
5. After all agents complete, orchestrator runs `bun src/merge_translations.ts` to merge + validate

The `mapper` agent (`.claude/agents/mapper.md`) processes a single chunk:
- Reads its own data files (chunks_plan.json + stt_results) — orchestrator does not pre-read them
- Reads markers + STT transcript together — no timestamp arithmetic needed (`abs_start` is pre-resolved)
- Uses STT-provided Korean translations as a starting point
- Improves translations using surrounding Korean dialogue context
- Splits long translations into TC segments so no segment covers more than 20s of audio (cut at utterance/sentence boundaries, as few and as balanced as the cap allows; segment timestamps are the `abs_start` of the matching utterance — including segment 1, never the marker's hand-typed TC)
- Writes `[{markerIndex, language, charName, timestamp, scene, segments: [{timestamp, text}], confidence}]` to `translations/<chunk_id>.json`

### Step 3 detail — STT output

`stt_chunks.ts` uses a Gemini `responseSchema`, so every chunk comes back in the
same shape rather than whatever markdown the model felt like emitting:

```json
{
  "chunk_id": "03", "scene": "...", "audio_start": 1355,
  "marker_range": [1415, 1415], "markers": [38, 39, 40, 41],
  "speech_sec": 35, "foreign_speech_sec": 7,
  "utterances": [
    { "start": "01:01.3", "end": "01:03.1", "start_sec": 61.3, "end_sec": 63.1,
      "abs_start": 1416.3, "abs_end": 1418.1, "duration": 1.8,
      "speaker": "큐", "language": "베트남어",
      "text": "À, chào chị...", "translation": "아, 안녕하세요..." }
  ]
}
```

`abs_start` / `abs_end` are already offset by `audio_start`, so mappers use them
directly. `foreign_speech_sec` sums every utterance whose `language` is not
plain `한국어`, which makes "how much speech actually needs translating"
a measured number rather than an estimate from script TCs.

### Billing accuracy

**What counts: the audio each translation was written from.** The mapper
records `speech_start` / `speech_end` per marker — the absolute span of the
STT lines it drew on. `speech_duration.ts` bills the union of those spans:
the audio that had to be transcribed to produce the end result, counted once
where markers share an exchange. Nothing is inferred. If a translation was
written from it, it counts; a discarded take or chatter the script never
marked produces no translation and is not counted. Read from
`translations.json`, so it exists only after step 4.

For reference the tool also prints foreign-dialogue time straight from the
STT transcripts under three attribution rules (A everything foreign in the
scanned audio, B minus speech before each chunk's first marker, C only blocks
a marker lands in — 10:17 / 8:24 / 7:02 on 0825, three tenths passes). Those
are estimates of the same thing from the other direction; the mapper's spans
are the figure to invoice. On 0825 a single-pass run gave 6:38 for 105
markers with 6 "silent" markers billing zero — and those six turned out to be
quiet lines under water noise that the one pass missed and four of the other
five heard. Hence `merge_stt.ts`: mappers and the billing check both read the
union of passes.

**How precise.** Timestamps are model output, not acoustic measurement. Ask
for tenths of a second: with whole seconds the model floors starts and ceils
ends, inflating each block by ~1s — on one clean chunk that was 98s vs 90.9s,
and the tenths figure was repeatable to 0.1% across passes. Against an ffmpeg
`silencedetect` bound Gemini never exceeds the acoustic non-silence, so it does
not pad beyond that; snapping block edges to real sound/silence transitions
moved the total −3%, consistent with the tenths result. For a billable figure
run `stt_chunks.ts` two extra times into `stt_results_2` and `stt_results_3`;
`speech_duration.ts` averages every `stt_results*` dir it finds and reports the
spread. Mapping (step 4) keeps reading `stt_results/`.

**What is not measured.** Only audio inside the marker chunks (±60s) is ever
transcribed — 29 of 91 minutes on 0825. Foreign speech the scriptwriter never
marked is invisible to every rule.

**Widening a chunk.** When `speech_duration.ts` reports a span touching a
chunk's audio edge, the fixed 60s buffer cut the exchange off. To redo just
that chunk: set a larger `audio_end` for it in both `chunks_plan.json` and
`chunks_uploaded.json`, drop its `uri`/`mimeType` from the latter, delete
`chunks/<id>.mp3`, `stt_results*/<id>.json` and `stt_results_merged/<id>.json`,
then run `extract_chunks.ts` on `chunks_uploaded.json` (only that chunk is
re-extracted and re-uploaded), the STT passes (each skips chunks that already
have output), `merge_stt.ts`, one mapper for that chunk, and steps 5–6.

## Key files

| File | Role |
|------|------|
| `src/parser.ts` | `parseMarkers()` — extracts markers + scenes from HWPX XML |
| `src/hwpx.ts` | `extractHwpx()` / `repackHwpx()` — zip/unzip HWPX |
| `src/replace.ts` | `replaceMarkers()` — inserts translations into XML |
| `src/gemini.ts` | `getGeminiClient()` / `uploadMedia()` — Gemini API helpers |
| `src/markers.ts` | CLI: dump markers/scenes as JSON |
| `src/ask.ts` | CLI: thin Gemini caller (stdin prompt → stdout response) |
| `src/apply.ts` | CLI: apply translations.json → translated HWPX |
| `src/plan_chunks.ts` | CLI: parse HWPX + compute audio chunks |
| `src/extract_chunks.ts` | CLI: ffmpeg extract + Gemini upload (supports .mp3 and .mp4 input) |
| `src/stt_chunks.ts` | CLI: batch STT on uploaded chunks (one pass per run) |
| `src/merge_stt.ts` | CLI: union of all STT passes → stt_results_merged/ (mapper + billing input) |
| `src/merge_translations.ts` | CLI: merge per-chunk translations → translations.json |
| `src/speech_duration.ts` | CLI: sum measured foreign-speech minutes from stt_results (billing) |
| `.claude/agents/mapper.md` | Mapper agent — translates one chunk's markers |

## Confidence

Mapper agents return `"high"`, `"medium"`, or `"low"` confidence per translation. In the final HWPX, `apply.ts` appends `??` to low-confidence translations so editors can review them.

## TC segments

Long translations are split by mapper agents into multiple segments, each with its own timecode (editor request: long blocks are hard to edit). In the final HWPX, segment 1 replaces the marker text as before; segments 2..N are inserted as new paragraphs formatted `TC<tab>charName<tab>@@(lang) text` (TC in script format: MMSS, or HMMSS past one hour). `replace.ts` handles the paragraph cloning; `merge_translations.ts` validates segment structure (ascending timestamps, warns when a segment covers more than 20s of audio — a segment runs from its timestamp to the next one's, or to the marker's `speech_end`). Legacy single-`translation` entries still work.

## Conventions

- Timestamps in marker data are seconds from start of audio
- Audio chunks: ≤5 min each, 60s leading buffer, 60s trailing buffer
- Chunk filenames must be ASCII (Gemini upload header restriction)
- Language codes: 영=English, 독=German, 오=Austrian German (other codes may appear depending on the episode)
- Only `@@` runs in a **bold** character style are markers (`extractBoldIds` in `src/hwpx.ts`). Writers also type plain `@@(lang)` on lines they are not asking to have translated — on 0826 that was 357 plain lines against 229 bold — so after PLAN compare the marker count with `grep -c '@@'` on the section XML and mention the gap in the report rather than translating the plain lines
- Recurring cast: 큐=QU, 피=PD, 코=coordinator, 카/카감=camera director
- Other character abbreviations (검여, 검남, 수남, etc.) are episode-specific

## Pre-flight checklist

Before running the pipeline, verify these known pitfalls first:

1. **Mapper agents MUST use `mode: "bypassPermissions"`** — without this, all agents silently hang waiting for Write approval that never comes. Do NOT spawn mapper agents without this mode.
2. **STT `maxOutputTokens` must cover thinking tokens** — the cap (currently 65536) bounds runaway output, but `thinkingLevel: HIGH` counts against it and has been measured at 14k–30k on one chunk. Too low a cap truncates the JSON mid-string; the run reports `finishReason=MAX_TOKENS` with the token split.
3. **Multiple files need separate work directories** — never run two HWPX files in the same directory or intermediate files collide.
4. **STT results sanity check** — after STT completes, check each `stt_results/*.json` for a plausible `utterances` count and `foreign_speech_sec`. Delete and re-run any chunk with zero/near-zero foreign speech that has markers expecting it.

## Multi-file parallel processing

When multiple HWPX files share the same directory, intermediate outputs (chunks_plan.json, stt_results/, etc.) collide. To process in parallel:
1. Create a temporary work directory per file (e.g., `<hwpx-dir>/0316_work/`)
2. Copy the HWPX into it
3. Run the pipeline there
4. Copy the result out and delete the work directory

## Mapper agent write permissions

Mapper agents must be spawned with `mode: "bypassPermissions"` to write translation files. The project `.claude/settings.json` allow rules are insufficient for background agents because `defaultMode: "default"` in global settings blocks interactive approval. Always use `mode: "bypassPermissions"` when spawning mapper agents.

## Running

```bash
bun src/plan_chunks.ts "<script>.hwpx" <audio>.mp3   # or .mp4
bun src/extract_chunks.ts <hwpx-dir>/chunks_plan.json
bun src/stt_chunks.ts <hwpx-dir>/chunks_uploaded.json
bun src/stt_chunks.ts <hwpx-dir>/chunks_uploaded.json stt_results_2   # billing only: two extra passes
bun src/stt_chunks.ts <hwpx-dir>/chunks_uploaded.json stt_results_3
bun src/merge_stt.ts <hwpx-dir>/chunks_plan.json                       # union of passes → stt_results_merged/
# step 4: mappers read stt_results_merged/<chunk_id>.json
bun src/merge_translations.ts <hwpx-dir>/chunks_plan.json
bun src/speech_duration.ts <hwpx-dir>/chunks_plan.json                 # billable minutes → speech_duration.json
# step 4: orchestrator spawns mapper agents → translations/<chunk_id>.json
bun src/merge_translations.ts <hwpx-dir>/chunks_plan.json
bun src/apply.ts "<script>.hwpx" <hwpx-dir>/translations.json
```

Requires `GEMINI_API_KEY` env var and `ffmpeg` installed.
