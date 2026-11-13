// Usage: bun previewgen/study/showprompt.ts [round2] [shots]
// Prints the prompt of the watch step, for a read by eye.
import { buildLogPrompt } from "../prompt";

const a = process.argv.slice(2);
console.log(buildLogPrompt({ durationSec: 300, cuts: [42, 130], startsAtCut: true, rules: a.includes("round2") ? "round2" : undefined, shotsOnly: a.includes("shots") }));
