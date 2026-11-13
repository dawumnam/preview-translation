// Shared by the study scripts.
import fs from "fs";

export const ROOT = "exp/previewgen";
export const ALL_IDS = ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];

/** The camera cuts of an episode, from the saved scene scores (the same rule as cuts.ts: score ≥ 0.1, at least 1 s apart). */
export function cutsOf(id: string, th = 0.1): number[] {
  const text = fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8");
  const out: number[] = [];
  let cur = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
    else if (line.startsWith("lavfi.scene_score=") && parseFloat(line.slice(18)) >= th && (!out.length || cur - out[out.length - 1] >= 1)) out.push(Math.round(cur * 100) / 100);
  }
  return out;
}
