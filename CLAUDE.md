# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this does

Translator for Korean variety show production scripts. The input is a script (`.hwp` or `.hwpx`) and the video of the same day. The script has `@@(조)` / `@@(영)` / `@@(베)` markers where a person speaks a foreign language. The output is `<script name>_translated.hwpx`: the same document with the Korean translation written after each requested marker.

**Only the requested `@@` markers are translated.** The scriptwriter marks a requested line with a text style: bold, and in nearly all lines also underline and blue. A marker counts when the character style of its run (`charPrIDRef` → `header.xml`) matches the selection rule. The default rule is `bold`; `--select` gives another rule in plain words (see "Which lines are translated"). All other `@@` lines are left untouched; scripts carry many of them (0929: 139 requested, 186 not). The run prints the counts for each style before it listens.

## Run

```bash
bun src/run.ts "<script>.hwp" <video>.mp4                    # one episode, 1 to 2 minutes
bun src/run.ts a.hwp a.mp4 b.hwp b.mp4 c.hwp c.mp4            # several episodes at the same time
bun src/run.ts "<script>.hwp" --list                          # only show which lines are selected: no video, no model call, no cost
bun src/run.ts "<script>.hwp" <video>.mp4 --select "bold underline color"   # another rule for the requested lines
```

Run it from the project root (bun reads `GEMINI_API_KEY` from `.env` there). It needs `ffmpeg`, and for `.hwp` input the Homebrew OpenJDK (`brew install openjdk`; the first run builds `tools/hwp2hwpx`).

The command does all the steps. There is no orchestration to do, no agent to start and no file to copy:

- The translated file goes next to the script: `<script name>_translated.hwpx`. It is written only when `verify.ts` says OK.
- All other files go to `<script dir>/<id>_work/`, where `<id>` is the first four digits in the file name (`1104_work`). Keep this directory until the editors have reviewed the result.
- The last lines of the output give, for each episode: time for each step, confidence counts, each ` ??` line with the reason, the billable seconds, notes, and the verify result. Exit code 1 means that an episode failed or did not pass verify.
- `--select "<words>"` sets which text style marks the requested lines (default `bold`). `--list` prints the selection and stops.
- `--fresh` ignores saved listening passes. Without it, a second run with the same script and video uses the passes in the work directory again.
- `--keep-audio` keeps the decoded audio (`audio.pcm`, about 115 MB for each hour).

Tell the user the confidence counts, the ` ??` lines, the billable figure and the doubtful lines of the selection, if there are some. If the user asks for a check of the output, see "After the run".

## Which lines are translated

The style of a line is exact data in the file, so code reads it (`select.ts`); no model is used. The rule is a list of plain words, and a line is selected when its style has every property that the rule names:

| Word | Meaning |
|---|---|
| `bold`, `italic`, `underline`, `highlight` | the text has that property |
| `color` | the text has a colour of any family (not black, grey or white) |
| `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink` | the text has a colour of that family |
| `#RRGGBB` | the text has exactly that colour |

Words such as "lines with" and "and" are ignored, so `--select "lines with bold underline color"` is the same as `--select "bold underline color"`. An unknown word stops the command with the list of known words. The rule is saved in `<work-dir>/episode.json`, and `fix.ts`, `relisten.ts`, `verify.ts` and `apply.ts` use it from there.

Before it listens, the run prints one row for each style that an `@@` line has, and the **doubtful lines**: lines with only a part of the usual style of the requested lines. Example (1028):

```
selection "bold": 157 of 366 @@ lines
  translate   151  bold underline blue
  translate     6  bold blue
  leave       209  plain
  doubtful lines: 6. They have only a part of the usual style "bold underline blue". Check them in the script:
    TC 1:40:34  14034 검남 @@(조)  → will be translated, but: no underline
```

A doubtful line can be a slip of the scriptwriter's hand in one of two directions: a requested line where a part of the style was forgotten, or a line that got a part of the style by accident. Code cannot know the intent, and a model cannot know it too. Tell the user about these lines; the user or the client decides. In the 12 scripts of August to November 2026, 41 of 1,591 bold `@@` lines (2.6%) are doubtful, and no line has underline or a colour with no bold. A plain `@@` line between two requested lines is not doubtful: the writer selects lines, and each episode has up to 13 such lines.

The default stays `bold` because it selects the same lines as all earlier deliveries. With `--select "bold underline color"` the 41 doubtful lines are not translated.

## How it works

```
script ──► timeline of lines with TCs ──► listening windows (tens of seconds each)
video  ──► audio decoded once (3 s) ─┐
script ──► episode brief (8 s) ──────┤
                                     ▼
        passes A, B and C: every window of all three to the model at the
        same time, each with the script lines for that stretch
                                     ▼
        for each line, compare the three readings
             all three agree ─► high
             two agree ───────► medium
             no two agree ────► low, marked " ??"
                                     ▼
        translations.json ─► apply ─► verify ─► <name>_translated.hwpx
```

1. **Timeline (`script.ts`).** Every line of the script in order, with its TC. A marker's speech lies between the TC before it and the TC after it: within 3 s for 97.6% of 949 markers, and inside `[tcPrev − 8 s, tcNext + 15 s]` for 99.7%. The median distance between those two TCs is 24 s. So the script itself says where to listen.
2. **TC typos repair themselves.** The footage runs forward, so a TC outside the longest non-decreasing run of TCs is a typo (1028: `140623` for `13623`; 1024: `3224` for `32624`; also the date in the title line). Such a TC stays in the document, but it is not used as a bound: the line is placed between the good TCs around it. The run prints a note for each marker this applies to. No plan file has to be edited.
3. **Windows (`windows.ts`).** Markers that are close together share a window. The three passes cut the audio in three ways (windows of at most 100 s, 60 s and 80 s, with different margins), so a line at a window edge in one pass is in the middle of a window in the others. For 1104 this is 17 + 35 + 21 windows.
4. **Audio (`audio.ts`).** ffmpeg decodes the full soundtrack once to 16 kHz mono PCM (3 s for a 2-hour mp4). A window is then a byte range with a WAV header, sent inline. There is no chunk file, no upload and no ASCII file name rule.
5. **Brief (`brief.ts`).** One text call on the full script (`gemini-3.8-flash`, about 8 s): who each speaker label is, and how the scriptwriter spells names and local words (`끌라비 (ტყლაპი)`). Each window gets these notes. Without them each window spells names in its own way; that was the most frequent fix in review. Scripts spell one word in several ways (1025: 끌라비 four times, 클라피 and 틀라비 once each). The model groups the spellings and the count in the script picks the one to use, so the output has one spelling for each name.
6. **Listen (`listen.ts`, `prompt.ts`).** The model gets the audio window and the script lines for the same stretch, each with its time in the clip. Requested markers are `▶N`; unrequested `@@` lines and the Korean lines are shown as they are. For each `▶N` the model returns the words it heard in the original language, the Korean translation, and the start and end time. It must not copy the coordinator's Korean line and must not fill a line from context alone (`heard: false`).
7. **Decide (`reconcile.ts`).** For each line, every pair of the three readings is compared: close text is "same" with no call; other pairs go to a text model (same / detail / different). The reading with the most support wins; among equals the one of middle length is taken. Two neighbours whose times are in the wrong order are both flagged. Markers that share a window form a group, and a group is decided as soon as its own windows have answered.
8. **Write.** `translations.json` has the same shape as before. `apply` and `verify.ts` are the same code as before.

Every model call goes through `llm.ts`:

- JSON with a schema. A truncated answer (`finishReason` not `STOP`) is not accepted.
- **Copies of slow calls.** When a call has no answer after 20 s, an identical copy starts, and a third at 40 s. The first answer wins. How long a call takes does not follow its size (a window with one short line took 52 s when the median was 20 s), so a copy is a new draw. In a busy hour this cut the wait for the last window from 81 s to 50 s.
- Retries with backoff on 429 and 5xx. A blocked window (`promptFeedback.blockReason`) is not sent again as it is: it is moved by a few seconds, and then it goes to the fallback model.
- **A time limit of 150 s for each window**, all tries together. After that the window counts as failed in that pass, and the other two passes decide its lines.
- Two limits on calls in flight: 128 audio calls (`LLM_CONCURRENCY`) and 32 text calls. The text calls are apart so that a decision does not wait behind hundreds of windows.
- When the API refuses the project or the key as a whole (spending cap, bad key), all later calls fail at once, and the run stops with that message.

## Why it is built this way

Each choice below was measured on the eight Georgia episodes of October and November 2026 (949 markers, 20 hours of video). `bench/` holds the tool; `bench/README.md` explains the score.

| Question | Result |
|---|---|
| Is the result as good as before? | Yes, on the 233 benchmark lines. Gemini judge: this design 0.908, earlier deliveries 0.901. Graded blind and in pairs by Claude: 0.933 and 0.933 (better on 7 lines, worse on 7). The earlier deliveries had the answer keys visible and were made with probes and review; this design had the keys hidden. A difference of this size is inside the noise: one pass of the same settings gave 0.87 to 0.91 in eight runs. |
| Which model hears Georgian best? (blind, short clips, 80 lines) | `gemini-4-argon` 0.89–0.90 at any thinking level, 8 s for each call. `gemini-3.8-flash`: LOW 0.84 (6 s), MEDIUM 0.84 (12 s), HIGH 0.89 (34 s median, 127 s at the 90th percentile, 5,400 thinking tokens for a 10-second clip). `gemini-3.1-pro-preview` 0.80–0.81. |
| Which model for the guided pass? | `gemini-4-argon` 0.87–0.91; `gemini-3.8-flash` 0.85 (LOW 0.852, MEDIUM 0.845), and Flash had windows blocked (`blockReason: OTHER`) where Argon had none. |
| Does more thinking help? | Not for Argon: LOW / MEDIUM / HIGH = 0.901 / 0.87–0.91 / 0.908, and HIGH takes twice the time. The old pipeline needed HIGH because it used Flash. |
| Transcribe everything and map later, or fill the script lines directly? | Fill directly. A guided call returns only the requested lines, so it takes 15 s and not 3 minutes, and it needs no mapping step. |
| Are the lines placed on the right turn? | Checked against the script with no model: the speech of a line must lie between the TCs around it. In every episode the new method has as many lines inside `[tcPrev − 5 s, tcNext + 5 s]` as the earlier deliveries, or more (0902: 113 of 113 against 109). Where the two put a line on different audio and the TCs can decide, the new one was inside the bounds 5 times and the old one 0 times. |
| Does the model's own confidence mean anything? | No. It said "high" for 922 of 949 lines. |
| Does agreement between passes mean anything? | Yes. On a repeat run, a line on which the passes agreed came out the same in 97–98% of cases. A line on which they differed came out different in 20% of cases or more. |
| Should disputed lines get a second round of listens? | No. An earlier version gave each disputed line three focused listens (closer window, settled neighbours shown). On a repeat run that changed little (9.2% → 8.5% of lines different), because the audio is ambiguous there (overlapping speech, a quiet aside), and it added 35 to 50 s. Its benchmark score was the same (0.931 against 0.933). With one round, 4.2% of lines are flagged in place of 2.3%; `relisten.ts` gives the second look when someone asks for it. |
| Is a dedicated STT model better? | `gemini-3.5-transcribe` is fast (6 s for 2 minutes) and gives exact word times for the Korean speech, but it did not transcribe the quiet Georgian lines at all. Not used. |
| Left channel, right channel or both? | The two channels carry different microphones, but one channel alone was not better (0.86 / 0.86 against 0.90 for the mix). |
| Does audio filtering help the quiet lines? | No: `dynaudnorm` 0.88 and `speechnorm` 0.90 against 0.91 without a filter (blind test). |
| Short or long windows? | No measurable difference: 45 s / 60 s / 100 s windows score 0.886 / 0.897 / 0.908, and shorter windows cost more because they overlap more. |
| Should the model list all turns of the window before it fills the lines? | No. It placed every line of 0902 on the same audio as without the list, and the listening took twice as long. |
| Does video help to tell the locals apart? | Not at 2 frames per second and low resolution: the speaker assignment did not become more stable. Not used. |
| Which model for the brief? | `gemini-3.8-flash`: 8 to 9 s in two runs (16 s in one earlier run), and a glossary with the names in the local script. `gemini-4-argon` took 15 to 38 s. `gemini-3.5-flash` took 6 to 10 s, but it is deprecated and the API routes it to `gemini-3.6-flash`; the price is the same, and its glossary was a little shorter. The brief costs about 1 cent. |
| Does the priority service tier make calls faster? | No. `serviceTier: "priority"` is accepted, but the median was not lower (29.5 s against 15.1 s on 12 windows in a busy hour). Not used. |

Time: episode 1104 (96 lines, 2 h 33 min video) took 81 s and 88 s in two runs, both in hours when the model service was slow; it took 22 minutes on 10 November with the old pipeline run as wide as possible. The time is the brief (about 8 s), then the slowest listening window (25 to 77 s), then about 5 s to decide. The eight Georgia episodes together took 313 s; 1103 alone took 36 minutes before. Cost is about 1.6 USD for an episode at the November 2026 price of `gemini-4-argon` (the price doubles on 1 December 2026); the old pipeline spent more than that on Flash thinking tokens alone.

## Confidence

| Level | Meaning | In the document |
|---|---|---|
| high | All three passes heard the same thing | text |
| medium | Two passes agree | text |
| low | No two passes agree, or only one heard the line, or the line and its neighbour are in the wrong order in time | text + ` ??` |
| low, not heard | No pass heard the line | `(들리지 않음) ??` |

On the eight Georgia episodes: 86% high, 9.5% medium, 4.2% low (40 of 949 lines; 1 to 13 for an episode). Scenes with several locals who speak in quick turns give the most medium and low lines.

## After the run

- **To look at a line again:** `bun src/relisten.ts <work-dir> <marker> [<marker> ...] [--times 3]`. It listens to those lines again, with the neighbours' translations shown to the model as fixed points, and prints each reading next to the current text. It changes nothing.
- **To change a line:** `bun src/fix.ts <work-dir> <marker> "<new Korean text>"`. It updates `translations.json`, applies, verifies and writes the delivered file again. The line becomes `high` (no ` ??`) unless you add `--confidence low`.
- `<work-dir>/evidence.json` has, for each marker, every listen (pass, time span, source words, Korean) and the decision with its reason. Read it before you call a line wrong.
- When the user asks for a check of the output: run `relisten.ts` on the ` ??` lines. If two of the three new readings agree with each other, or with one of the readings in `evidence.json`, set that text with `fix.ts`. If they still differ, leave the ` ??`: the line is unclear in the audio, and the editor must decide. Then read the medium lines in `evidence.json` against the script lines around them. Fix only a line whose meaning is clearly off; do not polish wording.

## TCs are fixed

Each translation goes on its marker's own line, under the TC the scriptwriter typed. No line is added and no TC is changed. Earlier runs split long translations into new `TC<tab>charName<tab>@@(lang) text` lines; the editors reported that those TCs drifted from the video and made editing hard, so on 2026-11-01 we agreed to keep the TCs fixed.

- `replace.ts` replaces only the text after `@@(lang)`. Old `translations.json` files with `segments` are joined into one line.
- `verify.ts` fails if the output has a different count of requested `@@` lines than the source, or if the text before `@@` (TC, speaker) changed on any line.

## Verify

`verify.ts` is the check before delivery, and `run.ts` and `fix.ts` run it each time. It reads the output back and confirms: the zip is readable (adm-zip and `unzip -t`), every XML part is well-formed, every requested marker has its translation in order with the right speaker and language, no line was added and each line's TC and speaker are unchanged, low-confidence lines carry ` ??`, no text is double-escaped or slash-joined, and the `@@` lines that are not requested and all other script text are byte-identical to the source.

`verify.ts` checks the document, not the content. A run in which the model answered nothing would still pass it, so `run.ts` stops with an error, and writes no file, when more than a quarter of the listening windows got no answer.

## Billing

**What counts: the audio each translation was written from.** Each line has `speech_start` / `speech_end` in `translations.json`: the span of the turn that the chosen reading reported. The billable figure is the union of those spans, counted once where spans overlap. A line that no pass heard has no span. The run also prints how many of the seconds come from ` ??` lines alone, so that share can be taken out or held back until an editor confirms those lines. The figure is in the run output and in `<work-dir>/speech_duration.json`.

The spans are model output in tenths of a second, not an acoustic measurement. Two runs of the same episode differ by 1–3%. Against the earlier deliveries the new figure is 96% in total over the eight Georgia episodes (7,435 s against 7,732 s), and 110 s of it come from ` ??` lines alone.

## Key files

| File | Role |
|------|------|
| `src/run.ts` | CLI: script + video → translated HWPX, one or more episodes; `--list` shows the selection only |
| `src/pipeline.ts` | `runEpisode()`: the steps for one episode, and the model names |
| `src/select.ts` | Which `@@` lines are requested: the rule in plain words, the styles of the document, the doubtful lines |
| `src/script.ts` | `parseScript()`: the script as a timeline; TC typo repair |
| `src/windows.ts` | `planWindows()`: listening windows from the timeline |
| `src/audio.ts` | Decode once, slice windows as WAV in memory |
| `src/brief.ts` | Episode brief: speakers and one spelling for each name |
| `src/prompt.ts` | The script-guided listening prompt and its response schema |
| `src/listen.ts` | `listenOne()` / `listenPass()`: a window, a pass; what to do with a blocked window; the time limit for a window |
| `src/reconcile.ts` | `decide()`: agreement between passes → reading and confidence |
| `src/llm.ts` | `callJson()`: Gemini over REST with schema, time limit, copies of slow calls, retries, two limits, token count |
| `src/relisten.ts` | CLI: listen again to chosen lines (changes nothing) |
| `src/fix.ts` | CLI: change one line, apply, verify, deliver again |
| `src/parser.ts` | `parseMarkers()`: the authority on markers (index, speaker, TC), used by apply and verify |
| `src/replace.ts` | `replaceMarkers()`: inserts translations into the XML; the `Translation` type |
| `src/hwpx.ts` | `extractHwpx()` / `repackHwpx()` (repack clears the data-descriptor flag that hwp2hwpx sets) |
| `src/apply.ts` | CLI: apply a `translations.json` to a HWPX |
| `src/verify.ts` | CLI: check a translated HWPX against its source and `translations.json` |
| `src/markers.ts` | CLI: dump markers and scenes as JSON |
| `src/pipeline.test.ts` | `bun test`: timeline, windows, brief, audio slices, decisions, call wrapper |
| `bench/bench.ts` | Benchmark on earlier episodes (see `bench/README.md`) |
| `tools/hwp2hwpx/convert.sh` | `.hwp` → `.hwpx` (run.ts calls it) |

## When something goes wrong

- **`... listening windows got no answer (the Gemini project has reached its spending cap ...)`:** the monthly cap of the Google project is used up. The user must raise it at https://ai.studio/spend, or wait for the next month. This happened on 10 November 2026 after a day of benchmark runs (about 120 to 130 USD). A normal episode costs about 1.6 USD; a full benchmark run costs about 13 USD.
- **`GEMINI_API_KEY is not set`, or `the Gemini API refused the key`:** the key in `.env` is missing or no longer valid (this happened on 5 and 9 November). Ask the user for a new key. Nothing else can be done.
- **`NOTE: window b012: blocked (OTHER) on …` or `no answer in 150 s`:** that window failed in that pass. The other two passes cut the audio in a different way, so the lines are still decided, at most as medium. If many lines of one scene are ` ??`, run the command again: a pass with a failed window is listened to again.
- **Many 503 "high demand" answers:** the run goes on with backoff, copies and the fallback model, but it is slower. A later run is faster.
- **`no @@ line has the style "bold"`:** the scriptwriter marked the requested lines in another way. The message lists the styles that the `@@` lines have. Run with `--list`, ask the user which style marks the requested lines, and give it with `--select`.
- **`verify: FAILED`:** the delivered file is not written. The problems are printed. A count mismatch means `parseMarkers()` and `replaceMarkers()` disagree on a marker in this script; fix the parser, do not edit the output.
- **A marker TC past the end of the media:** printed as a note. After the typo repair this means that the script and the video do not belong together, or the video is cut short.
- **Other models:** `LISTEN_MODEL`, `FALLBACK_MODEL`, `JUDGE_MODEL`, `BRIEF_MODEL` override the defaults (`gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.8-flash`, `gemini-3.8-flash`). Run the benchmark before you change a default. `gemini-4-argon` ignores `temperature`.

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
