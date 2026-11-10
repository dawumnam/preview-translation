# Benchmark

Use this before you change a model, a prompt, the window sizes or the decision rules. It tells you if the change makes the translations better or worse, and how long a run takes.

## What it measures

There is no human reference translation. But the scripts state the content of many foreign-language lines in Korean:

- **A:** a local's `@@` line that is directly followed by the coordinator's Korean interpretation (`코 30년 됐대요`).
- **B:** the coordinator's `@@` line that directly follows a Korean question from the director or the host.

That Korean line is the answer key. For a benchmark run, the pipeline gets the script with those lines hidden, so it cannot copy them. A text model then grades each translation against its answer key: 2 = same content, 1 = same topic, 0 = unrelated. Each line gets three judge votes and the middle value counts, because one vote is noisy.

The eight Georgia episodes of October and November 2026 give 232 such lines out of 949.

The score has a ceiling below 1.0. The interpreter summarises, and for some lines the Korean line next to the marker is about a different turn. On these episodes the best of four runs reached 0.96.

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

A full run of the eight episodes costs about 10 USD at the November 2026 price of `gemini-4-argon` and takes 4 to 5 minutes.

## Reference results (10 November 2026)

| Method | Score (232 lines) | Notes |
|---|---|---|
| Earlier deliveries (3 × STT at HIGH thinking, mapper agents, probes, review) | 0.916 | made with the answer keys visible |
| One script-guided pass, `gemini-4-argon` | 0.91–0.92 | thinking LOW/MEDIUM/HIGH: 0.909 / 0.918 / 0.916 |
| One script-guided pass, `gemini-3.8-flash` | 0.86–0.88 | LOW 0.869, MEDIUM 0.875 |

Blind listening on short clips (80 lines, no script shown): `gemini-4-argon` 0.89–0.90, `gemini-3.8-flash` LOW 0.84, MEDIUM 0.84, HIGH 0.89, `gemini-3.1-pro-preview` 0.80–0.81. `gemini-3.5-transcribe` gave exact word times for Korean speech but did not transcribe the quiet Georgian lines.
