// Usage: bun --env-file=<.env> previewgen/study/dev_run.ts <tag> [--only shots] [--model m] [--rules round2] [--ids 1023,1104]
// Runs the watch step with the current prompt on the test stretches of dev_eval.ts, all at the same time.
// Output: exp/previewgen/p5/<id>_<tag>.json. Prints the argument for dev_eval.ts.
import fs from "fs";
import { usageReport } from "../../src/llm";
import { DEFAULT_SETTINGS, watch, type GenFile, type GenSettings } from "../gen";
import { DEV } from "./dev_eval";

const tag = process.argv[2];
const arg = (n: string) => (process.argv.indexOf(`--${n}`) >= 0 ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const ids = arg("ids") ? arg("ids")!.split(",") : Object.keys(DEV);
const settings: GenSettings = {
  ...DEFAULT_SETTINGS,
  tag,
  ...(arg("model") ? { model: arg("model")! } : {}),
  ...(arg("only") === "shots" ? { only: "shots" as const } : {}),
  ...(arg("rules") === "round2" ? { rules: "round2" as const } : {}),
};
const dir = "exp/previewgen/p5";
await Promise.all(
  ids.map(async (id) => {
    const media = `exp/previewgen/media/${id}.mp4`;
    const parts = await Promise.all(DEV[id].map(([a, b]) => watch(media, `${dir}/${id}_media`, settings, a, b)));
    const file: GenFile = { media, settings, cuts: parts[0].cuts, windows: parts.flatMap((p) => p.windows).sort((a, b) => a.start - b.start) };
    fs.writeFileSync(`${dir}/${id}_${tag}.json`, JSON.stringify(file, null, 1));
  }),
);
console.log(JSON.stringify(usageReport()));
console.log(`${tag}=${ids.map((id) => `${id}:${dir}/${id}_${tag}.json`).join(",")}`);
