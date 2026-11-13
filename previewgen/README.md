# Preview writer (experiment)

Writes the preview document (프리뷰 노트) of a day of raw footage from the video alone. This is the document that a human 프리뷰어 writes before the scriptwriter marks the `@@` lines for translation: scene headers, a TC and a description for each shot, the Korean speech word for word with speaker labels, `@@(조)` for each foreign-language turn, and `디렉` for directions.

Status: an experiment on branch `preview-gen-experiment`. It was measured on one episode (Georgia 1023, 99 minutes). The translator in `src/` is not changed, except for two small additions to `src/llm.ts` (extra `generationConfig` fields, token count for each media type) and one export in `src/script.ts`.

## Run

```bash
bun previewgen/run.ts <video>.mp4 --template "<an earlier preview>.hwp" --out <dir>
bun previewgen/run.ts <video>.mp4 --template <earlier>.hwpx --out <dir> --reference <human preview>.hwpx   # also prints the score
```

Run it from the project root (bun reads `GEMINI_API_KEY` from `.env`). It needs `ffmpeg`, and for a `.hwp` template the Homebrew OpenJDK (as the translator does).

- `<dir>/<id>_preview.hwpx` and `<dir>/<id>_preview.txt`: the document. `<id>` is the first four digits in the name of the video.
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
| `gt.ts` | Reads a human preview (`.hwpx`) as lines |
| `score.ts` | CLI: compare an output with a human preview (`--list` shows each difference) |
| `show.ts` | CLI: print an output next to the human preview |
| `previewgen.test.ts` | `bun test previewgen` |
