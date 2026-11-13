# Preview writer (experiment)

Writes the preview document (프리뷰 노트) of a day of raw footage from the video alone. This is the document that a human 프리뷰어 writes before the scriptwriter marks the `@@` lines for translation: scene headers, a TC and a description for each shot, the Korean speech word for word with speaker labels, `@@(조)` for each foreign-language turn, and `디렉` for directions.

Status: an experiment on branch `preview-gen-experiment`. It was tuned on Georgia 1023 and on stretches of 1104 and 1105, and tested on 1022. The sections below are in the order of the work: the first round (prompts 1 to 3, one pass), the second round (shot rules, a picture-only pass, two-level scenes, the camera-file layout), and the third round (where the writers put a TC line; the TC clock). `run.ts` does what the third round says. The translator in `src/` is not changed, except for two small additions to `src/llm.ts` (extra `generationConfig` fields, token count for each media type) and one export in `src/script.ts`.

## Run

```bash
bun previewgen/run.ts <video>.mp4 --template "<an earlier preview>.hwp" --out <dir>
bun previewgen/run.ts <video>.mp4 --template <earlier>.hwpx --out <dir> --reference <human preview>.hwpx   # also prints the score
```

Run it from the project root (bun reads `GEMINI_API_KEY` from `.env`). It needs `ffmpeg`, and for a `.hwp` template the Homebrew OpenJDK (as the translator does).

- `<dir>/<id>_preview.hwpx` and `.txt`: the document as a flat list, like the human previews. `<id>` is the first four digits in the name of the video.
- `--notes fewer`: fewer shot lines inside a take (see the third round below).
- `--by-camera-file`: also writes `<id>_preview_by_camera_file.hwpx` and `.txt`, with one head line for each camera file (see below). It is not the target layout.
- `<dir>/<id>_preview_work/`: cut list, decoded sound, clips, `windows.json` (every turn that the model heard, with its tag and its exact time) and `preview.json` (the lines of the document with exact times).
- `--template`: an earlier preview of the same programme. Page setup, fonts and styles come from it. Without it only the text file is written.
- A second run uses the windows that are already in the work directory. `--fresh` sends all windows again.
- `--manual-text`: the two text steps (names, scenes) write their prompt to the work directory and read the answer from `cast.answer.json` / `scenes.answer.json`. Use it to try another text model.

## How it works

```
video ──► cuts (ffmpeg scene score, no model) ──► windows of about 5 minutes that start at a cut
      ──► for each window: a small mp4 (2 frames per second, 16 kHz mono) to gemini-4-argon, all at the same time
              the model returns shots, turns (speaker, language, Korean words) and a tag for each turn
      ──► one label for one local person (text call)
      ──► house style, by code: talk off the record → 디렉, TC rules
      ──► scenes and titles (text call)
      ──► .txt and .hwpx
```

1. **Cuts (`cuts.ts`).** The footage is raw camera files joined end to end, so a jump of the picture is the start of a new file. ffmpeg finds the jumps in 12 s for a 99-minute proxy. The window borders are put on cuts. Inside a long take a border goes to the quietest moment near the target length. The model gets the cut times of its window as a hint.
2. **Watch (`gen.ts`, `prompt.ts`, `clip.ts`).** One call for each window with picture and sound together. The model looks at 1 frame per second at low media resolution (about 100 tokens for each second of video, sound included). It returns shot entries and speech entries. Foreign-language turns have no text. Each speech entry has a tag: `take` (part of the programme), `ask` (the crew says what must be asked or said) or `direct` (talk about how to shoot, and all other talk off the record).
3. **Names (`cast.ts`).** Each window names the locals by look on its own. A text call reads the notes of all windows and says which notes are the same person; code renames.
4. **House style (`assemble.ts`).** The model writes down all that it hears; the style of the human writers is applied by code, so a change of style needs no new model call. A stretch of `direct` talk becomes one `피<tab>디렉` line when the crew says at least 30 characters in it. A speech line shows its TC when it starts 8 s or more after the last TC shown.
5. **Scenes (`scenes.ts`).** A text call on the finished lines gives the `# title` lines and the table of contents.
6. **Write (`write.ts`).** The body of the template is replaced; the styles of the title, the scene lines and the body lines are read from the template's own paragraphs. Hancom Office HWP (Mac) opens the result with the layout of the human previews.

## Results on 1023 (99 minutes, 20 windows)

`score.ts` compares the output with the human preview of the same video. Time for the watch step: 65 to 102 s. Cost: 1.87 USD at the November 2026 list price of `gemini-4-argon` (686k input tokens, 50k output tokens), that is 1.13 USD for each hour of video. The price doubles on 1 December 2026.

| What | Every turn, no style | House style, prompt 2 | House style, prompt 3 (see the warning) |
|---|---|---|---|
| Korean lines of the human preview that are in the output | 126 of 133 (95%) | 120 (90%) | 124 (93%) |
| Speaker of those lines (큐, 코, 피, 카감) is the same | 96% | 98% | 98% |
| Time of those lines against the TC that the writer typed | | median 0.5 s off, 87% within 3 s | median 0.5 s off, 88% within 3 s |
| Foreign-language turns (`@@`) of the human preview that are in the output | 122 of 131 (93%) | 110 (84%) | 118 (90%) |
| The same, when the turns inside talk off the record are kept | | 122 (93%) | 127 (97%) |
| Shot lines of the human preview with a generated shot line at the same place | | 71 of 100 | 78 of 100 |
| Generated Korean lines that the human preview does not have | 76% of 558 | 25% of 166 | 28% of 184 |
| Generated shot lines with no human shot line at that place | | 22% of 91 | 31% of 113 |
| `디렉` lines: human, generated, matched | | 19, 36, 15 | 19, 33, 15 |

**Warning about prompt 3.** Prompt 3 added examples of what the crew's requests look like, and I took those examples from the human preview of 1023, the same episode that the score is measured on. Some shot phrases and one line of the example stretch of prompts 1 to 3 also came from it. So the prompt 3 column is too good by an unknown amount, and the text likeness of the shot lines (0.58 to 0.64) is too good in all columns. The count of lines found by time, the speakers and the times do not depend on those examples. The examples in the code are now from other episodes or made up, and that wording has not been run yet. Read the result as: 90 to 95% of the Korean lines, 84 to 97% of the foreign-language turns and 71 to 78% of the shot lines.

Other points:

- Nearly all of the output that the human preview does not have is real: requests of the director that the writer left as `디렉`, short exchanges that the writer left out, shots that the writer did not log. The document has 522 lines against 395 lines of the human preview.
- The model gave the two locals of this episode the labels 두여 and 할, the same as the human writer (the prompt explains the naming rule; 두여 is one of its examples). One window of 20 wrote 모여 for 두여.
- The human preview is not an exact reference. The writer leaves `?` where a word is unclear (the model often has the word), sometimes gives a line to the wrong speaker, and decides line by line how much of the talk off the record to keep. So 100% is not possible, and a line that only one side has is not always an error of that side.

## What was tried

| Question | Result |
|---|---|
| One call with picture and sound, or sound and picture apart? | One call. The model then knows who is in the picture when someone speaks, and it gave the locals the same labels as the human writer. Not compared with a split by measurement. |
| Does the model hear the Korean speech? | Yes. The first prompt found 93% of the human Korean lines with no tuning. |
| Why did the first prompt look wrong? | It wrote down the talk between takes in full (335 Korean lines against 133) and a shot line for each change of framing in an interview (152 shot lines against 100). The human writers do not. |
| How to get the house style? | The model tags each turn, and code makes the `디렉` lines. With the first wording of the tags (prompt 2) the model put the director's requests about the content under `direct`, and about 10% of the human foreign-language turns were lost with them. Examples of `ask` and `direct` in the prompt (prompt 3) gave 84% → 90% for foreign turns and 90% → 93% for Korean lines, but those examples came from this episode (see the warning). |
| Cut times in the prompt and windows that start at a cut? | Generated shot lines with a human shot line at the same place: 55% (prompt 1) → 78% (prompt 2), with about the same share of human shot lines found (74% → 71%). A shot line at the start of each window is gone. |
| How many `디렉` lines? | The human preview has 19. With a `디렉` line for each stretch of talk off the record the output had 71; with a minimum of 30 characters of crew talk it has 33, and 15 of the 19 are matched. |
| Foreign turns of one speaker with a short gap: one line or several? | A merge of turns less than 10, 15 or 25 s apart changed recall and precision by 2 points or less. The default merges below 10 s. |

Not measured, because the spending cap of the Google project was reached on 13 November 2026 (see "When something goes wrong" in `CLAUDE.md`):

- The names step and the scenes step with a Gemini model. Both were run once on 1023 with Claude as the text model, through `--manual-text`. Names: the 15 window notes became the two persons 두여 and 할, which is correct. Scenes: 9 scenes against 6 of the human preview; 3 of the 6 human scene starts have a generated start within 30 s (4 within 45 s), and the titles are in the house style. The scene step is the least exact part.
- A second episode, above all one with many locals in one scene (1024, 1028).
- `gemini-3.8-flash` for the watch step (about a third of the price), the Batch API (half the price), medium media resolution, windows of 2 or 10 minutes, and the agreement between two runs of the same episode.

## Second round: shot lines, TCs, scenes (13 November 2026)

The aim was 95% agreement with the human preview for shot lines with TC and for scene titles. Free checks on all 9 Georgia episodes (24.4 hours, 2,702 human shot lines, 104 human scenes), then model runs on stretches of 1023, 1104 and 1105 (35 minutes, 94 human shot lines).

What the human previews are made of:

| Fact | Number |
|---|---|
| Human shot lines that stand at a camera cut (a jump of the picture that code finds) | 47%. The other 53% are notes inside a running take: a new take, a new action, a new subject. A detector for picture changes of all kinds does not find these better than chance. |
| Camera cuts that the human gives a shot line | 89% (a TC line of any kind: 93%) |
| TC of a shot line after its cut | median 1.4 s; by episode 0.0 s to 3.6 s; up to 12 s |
| Speech lines with a TC of their own | 25% to 48% by episode |
| `디렉` lines in one episode | 0 (two episodes) to 55 |
| Length of a scene | 1.0 to 51.2 minutes; 6 to 19 scenes in one episode |

What was measured:

| Question | Result |
|---|---|
| Human shot lines found, by kind (1023, prompt 3) | at a cut 96 to 100%; inside a take 50 to 66% |
| Do two runs of the model agree with each other? | Shot lines at a cut: 98 to 100%. Shot lines inside a take: 58 to 87%. So the notes inside a take are not repeatable, also for the same writer. |
| Does a union of three runs of the same kind help? | No: 83% against 82% for the best run. The runs miss the same lines. |
| New shot rules in the prompt (new take, new action also during talk, each step of a work process, slate, a line every 30 s in a long shot of one kind) | Human shot lines found on the stretches: 71% → 78%; inside a take 49% → 59% |
| A second pass with the picture only (no sound, shot entries only) | `gemini-3.8-flash` alone: 87% found with 142 lines against 94; `gemini-4-argon` alone: 83% with 110 lines. It costs about 0.2 USD for an hour of video with Flash. |
| The usual pass and the two picture-only passes joined | 89 of the 94 human shot lines have a generated shot line within -10/+5 s (95%), with about 140 lines against 94. Lines that two of the three passes have: 88% with 110 lines. This is not in `run.ts` yet. |
| TC of a shot line at a cut: the cut, or a little after it? | The document now shows cut + 2 s (`CUT_LAG`): within 3 s of the writer's TC for 88% of such lines, against 76% with the cut itself. |
| TCs of any kind of line | The output shows a TC within 10 s of 96% of the human TCs, and within 5 s of 79 to 89%. |
| Scene starts, tested on the human previews (the "#" lines taken out, then asked for) | Base prompt: 66 of 104 human scene starts found within 30 s (63%), 115 scenes made. With two other episodes as examples: 71 found (68%), 137 made. The model starts scenes at the same moments as the writer, but it divides long visits that the writer left as one scene. |

### Test on an episode that was not used for tuning: 1022 (110 minutes)

`run.ts` now sends each window two times: the usual pass (`gemini-4-argon`, picture and sound) and a picture-only pass (`gemini-3.8-flash`, shot entries only; `--no-shot-pass` turns it off). `joinShots()` adds the shot lines of the second pass where the first has none. The names step and the scenes step ran with Gemini. Time 130 s, cost 2.48 USD (2.07 for the usual pass and the text steps, 0.41 for the picture-only pass).

| What | Result against the human preview of 1022 |
|---|---|
| Korean lines found | 115 of 123 (93%); same speaker 95% |
| Foreign-language turns found | 119 of 135 (88%); same speaker 93% |
| Shot lines found | 152 of 175 (87%): at a camera cut 89 of 95 (94%), inside a take 63 of 80 (79%) |
| Generated shot lines | 278 against 175; 55% have a human shot line at their place |
| A shown TC of the output near a human TC (any kind of line) | within 5 s for 87%, within 10 s for 96% |
| Scene starts | 6 of 9 human scene starts within 30 s; 15 parts on two levels. Titles such as 빵 만드는 두여, 두여 인터뷰 are the same as the writer's. |
| Main local | 두여, the label of the human writer |
| Camera files | 115; 7 of them have no description of their own (the talk went on over the cut) |

So the stretches used for tuning gave 93% for shot lines and the test episode 87%. The missed lines are for the most part one more pan or tilt on a subject that the output has a line for.

## A layout with the camera file as the unit (`cliplayout.ts`)

The human preview is one flat list. A shot line can be a fact (a new camera file starts) or a note of the writer (something new inside the take), and the two look the same. Agreement on the facts is 96 to 100%; agreement on the notes is 50 to 66%, and no better between two runs of one model. A target of 95% for the list as a whole measures the notes.

`bun previewgen/cliplayout.ts <work-dir> --template <preview>.hwpx` writes the same content in another frame:

- one head line for each camera file, with its exact start and its length: `0444<tab>■ 걸어가는 큐 후면 (1:15)`;
- below it the notes inside the file (`· text`) and the spoken turns, each with its own TC;
- at the top, the locals of the day with their look, so each label has a meaning.

It needs no model call: it reads `preview.json` and the cut list of a finished run. 1023 has 56 camera files; the model has its own description for 54.

`bun previewgen/checklayout.ts <work-dir> <id>_preview_by_camera_file.txt` checks the frame of that document with no model call. For 1022: 115 recordings found by the code, 115 head lines, each at the start second of its recording; the blocks cover 6,611.1 s of 6,611.1 s; each length shown is right to 0.5 s; 108 head lines have their own description and 7 say 이어서; 3 recordings are 2 s or shorter.

What this check does not cover: the words of a line, the notes inside a recording, and the spoken turns are model output (measured against the human preview, see the tables above). A cut that the detector does not find joins two recordings in one block; no footage is lost from the document, only the border. Of the cuts that the detector found in the nine episodes, 93% have a TC line of the human writer in the 12 s after them, so it seldom finds a cut where there is none. How many it misses is not known; a clip list from the edit system (EDL or XML) would give the exact borders.

Example (1022, 16:05 to 21:20): the code finds 9 recordings. The human preview has a shot line for 6 of them and no line for 3 (two false starts of 14 s and 13 s at 16:22 and 16:36, and 19 s of crew talk at 18:18). In the flat list a reader cannot see that they are there.

## Third round: where the writers put a line with a TC (13 November 2026)

The camera-file layout is not the target: the lines with a TC must stand where a human writer puts them, and a jump of the picture is not that rule. This round asked what decides the place. Data: the nine human previews (24.4 h of video, 4,225 gaps between two TC lines). No model call, if not said.

| Fact | Number |
|---|---|
| Lines that have a TC | shot lines 99%, Korean speech 44% (host 54%, interpreter 34%, director 26%), foreign-language lines 25%, `디렉` 11% |
| Seconds between two TC lines | under 5 s: 2%; 5 to 10 s: 13%; 10 to 25 s: 56%; 25 to 40 s: 20%; above 40 s: 8%. Median 17 s. |
| A speech line has a TC, by the seconds since the last TC (1022 and 1023, 507 lines; the time of a line with no TC comes from the model output) | under 6 s: 2%; 6 to 9 s: 34%; 9 to 25 s: 51%; 25 to 40 s: 78%; above 40 s: 89% |
| Shot lines that stand at a cut | 47% with the fixed limit, 53% with a detector that adapts to dark footage (it finds cuts that the fixed limit misses, but 22% of its cuts have no human shot line after them, against 11%) |
| The other shot lines, by what they describe | what people do: 55%; a thing or a place: 22%; a framing code only (sk, cs ...): 16%; a camera move (pan, tu, td, tr): 7% |
| Do they follow the sound? | No. Of the starts of speech after 5 s of silence, 50% have a human TC line near them. Shot lines stand in quiet moments as often as chance (50% against 54% of the time). They are 2.2 times as dense when nobody talks (2.5 for each minute against 1.1). |
| Do they follow a change of the picture other than a cut? | No better than chance (second round). |

So the writer keeps a clock. A new TC line comes when something new starts (a shot, an action, a turn after a pause) and the last TC is some seconds back: hardly ever within 5 s, about half of the time between 9 and 25 s, nearly always after 40 s. Which of the possible moments gets the line is the writer's choice. The share of speech lines with a TC is 25 to 48% from one preview to the next.

What was tried to copy the placement (1022 and 1023; the two numbers are for these two episodes):

| Method | Shot lines, against the human count | Human shot lines found (-10/+5 s) | Output shot lines at a human line |
|---|---|---|---|
| All notes of the model (the default) | 1.6 and 2.2 times | 87%, 92% | 55%, 42% |
| Clock on the notes: no note within 10 s of the last TC (`--notes fewer`) | 1.2 and 1.5 times | 81%, 83% | 65%, 54% |
| Editor (`editor.ts`): a text model edits the log into the writer's form; it gets pairs (machine log, human preview) from the other episode | 1.0 and 1.3 times | 76%, 81% | 74%, 64% |
| Example clips with the human lines in the request (`--examples`, picture-only pass, 10 minutes of 1104) | 1.2 times | 77% (81% with no examples) | 65% (60%) |

- The lines at a cut are found at 92 to 100% in all rows. The numbers differ in the notes inside a take.
- At the count of lines of the human, about 3 in 4 lines stand at the same places, with each method. More lines find more of the human lines.
- By content, judged by a text model (same subject and same action within 20 s before to 15 s after the human TC): with all notes, 79% and 78% of the human shot lines have the same picture in the output, and 97% and 95% the same subject. With `--notes fewer`: 70% and 68%.
- TC lines of all kinds with the default: the output has a TC within 5 s of 84% and 86% of the human TCs (within 10 s: 95% and 98%), with 1.4 and 1.6 times as many TCs.
- 1023 with the current code (prompt with no example from 1023, picture-only pass, Gemini for names and scenes): Korean lines 95%, foreign-language turns 91%, shot lines 92% (100% at a cut, 83% inside a take), all 6 scene starts within 30 s (13 parts).

What `run.ts` does now: all shot notes stay; `placeTc()` decides with the clock which speech lines show their TC (Korean 46 to 54%, foreign 26 to 27% of the lines); the camera-file layout is written only with `--by-camera-file`.

Open: a bar for the notes inside a take. Agreement of 95% with one writer's free choices is not in reach of the methods above. The right reference is how far two human writers agree on the same footage; no footage with two previews was at hand.

## Relation to the translator

`preview.json` has the exact start time of each `@@` line. The translator (`src/`) finds the speech of a marker between the TCs that a human typed; with a generated preview it can take the time of the line itself.

## Files

| File | Role |
|---|---|
| `run.ts` | CLI: video → document |
| `gen.ts` | `watch()`: windows to the model; CLI for a part of a video (`--from`, `--to`, `--ranges`) |
| `prompt.ts` | The prompt and the response schema of the watch step |
| `clip.ts` | A window as a small mp4 |
| `cuts.ts` | Cuts, loudness, window plan |
| `assemble.ts` | House style: `디렉` lines, shot clean-up, TC rules |
| `cast.ts` | One label for one person |
| `scenes.ts` | Scene headers |
| `write.ts` | Text and HWPX output |
| `editor.ts` | The editor step (tested, not in `run.ts`): a text model edits the machine log with pairs from another episode |
| `cliplayout.ts` | CLI: the layout with the camera file as the unit |
| `checklayout.ts` | CLI: check the frame of that layout against the cut list (no model call) |
| `gt.ts` | Reads a human preview (`.hwpx`) as lines |
| `score.ts` | CLI: compare an output with a human preview (`--list` shows each difference) |
| `show.ts` | CLI: print an output next to the human preview |
| `previewgen.test.ts` | `bun test previewgen` |
| `study/` | The scripts behind the numbers in this file (`tcstudy.ts`, `tchazard.ts`, `silence_study.ts`, `shotstudy.ts`, `rhythm_eval.ts`, `editor_eval.ts`, `coverage.ts`, `scenes_eval.ts` and others; `py/` has the frame, speech-activity and figure scripts). They read data under `exp/previewgen/` that is not in git: `media/<id>.mp4`, `gt/<id>.hwpx` (the human previews), `scores/<id>.txt` (ffmpeg scene score of each frame), `vad/<id>.json`, and the work directories of finished runs. |
