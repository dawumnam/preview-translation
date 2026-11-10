# Benchmark

Use this before you change a model, a prompt, the window sizes or the decision rules. It tells you if the change makes the translations better or worse, and how long a run takes.

## What it measures

There is no human reference translation. But the scripts state the content of many foreign-language lines in Korean:

- **A:** a local's `@@` line that is directly followed by the coordinator's Korean interpretation (`코 30년 됐대요`).
- **B:** the coordinator's `@@` line that directly follows a Korean question from the director or the host.

That Korean line is the answer key. For a benchmark run, the pipeline gets the script with those lines hidden, so it cannot copy them. A text model then grades each translation against its answer key: 2 = same content, 1 = same topic, 0 = unrelated. Each line gets three judge votes and the middle value counts, because one vote is noisy (the same text can get 1 or 2).

The eight Georgia episodes of October and November 2026 give 233 such lines out of 949.

Read the score with these limits in mind:

- **It has a ceiling below 1.0.** The interpreter summarises, and for some lines the Korean line next to the marker is about a different turn. The best of four runs, line by line, reached 0.96.
- **It penalises a faithful translation when the interpreter changed the content.** Example: the host asks "there is no supermarket near here, is that not hard?", the coordinator says in Georgian only "is there a market near here at all?", and the correct translation of the coordinator's line scores 1.
- **One run is noisy.** Eight single passes with the same settings scored 0.87 to 0.91. A difference of less than 0.02 between two runs means nothing; run twice.

## Setup

```bash
cp bench/episodes.example.json bench/episodes.json   # then set the paths
bun bench/bench.ts build                             # → bench/work/bench.json
```

Each episode needs the script as `.hwpx` and the video. `delivered` is optional: the `translations.json` of an earlier delivery, as a comparison.

## Commands

```bash
bun bench/bench.ts run <name>              # all episodes at the same time, answer keys hidden, then score
bun bench/bench.ts run <name> 1104,1103    # only these episodes
bun bench/bench.ts score <name>            # score a run again
bun bench/bench.ts delivered               # score the earlier deliveries
bun bench/bench.ts compare <a> <b>         # same / detail / different for each line of two runs
```

`compare` of two runs of the same code is the repeatability check: a line that comes out different on a second run was not heard reliably. Use `compare <name> delivered` to see how far a run is from an earlier delivery.

A full run of the eight episodes costs about 13 USD at the November 2026 price of `gemini-4-argon` and takes about 5 minutes. Mind the spending cap of the Google project: a day of benchmark runs (about 120 to 130 USD) used it up on 10 November 2026.

## Reference results (10 November 2026, 233 lines)

Graded by the three-vote Gemini judge in `bench.ts`:

| Method | Score | Notes |
|---|---|---|
| Earlier deliveries (3 × STT at HIGH thinking, mapper agents, probes, review) | 0.901 | made with the answer keys visible |
| Two passes + three focused listens of disputed lines (an earlier version) | 0.891 | answer keys hidden; high lines 85% full score, medium lines 58% |
| One script-guided pass, `gemini-4-argon` | 0.87–0.91 | eight runs; thinking LOW 0.901, MEDIUM 0.87–0.91, HIGH 0.908; windows of 45 / 60 / 100 s: 0.886 / 0.897 / 0.908 |
| One script-guided pass, `gemini-3.8-flash` | 0.85 | LOW 0.852, MEDIUM 0.845 |

The current design (three passes at once, majority vote) ran on all eight episodes, but the Google project reached its spending cap before the Gemini judge could score it. Three Claude graders scored it in its place, blind and in pairs with two other results (same rubric, the three systems in a shuffled order for each line):

| Method | Score | Full / partial / zero |
|---|---|---|
| Earlier deliveries | 0.933 | 208 / 19 / 6 |
| Three passes, majority vote (current) | 0.933 | 208 / 19 / 6 |
| Two passes + focused listens | 0.931 | 207 / 20 / 6 |

Line by line, the current design is better than the earlier deliveries on 7 lines and worse on 7. The Claude graders are more lenient than the Gemini judge, so compare scores only inside one table. To get the Gemini-judge score of the current design, run `bun bench/bench.ts run <name>` when the cap is raised.

`compare` results: the two-round version against the earlier deliveries: 69% same, 21% detail, 10% different. Two runs of that version against each other: 7 to 9% different, nearly all on lines where the passes did not agree.

A separate blind test (80 lines, short clips, no script shown, one judge vote): `gemini-4-argon` 0.89–0.90, `gemini-3.8-flash` LOW 0.84, MEDIUM 0.84, HIGH 0.89, `gemini-3.1-pro-preview` 0.80–0.81. `gemini-3.5-transcribe` gave exact word times for Korean speech but did not transcribe the quiet Georgian lines.
