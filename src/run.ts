// CLI: translate the requested @@ lines of one or more scripts.
//
//   bun src/run.ts <script.hwp|.hwpx> <video.mp4|.mp3> [<script2> <video2> ...] [--select "<words>"] [--fresh] [--keep-audio]
//   bun src/run.ts <script> [<script2> ...] --list [--select "<words>"]
//
// --select says in plain words which text style marks the requested lines:
// "bold" (the default), "bold underline color", "bold underline blue" ...
// --list prints which lines the rule selects and stops. It needs no video and
// makes no model call.
//
// Each episode runs at the same time as the others. The translated file is
// written next to the script as <script name>_translated.hwpx; everything else
// goes to <script dir>/<id>_work/.
import fs from "fs";
import path from "path";
import { usageReport } from "./llm";
import { listSelection, runEpisode, type EpisodeReport } from "./pipeline";
import { DEFAULT_SELECT, formatStyleReport, parseSelect, ruleText, takeSelectArg } from "./select";

const USAGE =
  'Usage: bun src/run.ts <script.hwp|.hwpx> <video> [<script2> <video2> ...] [--select "<words>"] [--fresh] [--keep-audio]\n' +
  '       bun src/run.ts <script> [<script2> ...] --list [--select "<words>"]';
const args = process.argv.slice(2);
let select = DEFAULT_SELECT;
try {
  select = ruleText(parseSelect(takeSelectArg(args) ?? DEFAULT_SELECT));
} catch (e: any) {
  console.error(`${e.message}\n${USAGE}`);
  process.exit(1);
}
const flags = new Set(args.filter((a) => a.startsWith("--")));
const files = args.filter((a) => !a.startsWith("--"));
const unknown = [...flags].filter((f) => !["--fresh", "--keep-audio", "--list"].includes(f));
if (unknown.length) {
  console.error(`Unknown option: ${unknown.join(" ")}\n${USAGE}`);
  process.exit(1);
}
const isScript = (f: string) => /\.hwpx?$/i.test(f);

if (flags.has("--list")) {
  // Only the selection: no video is read and no model is called.
  const scripts = files.filter(isScript);
  if (scripts.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }
  let none = 0;
  for (const script of scripts) {
    if (!fs.existsSync(script)) {
      console.error(`File not found: ${script}`);
      process.exit(1);
    }
    const { id, styles } = await listSelection(script, select);
    console.log(`\n${id} (${path.basename(script)})`);
    for (const line of formatStyleReport(styles, Infinity)) console.log(`  ${line}`);
    if (styles.selected === 0) none++;
  }
  process.exit(none ? 1 : 0);
}

if (files.length === 0 || files.length % 2 !== 0) {
  console.error(USAGE);
  process.exit(1);
}
const pairs: { script: string; media: string }[] = [];
for (let i = 0; i < files.length; i += 2) {
  // Either order within a pair is accepted.
  const [x, y] = [files[i], files[i + 1]];
  const script = isScript(x) ? x : y;
  const media = isScript(x) ? y : x;
  if (!isScript(script) || isScript(media)) {
    console.error(`Each pair needs one script (.hwp/.hwpx) and one media file: got "${x}" and "${y}".\n${USAGE}`);
    process.exit(1);
  }
  for (const f of [script, media]) {
    if (!fs.existsSync(f)) {
      console.error(`File not found: ${f}`);
      process.exit(1);
    }
  }
  pairs.push({ script, media });
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const t0 = performance.now();
const results = await Promise.all(
  pairs.map(async (p) => {
    try {
      return await runEpisode({ ...p, select, fresh: flags.has("--fresh"), keepAudio: flags.has("--keep-audio") });
    } catch (e: any) {
      console.error(`[${path.basename(p.script)}] FAILED: ${e?.message ?? e}`);
      return null;
    }
  }),
);

let bad = 0;
let billable = 0;
for (const [i, r] of results.entries()) {
  if (!r) {
    bad++;
    console.log(`\n${path.basename(pairs[i].script)}: FAILED (see the error above)`);
    continue;
  }
  print(r);
  billable += r.billableSec;
  if (r.verify !== "OK") bad++;
}
if (results.length > 1) console.log(`\nAll episodes: billable ${mmss(billable)} (${billable.toFixed(1)} s)`);
const usage = usageReport();
console.log(
  `\nModel calls: ${Object.entries(usage)
    .map(([m, u]) => `${m} ${u.calls} calls, ${u.input} in, ${u.output + u.thoughts} out`)
    .join("; ")}. Wall time ${((performance.now() - t0) / 1000).toFixed(0)} s.`,
);
process.exit(bad ? 1 : 0);

function print(r: EpisodeReport) {
  const s = r.seconds;
  console.log(`\n${r.id}: ${r.markers} lines translated, ${r.styles.other} other @@ lines left as they are`);
  for (const line of formatStyleReport(r.styles)) console.log(`  ${line}`);
  console.log(
    `  time ${s.total} s: decode ${s.decode}, brief ${s.brief}, all ${r.windows.join("+")} windows heard after ${s.listen}, ` +
      `all lines decided after ${s.decided}, apply+verify ${s["apply+verify"]}`,
  );
  console.log(`  confidence high/medium/low: ${r.confidence.high}/${r.confidence.medium}/${r.confidence.low} (low lines carry " ??")`);
  for (const f of r.flagged) console.log(`    ?? #${f.marker} ${f.tc} ${f.speaker}: ${f.text.slice(0, 60)} — ${f.reason}`);
  console.log(
    `  billable ${mmss(r.billableSec)} (${r.billableSec} s)` +
      `${r.billableLowSec ? `, of which ${r.billableLowSec} s come from ?? lines alone` : ""}`,
  );
  for (const p of r.problems) console.log(`  NOTE: ${p}`);
  console.log(`  verify: ${r.verify}${r.verify === "OK" ? "" : `\n${r.verifyOutput}`}`);
  console.log(`  output: ${r.verify === "OK" ? r.output : "(not written: verify failed)"}`);
}
