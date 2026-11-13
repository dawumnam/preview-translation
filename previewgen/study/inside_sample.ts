// Usage: bun previewgen/study/inside_sample.ts <dump.json> <talk kind: none|before|after|both> <count> [ids,comma]
// Prints samples of the writer's shot lines inside a take, with the lines around them.
import fs from "fs";
import type { InsideLine } from "./inside";

const [file, kind, count, idsArg] = process.argv.slice(2);
const ids = idsArg ? idsArg.split(",") : undefined;
const all = (JSON.parse(fs.readFileSync(file, "utf-8")) as InsideLine[]).filter((l) => l.talk === kind && (!ids || ids.includes(l.id)));
// A fixed spread over the list, so that a second run shows the same lines.
const n = Math.min(parseInt(count), all.length);
for (let k = 0; k < n; k++) {
  const l = all[Math.floor((k * all.length) / n)];
  console.log(`[${l.id}]\n${l.around.join("\n")}\n`);
}
