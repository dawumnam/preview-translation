# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## HWPX Translation Pipeline

Korean variety show production script translator. The HWPX document contains a script with `@@(영)` / `@@(독)` / `@@(오)` markers where foreign-language speech (English/German/Austrian German) needs Korean translations inserted.

## Architecture

Claude Code is the **orchestrator**. Deterministic steps are CLI scripts; the intelligent mapping step (STT → marker assignment) is delegated to parallel `mapper` subagents.

## Pipeline

All intermediate outputs are written next to the input HWPX file (not CWD). Paths in plan JSON are absolute, so steps can resume from any working directory.

```
1. PLAN      bun src/plan_chunks.ts <hwpx> <mp3|mp4>
              → <hwpx-dir>/chunks_plan.json

2. EXTRACT   bun src/extract_chunks.ts <hwpx-dir>/chunks_plan.json
              → <hwpx-dir>/chunks/ + <hwpx-dir>/chunks_uploaded.json

3. STT       bun src/stt_chunks.ts <hwpx-dir>/chunks_uploaded.json
              → <hwpx-dir>/stt_results/*.txt

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
3. Each agent reads its own chunk data from `chunks_plan.json` and `stt_results/<chunk_id>.txt`
4. Each agent matches speech to markers and writes `translations/<chunk_id>.json`
5. After all agents complete, orchestrator runs `bun src/merge_translations.ts` to merge + validate

The `mapper` agent (`.claude/agents/mapper.md`) processes a single chunk:
- Reads its own data files (chunks_plan.json + stt_results) — orchestrator does not pre-read them
- Reads markers + STT transcript together — no explicit timestamp arithmetic needed
- Uses STT-provided Korean translations as a starting point
- Improves translations using surrounding Korean dialogue context
- Splits long translations into TC segments (≤80 chars = 1, 80–200 = 2, >200 = 3; cut at topic/sentence boundaries; segment timestamps from STT block start times)
- Writes `[{markerIndex, language, charName, timestamp, scene, segments: [{timestamp, text}], confidence}]` to `translations/<chunk_id>.json`

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
| `src/stt_chunks.ts` | CLI: batch STT on uploaded chunks |
| `src/merge_translations.ts` | CLI: merge per-chunk translations → translations.json |
| `.claude/agents/mapper.md` | Mapper agent — translates one chunk's markers |

## Confidence

Mapper agents return `"high"`, `"medium"`, or `"low"` confidence per translation. In the final HWPX, `apply.ts` appends `??` to low-confidence translations so editors can review them.

## TC segments

Long translations are split by mapper agents into multiple segments, each with its own timecode (editor request: long blocks are hard to edit). In the final HWPX, segment 1 replaces the marker text as before; segments 2..N are inserted as new paragraphs formatted `TC<tab>charName<tab>@@(lang) text` (TC in script format: MMSS, or HMMSS past one hour). `replace.ts` handles the paragraph cloning; `merge_translations.ts` validates segment structure (ascending timestamps, warns >220 chars). Legacy single-`translation` entries still work.

## Conventions

- Timestamps in marker data are seconds from start of audio
- Audio chunks: ≤5 min each, 60s leading buffer, 60s trailing buffer
- Chunk filenames must be ASCII (Gemini upload header restriction)
- Language codes: 영=English, 독=German, 오=Austrian German (other codes may appear depending on the episode)
- Recurring cast: 큐=QU, 피=PD, 코=coordinator, 카/카감=camera director
- Other character abbreviations (검여, 검남, 수남, etc.) are episode-specific

## Pre-flight checklist

Before running the pipeline, verify these known pitfalls first:

1. **Mapper agents MUST use `mode: "bypassPermissions"`** — without this, all agents silently hang waiting for Write approval that never comes. Do NOT spawn mapper agents without this mode.
2. **STT model has `maxOutputTokens` set** — check `stt_chunks.ts` has a token cap (currently 16384). Without it, Gemini can hallucinate 100k+ char outputs that corrupt the pipeline.
3. **Multiple files need separate work directories** — never run two HWPX files in the same directory or intermediate files collide.
4. **STT results sanity check** — after STT completes, scan for anomalous output sizes. Delete and re-run any that are suspiciously large (>30k chars) or tiny (<100 chars for chunks with multiple markers).

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
# step 4: orchestrator spawns mapper agents → translations/<chunk_id>.json
bun src/merge_translations.ts <hwpx-dir>/chunks_plan.json
bun src/apply.ts "<script>.hwpx" <hwpx-dir>/translations.json
```

Requires `GEMINI_API_KEY` env var and `ffmpeg` installed.
