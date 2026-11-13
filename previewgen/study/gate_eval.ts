// Usage: bun previewgen/study/gate_eval.ts [--full 1022:<windows.json>+<shots.json>,1103:...]
// The picture-only pass as a filler: its shot lines are added only where the main pass (picture and sound)
// shows that the footage is an activity. Scores on the test stretches (main: v6, picture-only: pic) and on
// full episodes. No model call.
import fs from "fs";
import { applyStyle, HOUSE_STYLE, mergeWindows, placeTc } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt, type PreviewLine } from "../gt";
import { score } from "../score";
import { DEV } from "./dev_eval";

export interface Gate {
  /** A picture-only line is not added within this many seconds of a shot line. */
  near: number;
  /** Add lines where nobody talks (no speech line of the main pass within 10 s). */
  quiet: boolean;
  /** Add lines inside talk when the main pass has at least `minNotes` notes inside a take within `span` seconds. 0 = never. */
  minNotes: number;
  span: number;
}

export function joinGated(base: PreviewLine[], extra: PreviewLine[], cuts: number[], g: Gate): PreviewLine[] {
  const baseShots = base.filter((l) => l.kind === "shot");
  const notes = baseShots.filter((l) => l.tcDoc === undefined).map((l) => l.tc!);
  const talk = base.filter((l) => l.kind !== "shot" && l.use !== "direct").map((l) => l.tc!);
  const added: PreviewLine[] = [];
  for (const l of extra) {
    if (l.kind !== "shot") continue;
    const t = l.tc!;
    if (baseShots.some((b) => Math.abs(b.tc! - t) <= g.near)) continue;
    const last = added[added.length - 1];
    if (last && t - last.tc! <= g.near) continue;
    const atCut = cuts.some((c) => Math.abs(c - t) <= 2.5);
    const inTalk = talk.some((x) => Math.abs(x - t) <= 10);
    if (atCut) {
      // The main pass left this cut out on purpose when the talk runs across it.
      if (talk.some((x) => x >= t - 4 && x < t) && talk.some((x) => x >= t && x <= t + 4)) continue;
    } else if (!inTalk) {
      if (!g.quiet) continue;
    } else {
      if (!g.minNotes || notes.filter((x) => Math.abs(x - t) <= g.span).length < g.minNotes) continue;
    }
    added.push({ ...l });
  }
  return [...base, ...added].map((l, i) => ({ l, i })).sort((a, b) => Math.floor(a.l.tc!) - Math.floor(b.l.tc!) || a.i - b.i).map((x) => x.l);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fi = args.indexOf("--full");
  const full = fi >= 0 ? args[fi + 1].split(",").map((p) => ({ id: p.slice(0, p.indexOf(":")), files: p.slice(p.indexOf(":") + 1).split("+") })) : [];
  const sets: { name: string; id: string; main: string; extra: string; ranges?: [number, number][] }[] = [
    ...Object.keys(DEV).map((id) => ({ name: "test stretches", id, main: `exp/previewgen/p5/${id}_v6.json`, extra: `exp/previewgen/p5/${id}_pic.json`, ranges: DEV[id] })),
    ...full.map((f) => ({ name: `${f.id} full`, id: f.id, main: f.files[0], extra: f.files[1] })),
  ];
  const gates: [string, Gate | undefined][] = [
    ["main pass alone", undefined],
    ["+ picture-only where nobody talks", { near: 6, quiet: true, minNotes: 0, span: 0 }],
    ["+ in talk when 1 note within 30 s", { near: 6, quiet: false, minNotes: 1, span: 30 }],
    ["+ in talk when 1 note within 45 s", { near: 6, quiet: false, minNotes: 1, span: 45 }],
    ["+ in talk when 2 notes within 45 s", { near: 6, quiet: false, minNotes: 2, span: 45 }],
    ["+ in talk when 2 notes within 60 s", { near: 6, quiet: false, minNotes: 2, span: 60 }],
    ["+ quiet, and in talk when 1 note within 45 s", { near: 6, quiet: true, minNotes: 1, span: 45 }],
    ["+ quiet, and in talk when 2 notes within 45 s", { near: 6, quiet: true, minNotes: 2, span: 45 }],
    ["+ quiet, and in talk when 2 notes within 60 s, near 8", { near: 8, quiet: true, minNotes: 2, span: 60 }],
    ["+ all (no gate)", { near: 6, quiet: true, minNotes: 1, span: 1e9 }],
  ];
  const pc = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`;
  for (const name of [...new Set(sets.map((s) => s.name))]) {
    console.log(`\n== ${name}`);
    for (const [label, g] of gates) {
      const sum = { ref: 0, gen: 0, hit: 0, inRef: 0, inHit: 0 };
      for (const s of sets.filter((x) => x.name === name)) {
        const gen = JSON.parse(fs.readFileSync(s.main, "utf-8")) as GenFile;
        const base = mergeWindows(gen.windows, gen.cuts);
        const extra = fs.existsSync(s.extra) ? mergeWindows((JSON.parse(fs.readFileSync(s.extra, "utf-8")) as GenFile).windows, gen.cuts) : [];
        const lines = placeTc(applyStyle(g ? joinGated(base, extra, gen.cuts, g) : base, HOUSE_STYLE));
        const dur = Math.max(...gen.windows.map((w) => w.end));
        const sc = score(lines, loadGt(`exp/previewgen/gt/${s.id}.hwpx`), s.ranges ?? [[0, dur + 1]], false, gen.cuts);
        sum.ref += sc.shot.ref; sum.gen += sc.shot.gen; sum.hit += sc.shot.matched; sum.inRef += sc.shotAt.insideRef; sum.inHit += sc.shotAt.insideFound;
      }
      const r = sum.hit / sum.ref;
      const q = sum.hit / sum.gen;
      console.log(`  ${label.padEnd(52)} ${String(sum.gen).padStart(3)} lines for ${sum.ref} (${(sum.gen / sum.ref).toFixed(2)} times) | found ${pc(sum.hit, sum.ref)} (inside ${pc(sum.inHit, sum.inRef)}) | at a human line ${pc(sum.hit, sum.gen)} | F1 ${Math.round((200 * r * q) / (r + q))}%`);
    }
  }
}
