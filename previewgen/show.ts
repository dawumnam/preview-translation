// CLI: print generated lines, and the reference lines for the same stretch when a reference is given.
//
//   bun previewgen/show.ts <gen.json> [<reference.hwpx>] [--from s] [--to s] [--full]
//
// The lines are shown in the house style. --full shows every turn as the model
// wrote it, with its tag.
import fs from "fs";
import { loadGt, renderLine, type PreviewLine } from "./gt";
import { applyStyle, HOUSE_STYLE, mergeWindows, tcShown } from "./assemble";
import type { GenFile } from "./gen";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const genPath = process.argv[2];
const gtPath = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;
const gen = JSON.parse(fs.readFileSync(genPath, "utf-8")) as GenFile;
const from = parseFloat(arg("from") ?? String(Math.min(...gen.windows.map((w) => w.start))));
const to = parseFloat(arg("to") ?? String(Math.max(...gen.windows.map((w) => w.end))));

const full = process.argv.includes("--full");
const styled = applyStyle(mergeWindows(gen.windows, gen.cuts ?? []), { ...HOUSE_STYLE, direct: full ? "full" : "house" });
const shown = tcShown(styled);
const lines: PreviewLine[] = styled.filter((l) => l.tc! >= from && l.tc! < to);
console.log(`=== generated ${from}-${to} (${lines.length} lines)`);
for (const w of gen.windows) if (w.people.length && w.start < to && w.end > from) console.log(`people ${w.start}-${w.end}: ${w.people.map((p) => `${p.label}=${p.look}`).join("; ")}`);
styled.forEach((l, i) => {
  if (l.tc! < from || l.tc! >= to) return;
  console.log(full ? `${renderLine(l)}${l.use && l.use !== "take" ? `   <${l.use}>` : ""}` : renderLine(l, shown[i]));
});
if (gtPath) {
  const gt = loadGt(gtPath).filter((l) => l.tcPrev >= from && l.tcPrev < to);
  console.log(`\n=== reference ${from}-${to} (${gt.length} lines)`);
  for (const l of gt) console.log(renderLine(l));
}
