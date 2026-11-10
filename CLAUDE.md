# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## HWPX Translation Pipeline

Korean variety show production script translator. The HWPX document contains a script with `@@(영)` / `@@(독)` / `@@(오)` markers where foreign-language speech (English/German/Austrian German) needs Korean translations inserted.

**Only bold `@@` markers are translated.** A marker counts when its run's `charPrIDRef` is a bold char style in `header.xml` (`extractBoldIds()` → `parseMarkers()` / `replaceMarkers()`). Non-bold `@@` lines are left untouched; scripts routinely carry many of them (0929: 139 bold, 186 non-bold). `plan_chunks.ts` prints both counts.

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

3. STT       bun src/stt_chunks.ts <hwpx-dir>/chunks_uploaded.json --passes 3
              → <hwpx-dir>/stt_results{,_2,_3}/*.json   (all chunks × passes at once)

3b. MERGE STT bun src/merge_stt.ts <hwpx-dir>/chunks_plan.json
              → <hwpx-dir>/stt_results_merged/*.json   (union of all passes)

4. MAP       Orchestrator spawns one mapper agent per chunk in parallel
              → <hwpx-dir>/translations/<chunk_id>.json (per chunk)

5. MERGE     bun src/merge_translations.ts <hwpx-dir>/chunks_plan.json
              → <hwpx-dir>/translations.json

6. APPLY     bun src/apply.ts <hwpx> <hwpx-dir>/translations.json
              → <hwpx-dir>/<name>_translated.hwpx

7. VERIFY    bun src/verify.ts <hwpx>
              → exit 0 + "OK", or a list of problems
```

Steps 2-3 support resume: already-extracted chunks and STT results are skipped on re-run.
Step 4 supports resume: chunks with existing `translations/<chunk_id>.json` are skipped on re-run.

### Run everything as wide as it goes

Every step that calls Gemini or spawns agents runs all its work at the same time by default. Do not run chunks or passes one after another.

- **Extract (step 2):** all chunks are extracted and uploaded in parallel, one ffmpeg job per CPU core (`EXTRACT_CONCURRENCY` overrides). ffmpeg seeks with `-ss` before `-i`, so a chunk at 3h into a 4h mp4 takes seconds, not a decode from the start. Output is written to a temp name first, so an interrupted run leaves no short file behind.
- **STT (step 3):** `--passes 3` runs every (pass, chunk) pair at once, e.g. 21 chunks × 3 passes = 63 calls in flight. On 1028 the old sequential loop took about 2.5 min per chunk per pass, so one pass of 21 chunks was close to an hour. `STT_CONCURRENCY` caps the number in flight if Gemini starts answering 429. Each job tries up to `STT_ATTEMPTS` (default 6) times with backoff and jitter, or `STT_BLOCK_ATTEMPTS` (default 12) when Gemini blocks the request (see "Blocked chunks"). The run ends with a per-pass list of missing chunks and exits 1 if any are missing; run the same command again and it only redoes those. `--only <id>[,<id>…]` limits a run to those chunks, so you can redo one chunk while another run is still busy with a different chunk.
- **Truncated passes:** a pass can end with `finishReason: STOP` and valid JSON, but stop part way through the clip. On 1103 passes 2 and 3 of 01bbba stopped at 1:34 of a 3:34 clip (18 and 16 utterances, against 60), and nothing reported it. After all jobs end, `stt_chunks.ts` compares the passes of each chunk (`src/stt_coverage.ts`). If a pass ends more than 30 s before another pass, and that pass has 5 or more utterances after that point, the result moves to `<id>.json.truncated` and the job runs one more time. If the new result is also cut off, it counts as missing. `merge_stt.ts` does the same check on what it reads, names each file, and exits 1. Delete those files, run `stt_chunks.ts --passes 3 --only <id>`, and then run `merge_stt.ts` again.
- **Episodes:** several episodes run side by side, each in its own work directory (see "Multi-file parallel processing"). Start each episode's next step as soon as its previous step ends; do not wait for the other episodes.
- **Map (step 4):** start a chunk's mapper as soon as its merged STT exists, up to the 20-agent cap, across all episodes. Do not hold back one episode's mappers until another episode's STT is done.

### Blocked chunks

Gemini sometimes blocks an STT request with `promptFeedback.blockReason: "OTHER"` and an empty response. The block is random for most chunks, and the retries get through. On 1028 one 5-minute chunk (05ba) was blocked on 11 tries in a row, and the block followed one part of its audio: the first half went through on every pass, and the second half was always blocked. On 1103 chunk 01bbbb was blocked on 8 tries and went through on the 9th, so a blocked request now gets 12 tries (`STT_BLOCK_ATTEMPTS`) and not 6. When a chunk is still missing after a full run, run the same command again (the next run has 12 more tries). At the same time, start the split below, because you cannot know which of the two gets through first. Use the split only if the retry fails:

1. Make a separate work directory with a copy of the `.hwpx` (outputs go next to `hwpx_path`) and a `chunks_plan.json` whose chunks are pieces of the blocked one: same `markers` and `context`, new `chunk_id` (e.g. `05baA`), and an `audio_start`/`audio_end` window of 1.5–3 min, overlapping its neighbour by 10–20 s.
2. Run `extract_chunks.ts` and `stt_chunks.ts --passes 3` on it.
3. Join the pieces back into `stt_results*/<chunk_id>.json` for each missing pass: keep each piece's utterances between the midpoints of its overlaps, recompute `start_sec`/`end_sec` against the chunk's own `audio_start`, and sort by `abs_start`. Keep any pass that already has the full chunk.
4. Run `merge_stt.ts` and the chunk's mapper as usual.

Step 5 also normalises mapper text: it decodes XML entities (`&lt;서유기&gt;` → `<서유기>`, since `replace.ts` escapes on insert and pre-escaped text renders literally) and drops ` / ` utterance joins, warning with a count when it had to.

Step 7 is the check before delivery. It reads the output back and confirms: the zip is readable (adm-zip and `unzip -t`), every XML part is well-formed, every bold marker has its translation in order with the right speaker/language, no line was added and each line's TC and speaker are unchanged from the script, low-confidence lines carry `??`, no text is double-escaped or slash-joined, and non-bold `@@` lines and all other script text are byte-identical to the source.

### Step 4 detail — MAP

The orchestrator handles this directly (no skill needed):
1. Greps `chunks_plan.json` for `"chunk_id"` values
2. Spawns one `mapper` agent per chunk **in parallel** (subagent_type: "mapper"), passing file paths + chunk_id. At most **20 subagents run at once** — a 21st spawn is refused, not queued. With more chunks than that (three episodes on 1011 had 32), spawn 20, then start the rest as completion notifications free slots, and check `translations/` against the chunk list before merging. `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` raises the cap.
3. Each agent reads its own chunk data from `chunks_plan.json` and `stt_results_merged/<chunk_id>.json` — never a single pass: quiet lines under noise are heard by one pass in five, and on 0825 six markers' speech was missed by the pass the mappers first read
4. Each agent matches speech to markers and writes `translations/<chunk_id>.json`
5. After all agents complete, orchestrator runs `bun src/merge_translations.ts` to merge + validate

The `mapper` agent (`.claude/agents/mapper.md`) processes a single chunk:
- Reads its own data files (chunks_plan.json + stt_results) — orchestrator does not pre-read them
- Reads markers + STT transcript together — no timestamp arithmetic needed (`abs_start` is pre-resolved)
- Reads the scene `context`, where every `@@` line sits in place, tagged `[marker N]` (bold, requested) or `[not requested]` (non-bold). Before 2026-11-01 the context dropped all `@@` lines, and on 1022 (Georgia, about as many non-bold `@@` lines as bold ones) a mapper put speech that belonged to unrequested lines into requested ones.
- Uses STT-provided Korean translations as a starting point
- Improves translations using surrounding Korean dialogue context
- Writes one translation per marker — no splitting, no new TCs (see "TCs are fixed")
- Writes `[{markerIndex, language, charName, timestamp, scene, speech_start, speech_end, translation, confidence}]` to `translations/<chunk_id>.json`

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
run at least three passes (`stt_chunks.ts --passes 3`);
`speech_duration.ts` averages every `stt_results*` dir it finds and reports the
spread. Mapping (step 4) reads the union of passes (`stt_results_merged/`), never a single pass.

**What is not measured.** Only audio inside the marker chunks (±60s) is ever
transcribed — 29 of 91 minutes on 0825. Foreign speech the scriptwriter never
marked is invisible to every rule.

**Widening a chunk.** When `speech_duration.ts` reports a span touching a
chunk's audio edge, the fixed 60s buffer cut the exchange off. To redo just
that chunk: set a larger `audio_end` for it in both `chunks_plan.json` and
`chunks_uploaded.json`, drop its `uri`/`mimeType` from the latter, delete
`chunks/<id>.mp3`, `stt_results*/<id>.json` and `stt_results_merged/<id>.json`,
then run `extract_chunks.ts` on `chunks_uploaded.json` (only that chunk is
re-extracted and re-uploaded), `stt_chunks.ts --passes 3 --only <id>`,
`merge_stt.ts`, one mapper for that chunk, and steps 5–7.

## Key files

| File | Role |
|------|------|
| `src/parser.ts` | `parseMarkers()` — extracts markers + scenes from HWPX XML |
| `src/hwpx.ts` | `extractHwpx()` / `repackHwpx()` — zip/unzip HWPX (repack clears the data-descriptor flag hwp2hwpx sets; left set, the output is a zip adm-zip itself cannot reopen) |
| `src/replace.ts` | `replaceMarkers()` — inserts translations into XML |
| `src/gemini.ts` | `getGeminiClient()` / `uploadMedia()` — Gemini API helpers |
| `src/markers.ts` | CLI: dump markers/scenes as JSON |
| `src/ask.ts` | CLI: thin Gemini caller (stdin prompt → stdout response) |
| `src/apply.ts` | CLI: apply translations.json → translated HWPX |
| `src/plan_chunks.ts` | CLI: parse HWPX + compute audio chunks |
| `src/extract_chunks.ts` | CLI: ffmpeg extract + Gemini upload, all chunks in parallel (supports .mp3 and .mp4 input) |
| `src/stt_chunks.ts` | CLI: STT on uploaded chunks; `--passes N` runs every pass × chunk at once; `--only <ids>` limits it to some chunks |
| `src/stt_coverage.ts` | `findTruncated()` — finds a pass that stops long before another pass of the same chunk (used by `stt_chunks.ts` and `merge_stt.ts`) |
| `src/merge_stt.ts` | CLI: union of all STT passes → stt_results_merged/ (mapper + billing input) |
| `src/merge_translations.ts` | CLI: merge per-chunk translations → translations.json |
| `src/speech_duration.ts` | CLI: sum measured foreign-speech minutes from stt_results (billing) |
| `src/verify.ts` | CLI: check a translated HWPX against its source + translations.json before delivery |
| `.claude/agents/mapper.md` | Mapper agent — translates one chunk's markers |

## Confidence

Mapper agents return `"high"`, `"medium"`, or `"low"` confidence per translation. In the final HWPX, `apply.ts` appends `??` to low-confidence translations so editors can review them.

## TCs are fixed

Each translation goes on its marker's own line, under the TC the scriptwriter typed. No line is added and no TC is changed. Earlier runs split long translations into new `TC<tab>charName<tab>@@(lang) text` lines, one for each 20s of audio (editor request). The editors then reported that those TCs drifted from the video and made editing hard. The two requests conflict, so on 2026-11-01 we agreed with them to keep the TCs fixed and to stop splitting.

- The mapper writes one `translation` string for each marker.
- `merge_translations.ts` joins any `segments` a mapper still writes into one `translation`, and warns with a count.
- `replace.ts` replaces only the text after `@@(lang)`. Old `translations.json` files with `segments` are joined the same way.
- `verify.ts` fails if the output has a different count of bold `@@` lines than the source, or if the text before `@@` (TC, speaker) changed on any line.

## Conventions

- Timestamps in marker data are seconds from start of audio
- Audio chunks: ≤5 min each, 60s leading buffer, 60s trailing buffer
- Chunk filenames must be ASCII (Gemini upload header restriction)
- Language codes: 영=English, 독=German, 오=Austrian German, 베=Vietnamese, 조=Georgian (`LANG_NAME` in `parser.ts`; other codes may appear depending on the episode)
- Recurring cast: 큐=QU, 피=PD, 코=coordinator, 카/카감=camera director
- Other character abbreviations (검여, 검남, 수남, etc.) are episode-specific
- A scene header is a line that starts with `#`, with or without a space (`# 하차프리 식당`, `#케이블카`). Some scripts open with a table of contents that repeats the headers; it holds no `@@` lines and is harmless.
- A TC past the end of the video is a typo (1028: `136623`, 13:66:23 in a 4-hour video). Do not change the document. In `chunks_plan.json` and `chunks_uploaded.json`, set that chunk's markers to the TC that lies between the neighbouring markers, add a `hint` that explains it, widen `audio_start`/`audio_end` to cover both neighbours, and re-extract the chunk. `plan_chunks.ts` checks every TC against the media duration (ffprobe), lists the markers past the end with their chunk, and exits 2; fix those before step 2.

## Pre-flight checklist

Before running the pipeline, verify these known pitfalls first:

1. **Mapper agents must be able to write without a prompt** — otherwise they silently hang waiting for Write approval that never comes. See "Mapper agent write permissions" below; confirm it before spawning.
2. **STT `maxOutputTokens` must cover thinking tokens** — the cap (currently 65536) bounds runaway output, but `thinkingLevel: HIGH` counts against it and has been measured at 14k–30k on one chunk. Too low a cap truncates the JSON mid-string; the run reports `finishReason=MAX_TOKENS` with the token split.
3. **Multiple files need separate work directories** — never run two HWPX files in the same directory or intermediate files collide.
4. **STT results sanity check** — after STT completes, check each `stt_results/*.json` for a plausible `utterances` count and `foreign_speech_sec`. Delete and re-run any chunk with zero/near-zero foreign speech that has markers expecting it.

## Multi-file parallel processing

When multiple HWPX files share the same directory, intermediate outputs (chunks_plan.json, stt_results/, etc.) collide. To process in parallel:
1. Create a work directory per file (e.g., `<hwpx-dir>/0316_work/`)
2. Copy the script into it under a short ASCII name (`0316.hwp`, not `0316(1시간 40분) 번역 필요 다움님.hwp`) — delivered names carry spaces, parentheses and Korean, which make every later command fragile. The output is then `0316_translated.hwpx`.
3. Run the pipeline there
4. Copy `<name>_translated.hwpx` out next to the originals. Keep the work directory until the editors have reviewed the result: it holds `translations.json` (to fix a line and re-apply) and `speech_duration.json` (billing). Delete it after.

## Mapper agent write permissions

The Agent tool has no per-agent permission mode; a mapper inherits the session's. Background agents cannot answer a permission prompt, and the project `.claude/settings.json` allow rules are not enough because `defaultMode: "default"` in global settings still prompts. So run the orchestrating session in bypass-permissions mode (it was on 1011, and all 32 mappers wrote their files). If the session is not in that mode, ask the user to switch before spawning mappers.

## Running

```bash
bun src/plan_chunks.ts "<script>.hwpx" <audio>.mp3   # or .mp4
bun src/extract_chunks.ts <hwpx-dir>/chunks_plan.json                 # all chunks in parallel
bun src/stt_chunks.ts <hwpx-dir>/chunks_uploaded.json --passes 3       # 3 passes × all chunks at once; re-run if it exits 1
bun src/merge_stt.ts <hwpx-dir>/chunks_plan.json                       # union of passes → stt_results_merged/; exits 1 if a pass is truncated
# step 4: orchestrator spawns mapper agents (≤20 at once) → translations/<chunk_id>.json
bun src/merge_translations.ts <hwpx-dir>/chunks_plan.json
bun src/apply.ts "<script>.hwpx" <hwpx-dir>/translations.json
bun src/verify.ts "<script>.hwpx"                                      # must print OK before delivery
bun src/speech_duration.ts <hwpx-dir>/chunks_plan.json                 # billable minutes → speech_duration.json
```

Requires `GEMINI_API_KEY` (bun loads it from the project `.env`, so run commands from the project root) and `ffmpeg` installed.
