// CLI: listen again to chosen lines of an episode that run.ts has processed.
// It changes nothing. Use it on a " ??" line, or on a line an editor questions.
//
//   bun src/relisten.ts <work-dir> <marker> [<marker> ...] [--times 3]
//
// Each listen gets the audio around the line and the script for that stretch,
// with the neighbouring lines' current translations shown as fixed points.
import fs from "fs";
import path from "path";
import { decodeAudio, mediaDuration } from "./audio";
import { briefText, type Brief } from "./brief";
import { extractHwpx } from "./hwpx";
import { listenPass } from "./listen";
import { MODELS } from "./pipeline";
import type { Translation } from "./replace";
import { clock, parseScript } from "./script";
import { DEFAULT_WINDOW, planWindows } from "./windows";

const args = process.argv.slice(2);
const timesAt = args.indexOf("--times");
const times = timesAt >= 0 ? Math.max(1, parseInt(args[timesAt + 1], 10) || 3) : 3;
const rest = args.filter((a, i) => !a.startsWith("--") && (timesAt < 0 || i !== timesAt + 1));
const workDir = rest[0];
const wanted = rest.slice(1).map(Number);
if (!workDir || wanted.length === 0 || wanted.some((n) => !Number.isInteger(n))) {
  console.error("Usage: bun src/relisten.ts <work-dir> <marker> [<marker> ...] [--times 3]");
  process.exit(1);
}
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(workDir, f), "utf-8"));
const ep = read<{ hwpx: string; media: string; select?: string }>("episode.json");
const translations = read<Translation[]>("translations.json");
const brief = fs.existsSync(path.join(workDir, "brief.json")) ? read<Brief>("brief.json") : null;

const hwpx = extractHwpx(ep.hwpx, ep.select);
const { lines } = parseScript(hwpx.xml, hwpx.selectedIds);
const mediaDur = await mediaDuration(ep.media);
const pcm = path.join(workDir, "audio.pcm");
const hadAudio = fs.existsSync(pcm);
await decodeAudio(ep.media, pcm, mediaDur);

const byIndex = new Map(translations.map((t) => [t.markerIndex, t]));
const known = new Map(
  translations
    .filter((t) => !wanted.includes(t.markerIndex) && t.confidence !== "low")
    .map((t) => [t.markerIndex, { ko: t.translation ?? "", start: t.speech_start ?? t.timestamp, end: t.speech_end ?? t.timestamp }]),
);
const windows = planWindows(
  lines,
  { ...DEFAULT_WINDOW, pre: 6, post: 10, maxLen: 60, mediaDur },
  new Set(wanted),
  (m, [lo, hi]) => {
    const t = byIndex.get(m);
    return t && t.speech_end! > t.speech_start! ? [Math.min(lo, t.speech_start! - 5), Math.max(hi, t.speech_end! + 5)] : [lo, hi];
  },
  "r",
);
const runs = await Promise.all(
  Array.from({ length: times }, (_, k) =>
    listenPass(
      { name: `listen ${k + 1}`, model: MODELS.listen, thinkingLevel: "MEDIUM", fallbackModel: MODELS.fallback },
      windows, pcm, { brief: briefText(brief), known }, mediaDur,
    ),
  ),
);
for (const m of wanted) {
  const t = byIndex.get(m);
  const line = lines.find((l) => l.marker?.index === m);
  if (!t || !line) {
    console.log(`\n#${m}: no such marker`);
    continue;
  }
  console.log(`\n#${m} ${t.charName} ${clock(t.timestamp)} — now (${t.confidence}): ${t.translation}`);
  for (const r of runs) {
    const c = r.candidates.find((x) => x.marker === m);
    if (!c?.heard) console.log(`  ${r.candidates[0]?.pass ?? "listen"}: not heard`);
    else console.log(`  ${c.pass} [${clock(c.start)}–${clock(c.end)}]: ${c.ko}\n      heard: ${c.source}`);
  }
}
if (!hadAudio) fs.rmSync(pcm, { force: true });
