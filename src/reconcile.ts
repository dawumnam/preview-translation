// Decide each marker from independent listens.
//
// The model's own "confidence" does not separate right from wrong (on 949
// markers it said "high" for 922). Agreement between independent listens does.
// On a repeat run of the whole pipeline, a line on which the passes agreed came
// out the same in 97-98% of cases; a line on which they differed came out
// different in 20% of cases or more. So confidence here is a count of passes
// that agree, and a line is flagged (" ??" in the document) when no two
// passes agree.
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
export async function compare(
  pairs: [Candidate, Candidate][],
  judgeModel: string,
  onUnjudged?: (pairs: number) => void,
): Promise<Verdict[]> {
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
        hedgeAfterMs: [10_000, 20_000],
        attempts: 3,
        label: "compare",
      });
      for (const v of r.value ?? []) if (batch.includes(v.id)) out[v.id] = v.verdict;
    }),
  );
  // No verdict from the model: fall back on the text overlap alone.
  const unjudged = out.filter((v) => v === null).length;
  if (unjudged) onUnjudged?.(unjudged);
  return out.map((v, i) => v ?? (textSim(pairs[i][0], pairs[i][1]) >= 0.35 ? "detail" : "different"));
}

export interface Decision {
  marker: number;
  /** The listen that was taken. Not set when nothing was heard. */
  pick?: Candidate;
  /** high: all passes agree. medium: two agree. low: no two agree, or the line was not heard. */
  confidence: "high" | "medium" | "low";
  /** How many listens agree with the pick, the pick included. */
  agree: number;
  /** How many listens heard anything. */
  heard: number;
  reason: string;
}

/**
 * Decides each marker from the passes: every pair of listens of a line is
 * compared, and the reading with the most support wins.
 *
 * An earlier version listened again (three focused listens) to the lines
 * where two passes differed. On a repeat run that made those lines only a
 * little more stable (9.2% → 8.5% of all lines came out different), because
 * they are the lines where the audio itself is unclear, and it added a second
 * round of calls to the run time. Three full passes at once give the same
 * vote with no second round.
 */
export async function decide(
  markers: number[],
  passes: Map<number, Candidate>[],
  judgeModel: string,
  /** Called with the count of pairs that the compare model did not judge (text overlap decided them). */
  onUnjudged?: (pairs: number) => void,
): Promise<Map<number, Decision>> {
  const cands = new Map<number, Candidate[]>();
  const pairs: [Candidate, Candidate][] = [];
  const where: [number, number, number][] = [];
  for (const m of markers) {
    const cs = passes.map((p) => p.get(m)).filter((c): c is Candidate => !!c?.heard);
    cands.set(m, cs);
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        pairs.push([cs[i], cs[j]]);
        where.push([m, i, j]);
      }
  }
  const verdicts = await compare(pairs, judgeModel, onUnjudged);
  const support = new Map<number, number[]>(markers.map((m) => [m, cands.get(m)!.map(() => 1)]));
  where.forEach(([m, i, j], k) => {
    const [x, y] = pairs[k];
    // "detail" with very different lengths of audio is not agreement: one
    // pass took a neighbour's turn as well (1029: a short "네, 네" came back
    // from one pass with the next speaker's 35-second answer attached).
    const lx = x.end - x.start;
    const ly = y.end - y.start;
    const spansDiffer = Math.abs(lx - ly) > Math.max(4, 0.6 * Math.max(lx, ly));
    if (verdicts[k] === "different" || (verdicts[k] === "detail" && spansDiffer)) return;
    support.get(m)![i]++;
    support.get(m)![j]++;
  });

  const out = new Map<number, Decision>();
  for (const m of markers) {
    const cs = cands.get(m)!;
    if (cs.length === 0) {
      out.set(m, { marker: m, confidence: "low", agree: 0, heard: 0, reason: "no pass heard this line" });
      continue;
    }
    const sup = support.get(m)!;
    const best = Math.max(...sup);
    // Among the readings with the most support, take the one of middle length:
    // the longest may hold a neighbour's words and the shortest may be cut off.
    const top = cs.filter((_, i) => sup[i] === best).sort((x, y) => norm(x.source).length - norm(y.source).length);
    const pick = top[Math.floor((top.length - 1) / 2)];
    const all = best === passes.length;
    out.set(m, {
      marker: m,
      pick,
      confidence: all ? "high" : best >= 2 ? "medium" : "low",
      agree: best,
      heard: cs.length,
      reason: all
        ? `all ${passes.length} passes agree`
        : best >= 2
          ? `${best} of ${passes.length} passes agree`
          : cs.length === 1
            ? "only one pass heard this line"
            : "the passes do not agree",
    });
  }
  // Turns must come in script order. If two neighbours are the wrong way
  // round in time, one of them took the other's turn: flag both.
  for (let i = 0; i + 1 < markers.length; i++) {
    const x = out.get(markers[i])!;
    const y = out.get(markers[i + 1])!;
    if (x.pick && y.pick && x.pick.start > y.pick.end + 2) {
      for (const d of [x, y]) {
        if (d.confidence === "low") continue;
        d.confidence = "low";
        d.reason = "this line and its neighbour are in the wrong order in time";
      }
    }
  }
  return out;
}
