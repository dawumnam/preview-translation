// Usage: bun previewgen/study/rules_eval.ts
// Rules for the shot lines that follow the writer's measured habits, on the saved logs of 1022 and 1023.
// No model call.
import { loadGt } from "../gt";
import { score } from "../score";
import { candidates, type Candidate } from "./candidates";

const RUNS: Record<string, string> = { "1023": "exp/previewgen/out2/1023_preview_work", "1022": "exp/previewgen/out/1022_preview_work" };
const pc = (x: number) => `${Math.round(100 * x)}%`;

for (const [id, dir] of Object.entries(RUNS)) {
  const d = candidates(id, dir);
  const gt = loadGt(`exp/previewgen/gt/${id}.hwpx`);
  const talk = d.lines.map((l, i) => ({ l, i })).filter((x) => x.l.kind !== "shot" && x.l.use !== "direct");
  /** Seconds from a time to the next turn that stays in the document. */
  const toTalk = (t: number) => Math.min(Infinity, ...talk.filter((x) => x.l.tc! >= t - 1).map((x) => x.l.tc! - t));
  const evalAt = (name: string, keep: (c: Candidate) => boolean) => {
    const drop = new Set(d.cands.filter((c) => !keep(c)).map((c) => c.i));
    const s = score(d.lines.filter((_, i) => !drop.has(i)), gt, [[0, d.dur + 1]], false, d.cuts);
    const r = s.shot.matched / s.shot.ref;
    const q = s.shot.matched / Math.max(1, s.shot.gen);
    console.log(`  ${name.padEnd(64)} ${String(s.shot.gen).padStart(3)} lines (${(s.shot.gen / s.shot.ref).toFixed(2)} times) | found ${pc(r)} (cut ${pc(s.shotAt.cutFound / s.shotAt.cutRef)}, inside ${pc(s.shotAt.insideFound / Math.max(1, s.shotAt.insideRef))}) | at a human line ${pc(q)} | F1 ${pc((2 * r * q) / (r + q))}`);
  };
  const state = (c: Candidate) => /^(.{0,12})(bs|2s|3s|fs|ws|gs|os)$/i.test(c.text.trim()) || /(대화하는|이야기하는|얘기하는|설명하는|말하는|인터뷰하는|듣는)/.test(c.text);
  const main = (c: Candidate) => c.atCut || c.inMain;
  const speechFirst = (c: Candidate, s: number) => c.atCut && toTalk(c.tc) <= s;
  const shortTake = (c: Candidate, s: number) => c.atCut && c.toNextCut < s;
  console.log(`${id}: ${d.humanShots} human shot lines`);
  evalAt("all candidates", () => true);
  evalAt("A: no line of the picture-only pass alone", main);
  evalAt("B: A + no line at a cut when talk starts within 3 s", (c) => main(c) && !speechFirst(c, 3));
  evalAt("B: A + no line at a cut when talk starts within 5 s", (c) => main(c) && !speechFirst(c, 5));
  evalAt("C: A + no line for a take under 8 s", (c) => main(c) && !shortTake(c, 8));
  evalAt("D: A + B(5) + C", (c) => main(c) && !speechFirst(c, 5) && !shortTake(c, 8));
  evalAt("E: D + no state note inside talk (bs, 2s, 대화하는 …)", (c) => main(c) && !speechFirst(c, 5) && !shortTake(c, 8) && !(!c.atCut && state(c) && (c.talkBefore > 0 || c.talkAfter > 0)));
  evalAt("F: E + no note within 3 s of the line before", (c) => main(c) && !speechFirst(c, 5) && !shortTake(c, 8) && !(!c.atCut && state(c) && (c.talkBefore > 0 || c.talkAfter > 0)) && !(!c.atCut && c.sincePrevLine < 3));
}
