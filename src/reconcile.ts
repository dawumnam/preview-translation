// Decide each marker from independent listens.
//
// The model's own "confidence" does not separate right from wrong (on 949
// markers it said "high" for 922). Agreement between independent listens does.
// On a repeat run of the whole pipeline, a line whose two passes agreed came
// out the same in 97-98% of cases; a line whose passes differed came out
// different in 20% of cases or more. So confidence here is a count of listens
// that agree, and a line is flagged (" ??" in the document) when fewer than
// three of five listens agree.
import { callJson } from "./llm";
import type { Candidate } from "./listen";

export type Verdict = "same" | "detail" | "different";

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[\s.,!?~…"'“”‘’()\-·:;]/g, "");
function grams(s: string, n: number): Set<string> {
  const t = norm(s);
  const g = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) g.add(t.slice(i, i + n));
  if (!g.size && t) g.add(t);
  return g;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
/** Text overlap of two candidates: the better of the source words and the Korean words. */
export function textSim(a: Candidate, b: Candidate): number {
  return Math.max(jaccard(grams(a.source, 3), grams(b.source, 3)), jaccard(grams(a.ko, 2), grams(b.ko, 2)));
}

const JUDGE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { id: { type: "INTEGER" }, verdict: { type: "STRING", enum: ["same", "detail", "different"] } },
    required: ["id", "verdict"],
  },
};

/**
 * Do two listens of the same line say the same thing? Close text is "same"
 * with no model call. The rest go to a text model in batches.
 */
export async function compare(pairs: [Candidate, Candidate][], judgeModel: string): Promise<Verdict[]> {
  const out: (Verdict | null)[] = pairs.map(([a, b]) => (textSim(a, b) >= 0.6 ? "same" : null));
  const open = out.flatMap((v, i) => (v === null ? [i] : []));
  const batches: number[][] = [];
  for (let i = 0; i < open.length; i += 30) batches.push(open.slice(i, i + 30));
  await Promise.all(
    batches.map(async (batch) => {
      const prompt = `Two interpreters each listened to the same foreign-language line in raw TV footage, wrote down what they heard, and translated it into Korean. For each pair, decide:
- "same": both heard the same thing (wording, politeness level, filler words and the spelling of names may differ).
- "detail": the same core message, but one has an extra sentence or detail, or one small detail differs (a number, a name).
- "different": they heard different things, or the messages differ in substance.

${batch
  .map((i) => {
    const [a, b] = pairs[i];
    return `### ${i}\nA heard: ${a.source}\nA: ${a.ko}\nB heard: ${b.source}\nB: ${b.ko}`;
  })
  .join("\n\n")}`;
      const r = await callJson<{ id: number; verdict: Verdict }[]>({
        model: judgeModel,
        parts: [{ text: prompt }],
        schema: JUDGE_SCHEMA,
        thinkingLevel: "LOW",
        temperature: 0,
        timeoutMs: 90_000,
        attempts: 3,
        label: "compare",
      });
      for (const v of r.value ?? []) if (batch.includes(v.id)) out[v.id] = v.verdict;
    }),
  );
  // No verdict from the model: fall back on the text overlap alone.
  return out.map((v, i) => v ?? (textSim(pairs[i][0], pairs[i][1]) >= 0.35 ? "detail" : "different"));
}

export interface Decision {
  marker: number;
  /** The listen that was taken. Not set when nothing was heard. */
  pick?: Candidate;
  /** high: the two full passes agree. medium: three or more of five listens agree. low: fewer agree, or not heard. */
  confidence: "high" | "medium" | "low";
  /** How many listens agree with the pick, the pick included. */
  agree: number;
  /** How many listens heard anything. */
  heard: number;
  reason: string;
}

/** When two listens agree, take the fuller one if the other is just shorter. */
function fuller(a: Candidate, b: Candidate, v: Verdict): Candidate {
  if (v === "detail" && norm(b.source).length > norm(a.source).length * 1.15) return b;
  return a;
}

/** First round: the two full passes. Returns a decision where they agree, null where focused listens are needed. */
export async function firstRound(
  a: Map<number, Candidate>,
  b: Map<number, Candidate>,
  markers: number[],
  judgeModel: string,
): Promise<Map<number, Decision | null>> {
  const both = markers.filter((m) => a.get(m)?.heard && b.get(m)?.heard);
  const verdicts = await compare(both.map((m) => [a.get(m)!, b.get(m)!]), judgeModel);
  const v = new Map(both.map((m, i) => [m, verdicts[i]]));
  const out = new Map<number, Decision | null>();
  for (const m of markers) {
    const verdict = v.get(m);
    // "detail" with very different lengths of audio is not agreement: one
    // pass took a neighbour's turn as well (1029: a short "네, 네" came back
    // from one pass with the next speaker's 35-second answer attached).
    let spansDiffer = false;
    if (verdict === "detail") {
      const la = a.get(m)!.end - a.get(m)!.start;
      const lb = b.get(m)!.end - b.get(m)!.start;
      spansDiffer = Math.abs(la - lb) > Math.max(4, 0.6 * Math.max(la, lb));
    }
    if (verdict && verdict !== "different" && !spansDiffer) {
      out.set(m, {
        marker: m, pick: fuller(a.get(m)!, b.get(m)!, verdict), confidence: "high", agree: 2, heard: 2,
        reason: verdict === "same" ? "two passes agree" : "two passes agree; one has more detail",
      });
    } else out.set(m, null);
  }
  // Turns must come in script order. If two neighbours that both look settled
  // are the wrong way round in time, one of them took the other's turn.
  for (let i = 0; i + 1 < markers.length; i++) {
    const x = out.get(markers[i])?.pick;
    const y = out.get(markers[i + 1])?.pick;
    if (x && y && x.start > y.end + 2) {
      out.set(markers[i], null);
      out.set(markers[i + 1], null);
    }
  }
  return out;
}

/**
 * Second round: the lines where the two passes differ get several focused
 * listens. All listens of a line are compared with each other, and the reading
 * with the most support wins. Three listens that agree make the line "medium".
 * Fewer make it "low", and the document flags it.
 *
 * One focused listen (two of three agree) was not enough: on a repeat run,
 * about a quarter of the lines decided that way came out different.
 */
export async function consensus(
  open: number[],
  passes: Map<number, Candidate>[],
  focused: Map<number, Candidate>[],
  judgeModel: string,
): Promise<Map<number, Decision>> {
  const cands = new Map<number, Candidate[]>();
  const pairs: [Candidate, Candidate][] = [];
  const where: [number, number, number][] = [];
  for (const m of open) {
    const cs = [...passes, ...focused].map((l) => l.get(m)).filter((c): c is Candidate => !!c?.heard);
    cands.set(m, cs);
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        pairs.push([cs[i], cs[j]]);
        where.push([m, i, j]);
      }
  }
  const verdicts = await compare(pairs, judgeModel);
  const support = new Map<number, number[]>(open.map((m) => [m, cands.get(m)!.map(() => 1)]));
  const detail = new Map<string, Verdict>();
  where.forEach(([m, i, j], k) => {
    if (verdicts[k] === "different") return;
    support.get(m)![i]++;
    support.get(m)![j]++;
    detail.set(`${m}:${i}:${j}`, verdicts[k]);
  });

  const isFocused = (c: Candidate) => focused.some((l) => l.get(c.marker) === c);
  const out = new Map<number, Decision>();
  for (const m of open) {
    const cs = cands.get(m)!;
    if (cs.length === 0) {
      out.set(m, { marker: m, confidence: "low", agree: 0, heard: 0, reason: "no listen heard this line" });
      continue;
    }
    const sup = support.get(m)!;
    const best = Math.max(...sup);
    // Among the readings with the most support, take the one of middle length:
    // the longest may hold a neighbour's words and the shortest may be cut
    // off. Between equals, a focused listen had the closer look.
    const top = cs
      .filter((_, i) => sup[i] === best)
      .sort((x, y) => norm(x.source).length - norm(y.source).length || Number(isFocused(y)) - Number(isFocused(x)));
    const pick = top[Math.floor((top.length - 1) / 2)];
    const total = passes.length + focused.length;
    out.set(m, {
      marker: m,
      pick,
      confidence: best >= 3 ? "medium" : "low",
      agree: best,
      heard: cs.length,
      reason:
        best >= 3
          ? `${best} of ${total} listens agree`
          : best === 2
            ? `only 2 of ${total} listens agree`
            : cs.length === 1
              ? "only one listen heard this line"
              : "the listens do not agree",
    });
  }
  return out;
}
