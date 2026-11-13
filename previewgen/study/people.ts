// Usage: bun previewgen/study/people.ts <gen.json>
import fs from "fs";

const d = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
const CAST = new Set(["큐", "코", "피", "카감"]);
for (const w of d.windows) {
  const turns: Record<string, number> = {};
  for (const l of w.lines) if (l.kind !== "shot" && !CAST.has(l.speaker)) turns[l.speaker] = (turns[l.speaker] ?? 0) + 1;
  const s = Math.floor(w.start);
  const clock = `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  const people = w.people.map((p: any) => `${p.label}=${p.look} (${p.role})`).join("; ");
  console.log(`${clock} cut=${w.startsAtCut} | ${people.slice(0, 260)} | turns ${JSON.stringify(turns)}`);
}
