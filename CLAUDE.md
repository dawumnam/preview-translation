# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this does

Translator for Korean variety show production scripts. The input is a script (`.hwp` or `.hwpx`) and the video of the same day. The script has `@@(조)` / `@@(영)` / `@@(베)` markers where a person speaks a foreign language. The output is `<script name>_translated.hwpx`: the same document with the Korean translation written after each requested marker.

**Only bold `@@` markers are translated.** A marker counts when its run's `charPrIDRef` is a bold char style in `header.xml` (`extractBoldIds()` → `parseMarkers()` / `replaceMarkers()`). Non-bold `@@` lines are left untouched; scripts carry many of them (0929: 139 bold, 186 non-bold). The run prints both counts.

## Run

```bash
bun src/run.ts "<script>.hwp" <video>.mp4                    # one episode, 1 to 2 minutes
bun src/run.ts a.hwp a.mp4 b.hwp b.mp4 c.hwp c.mp4            # several episodes at the same time
```

Run it from the project root (bun reads `GEMINI_API_KEY` from `.env` there). It needs `ffmpeg`, and for `.hwp` input the Homebrew OpenJDK (`brew install openjdk`; the first run builds `tools/hwp2hwpx`).

The command does all the steps. There is no orchestration to do, no agent to start and no file to copy:

- The translated file goes next to the script: `<script name>_translated.hwpx`. It is written only when `verify.ts` says OK.
- All other files go to `<script dir>/<id>_work/`, where `<id>` is the first four digits in the file name (`1104_work`). Keep this directory until the editors have reviewed the result.
- The last lines of the output give, for each episode: time for each step, confidence counts, each ` ??` line with the reason, the billable seconds, notes, and the verify result. Exit code 1 means that an episode failed or did not pass verify.
- `--fresh` ignores saved listening passes. Without it, a second run uses the passes in the work directory again and only repeats the steps after them.
- `--keep-audio` keeps the decoded audio (`audio.pcm`, about 230 MB for each hour).

Tell the user the confidence counts, the ` ??` lines and the billable figure. If the user asks for a check of the output, see "After the run".

## How it works

```
script ──► timeline of lines with TCs ──► listening windows (tens of seconds each)
video  ──► audio decoded once (3 s) ─┐
script ──► episode brief (15 s) ─────┤
                                     ▼
              pass A and pass B: every window to the model at the same time,
              each with the script lines for that stretch
                                     ▼
              compare A and B line by line
                 agree ─────────────► confidence high
                 differ ─► 3 focused listens ─► 3 or more of 5 agree ► medium
                                               fewer ► low, marked " ??"
                                     ▼
              translations.json ─► apply ─► verify ─► <name>_translated.hwpx
```

1. **Timeline (`script.ts`).** Every line of the script in order, with its TC. A marker's speech lies between the TC before it and the TC after it: within 3 s for 97.6% of 949 markers, and inside `[tcPrev − 8 s, tcNext + 15 s]` for 99.7%. The median distance between those two TCs is 24 s. So the script itself says where to listen.
2. **TC typos repair themselves.** The footage runs forward, so a TC outside the longest non-decreasing run of TCs is a typo (1028: `140623` for `13623`; 1024: `3224` for `32624`; also the date in the title line). Such a TC stays in the document, but it is not used as a bound: the line is placed between the good TCs around it. The run prints a note for each marker this applies to. No plan file has to be edited.
3. **Windows (`windows.ts`).** Markers that are close together share a window of at most 100 s (pass A) or 60 s (pass B). The two passes cut the audio differently, so a line at a window edge in one pass is in the middle of a window in the other. For 1103 this is 50 + 70 windows.
4. **Audio (`audio.ts`).** ffmpeg decodes the full soundtrack once to 16 kHz mono PCM (3 s for a 2-hour mp4). A window is then a byte range with a WAV header, sent inline. There is no chunk file, no upload and no ASCII file name rule.
5. **Brief (`brief.ts`).** One text call on the full script: who each speaker label is, and how the scriptwriter spells names and local words (`끌라비 (ტყლაპი)`). Each window gets these notes. Without them each window spells names in its own way; that was the most frequent fix in review.
6. **Listen (`listen.ts`, `prompt.ts`).** The model gets the audio window and the script lines for the same stretch, each with its time in the clip. Requested markers are `▶N`; unrequested `@@` lines and the Korean lines are shown as they are. For each `▶N` the model returns the words it heard in the original language, the Korean translation, and the start and end time. It must not copy the coordinator's Korean line and must not fill a line from context alone (`heard: false`).
7. **Decide (`reconcile.ts`).** Passes A and B are compared for each line: close text is "same" with no call; other pairs go to a text model (same / detail / different). Neighbours whose times are in the wrong order are reopened. Each line where the passes differ gets three focused listens: a closer window, with the settled neighbours' translations shown as fixed points. All five listens of that line are compared, and the reading with the most support wins.
8. **Write.** `translations.json` has the same shape as before. `apply` and `verify.ts` are the same code as before.

Every model call goes through `llm.ts`: JSON with a schema, a time limit, a second identical request if the first is slow (45 s), retries with backoff on 429 and 5xx, and one shared limit on calls in flight (`LLM_CONCURRENCY`, default 64). A truncated answer (`finishReason` not `STOP`) is not accepted. A blocked window (`promptFeedback.blockReason`) is not sent again as it is: it is moved by a few seconds, and then it goes to the fallback model.

## Why it is built this way

Each choice below was measured on the eight Georgia episodes of October and November 2026 (949 markers, 20 hours of video). `bench/` holds the tool; `bench/README.md` explains the score.

| Question | Result |
|---|---|
| Which model hears Georgian best? (blind, short clips, 80 lines) | `gemini-4-argon` 0.89–0.90 at any thinking level, 8 s for each call. `gemini-3.8-flash`: LOW 0.84 (6 s), MEDIUM 0.84 (12 s), HIGH 0.89 (34 s median, 127 s at the 90th percentile, 5,400 thinking tokens for a 10-second clip). `gemini-3.1-pro-preview` 0.80–0.81. |
| Transcribe everything and map later, or fill the script lines directly? | The complete new method scores 0.891 on the 233 benchmark lines with the answer keys hidden. The earlier deliveries (3 × full STT, mapper agents, probes, review) score 0.901 with the answer keys visible. The difference is 4 lines, inside the noise of the measurement (one pass of the same settings gave 0.87 to 0.91 in eight runs). A guided call returns only the requested lines, so it takes 15 s and not 3 minutes. |
| Which model for the guided pass? | `gemini-4-argon` 0.87–0.91; `gemini-3.8-flash` 0.85 (LOW 0.852, MEDIUM 0.845), and Flash had windows blocked (`blockReason: OTHER`) where Argon had none. |
| Does more thinking help? | Not for Argon: LOW / MEDIUM / HIGH = 0.901 / 0.87–0.91 / 0.908, and HIGH takes twice the time. The old pipeline needed HIGH because it used Flash. |
| Are the lines placed on the right turn? | Checked against the script with no model: the speech of a line must lie between the TCs around it. In every episode the new method has as many lines inside `[tcPrev − 5 s, tcNext + 5 s]` as the earlier deliveries, or more (0902: 113 of 113 against 109). Where the two put a line on different audio and the TCs can decide, the new one was inside the bounds 5 times and the old one 0 times. |
| Is a dedicated STT model better? | `gemini-3.5-transcribe` is fast (6 s for 2 minutes) and gives exact word times for the Korean speech, but it did not transcribe the quiet Georgian lines at all. Not used. |
| Left channel, right channel or both? | The two channels carry different microphones, but one channel alone was not better (0.86 / 0.86 against 0.90 for the mix). |
| Does audio filtering help the quiet lines? | No: `dynaudnorm` 0.88 and `speechnorm` 0.90 against 0.91 without a filter (blind test). |
| Short or long windows? | No measurable difference: 45 s / 60 s / 100 s windows score 0.886 / 0.897 / 0.908, and shorter windows cost more because they overlap more. |
| Should the model list all turns of the window before it fills the lines? | No. It placed every line of 0902 on the same audio as without the list, and the listening took twice as long. |
| Does the model's own confidence mean anything? | No. It said "high" for 922 of 949 lines. |
| Does agreement between listens mean anything? | Yes. On a repeat run of the complete method, a line that was "high" in both runs came out the same in 97–98% of cases. A "medium" line came out different in about 20% of cases, and a "low" line in most cases. More listens do not make those lines stable: the audio is ambiguous there (overlapping speech, a quiet aside). The flag tells the editor where to look. |
| Does video help to tell the locals apart? | Not at 2 frames per second and low resolution: the speaker assignment did not become more stable. Not used. |

Time for one episode alone: 67 s and 128 s for 1104 in two runs (96 lines, 2 h 33 min video; 22 minutes on 10 November with the old pipeline run as wide as possible), 83 s for 0902 (113 Vietnamese lines). The time is one brief call (15 to 20 s) plus the slowest listening call, plus the focused listens (10 to 30 s), and it goes up when the model service is busy. The eight Georgia episodes together run in 4 to 6 minutes; 1103 alone took 36 minutes before. Cost is 0.7 to 2 USD for an episode at the November 2026 price of `gemini-4-argon` (the price doubles on 1 December 2026); the old pipeline spent more than that on Flash thinking tokens alone.

## Confidence

| Level | Meaning | In the document |
|---|---|---|
| high | Passes A and B heard the same thing | text |
| medium | The passes differed; 3 or more of the 5 listens agree | text |
| low | Fewer than 3 listens agree, or only one heard the line | text + ` ??` |
| low, not heard | No listen heard the line | `(들리지 않음) ??` |

On the eight Georgia episodes: 89% high, 8.5% medium, 2.3% low (22 of 949 lines; 0 to 8 for an episode). Scenes with several locals who speak in quick turns give the most medium and low lines.

## After the run

- **To look at a line again:** `bun src/relisten.ts <work-dir> <marker> [<marker> ...] [--times 3]`. It listens to those lines again and prints each reading next to the current text. It changes nothing.
- **To change a line:** `bun src/fix.ts <work-dir> <marker> "<new Korean text>"`. It updates `translations.json`, applies, verifies and writes the delivered file again. The line becomes `high` (no ` ??`) unless you add `--confidence low`.
- `<work-dir>/evidence.json` has, for each marker, every listen (pass, time span, source words, Korean) and the decision with its reason. Read it before you call a line wrong.
- When the user asks for a check of the output, read the ` ??` lines and the medium lines in `evidence.json` against the script lines around them. Fix only a line whose meaning is clearly off; do not polish wording.

## TCs are fixed

Each translation goes on its marker's own line, under the TC the scriptwriter typed. No line is added and no TC is changed. Earlier runs split long translations into new `TC<tab>charName<tab>@@(lang) text` lines; the editors reported that those TCs drifted from the video and made editing hard, so on 2026-11-01 we agreed to keep the TCs fixed.

- `replace.ts` replaces only the text after `@@(lang)`. Old `translations.json` files with `segments` are joined into one line.
- `verify.ts` fails if the output has a different count of bold `@@` lines than the source, or if the text before `@@` (TC, speaker) changed on any line.

## Verify

`verify.ts` is the check before delivery, and `run.ts` and `fix.ts` run it each time. It reads the output back and confirms: the zip is readable (adm-zip and `unzip -t`), every XML part is well-formed, every bold marker has its translation in order with the right speaker and language, no line was added and each line's TC and speaker are unchanged, low-confidence lines carry ` ??`, no text is double-escaped or slash-joined, and non-bold `@@` lines and all other script text are byte-identical to the source.

## Billing

**What counts: the audio each translation was written from.** Each line has `speech_start` / `speech_end` in `translations.json`: the span of the turn that the chosen listen reported. The billable figure is the union of those spans for lines with confidence high or medium, counted once where spans overlap. A ` ??` line is not billed; the run prints how many seconds those lines would add, so they can be added by hand after an editor confirms them. The figure is in the run output and in `<work-dir>/speech_duration.json`.

The spans are model output in tenths of a second, not an acoustic measurement. Two runs of the same episode differ by 1–3%. Against the earlier deliveries the new figure is 97% in total over the eight Georgia episodes (7,508 s against 7,732 s; 0.89 to 1.05 for one episode). Part of the difference is the ` ??` lines, which the earlier figure included.

## Key files

| File | Role |
|------|------|
| `src/run.ts` | CLI: script + video → translated HWPX, one or more episodes |
| `src/pipeline.ts` | `runEpisode()`: the steps for one episode, and the model names |
| `src/script.ts` | `parseScript()`: the script as a timeline; TC typo repair |
| `src/windows.ts` | `planWindows()`: listening windows from the timeline |
| `src/audio.ts` | Decode once, slice windows as WAV in memory |
| `src/brief.ts` | Episode brief: speakers and spellings |
| `src/prompt.ts` | The script-guided listening prompt and its response schema |
| `src/listen.ts` | `listenPass()`: all windows of a pass at the same time; what to do with a blocked window |
| `src/reconcile.ts` | `firstRound()` / `consensus()`: agreement between listens → decision and confidence |
| `src/llm.ts` | `callJson()`: Gemini over REST with schema, time limit, duplicate request, retries, shared limit, token count |
| `src/relisten.ts` | CLI: listen again to chosen lines (changes nothing) |
| `src/fix.ts` | CLI: change one line, apply, verify, deliver again |
| `src/parser.ts` | `parseMarkers()`: the authority on markers (index, speaker, TC), used by apply and verify |
| `src/replace.ts` | `replaceMarkers()`: inserts translations into the XML; the `Translation` type |
| `src/hwpx.ts` | `extractHwpx()` / `repackHwpx()` (repack clears the data-descriptor flag that hwp2hwpx sets) |
| `src/apply.ts` | CLI: apply a `translations.json` to a HWPX |
| `src/verify.ts` | CLI: check a translated HWPX against its source and `translations.json` |
| `src/markers.ts` | CLI: dump markers and scenes as JSON |
| `src/pipeline.test.ts` | `bun test`: timeline, windows, audio slices, decisions, call wrapper |
| `bench/bench.ts` | Benchmark on earlier episodes (see `bench/README.md`) |
| `tools/hwp2hwpx/convert.sh` | `.hwp` → `.hwpx` (run.ts calls it) |

## When something goes wrong

- **`GEMINI_API_KEY is not set` or a 400/403 on the first call:** the key in `.env` is missing or no longer valid (this happened on 5 and 9 November). Ask the user for a new key. Nothing else can be done.
- **`NOTE: window a012: blocked (OTHER) on …`:** both models refused that window in that pass. The other pass and the focused listens cut the audio in a different way, so the lines are usually still decided; if not, they are ` ??`. Run the command again (saved passes with a failed window are listened to again).
- **Many 503 "high demand" answers:** the run goes on with backoff and the fallback model, but it is slower. A later run is faster.
- **`verify: FAILED`:** the delivered file is not written. The problems are printed. A count mismatch means `parseMarkers()` and `replaceMarkers()` disagree on a marker in this script; fix the parser, do not edit the output.
- **A marker TC past the end of the media:** printed as a note. After the typo repair this means that the script and the video do not belong together, or the video is cut short.
- **Other models:** `LISTEN_MODEL`, `FALLBACK_MODEL`, `JUDGE_MODEL` override the defaults (`gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.8-flash`). Run the benchmark before you change a default. `gemini-4-argon` ignores `temperature`.

## Conventions

- Language codes: 영=English, 독=German, 오=Austrian German, 베=Vietnamese, 조=Georgian (`LANG_NAME` in `parser.ts`; other codes can appear).
- Recurring cast: 큐=host, 피=PD, 코=coordinator, 카/카감=camera director. Other labels (검여, 모남, 수남 …) name locals by their look and change with each episode; the brief works them out.
- A scene header is a line that starts with `#`, with or without a space. Some scripts open with a table of contents that repeats the headers; it holds no `@@` lines and is harmless.
- Translation text is plain text. `replace.ts` escapes on insert, so the pipeline decodes any XML entities the model wrote and removes ` / ` joins.

## History

Up to commit `60afbc1` the pipeline was: scene chunks of up to 5 minutes with 60 s buffers → ffmpeg + upload for each chunk → full transcription of each chunk, three passes with `gemini-3.8-flash` at HIGH thinking → merge of passes → one Claude `mapper` subagent for each chunk → merge → apply → verify, with Claude Code as the orchestrator and probes by hand for lines that stayed unclear. It was replaced because:

- One model call took 2.5 to 6 minutes (thinking tokens), and one blocked or hung call held up the step. 1103 took 36 minutes, of which the STT step was 32. The three episodes of 9 November took a working day.
- The mapping step needed an orchestrating session, was capped at 20 subagents, and took 10 to 20 minutes of wall time.
- It transcribed everything in the chunks, Korean crew talk included, and then threw most of it away.
- Typo TCs, blocked chunks and truncated passes each needed a repair by hand.
