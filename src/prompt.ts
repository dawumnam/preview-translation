// Prompt and response schema for a script-guided listen: the model gets a
// short audio window and the script lines for the same stretch, and fills in
// the foreign-language lines the script marks.
import { LANG_NAME } from "./parser";
import type { ScriptLine } from "./script";
import type { ListenWindow } from "./windows";

export interface Fill {
  id: number;
  heard: boolean;
  source: string;
  ko: string;
  start: string;
  end: string;
  confidence: "high" | "medium" | "low";
}

export const FILL_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "INTEGER", description: "The N of the ▶N line" },
      start: { type: "STRING", description: "Where this turn starts in the clip, MM:SS.d (tenths of a second)" },
      end: { type: "STRING", description: "Where this turn ends in the clip, MM:SS.d" },
      heard: { type: "BOOLEAN", description: "false when this turn cannot be found or heard in the clip" },
      source: { type: "STRING", description: "The turn verbatim, in the language and script it was spoken in. Empty when not heard." },
      ko: { type: "STRING", description: "Korean translation of this turn. Empty when not heard." },
      confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    },
    required: ["id", "start", "end", "heard", "source", "ko", "confidence"],
    propertyOrdering: ["id", "start", "end", "heard", "source", "ko", "confidence"],
  },
};

const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export interface PromptOptions {
  /** Line numbers whose Korean text is hidden (tests only: the line is the answer key). */
  mask?: Set<number>;
  /** Episode notes: place, people, spellings. */
  brief?: string;
  /**
   * Turns that are already settled (focused listen only). They are shown with
   * their translation and time, so the open turns can be placed between them.
   */
  known?: Map<number, { ko: string; start: number; end: number }>;
}

function lineText(l: ScriptLine, w: ListenWindow, own: Set<number>, o: PromptOptions): string {
  const inClip = l.tc !== undefined && l.tc >= w.start - 1 && l.tc <= w.end;
  const time = l.tc === undefined ? "       " : inClip ? `[${mmss(l.tc - w.start)}]` : l.tc < w.start ? "[before]" : "[after] ";
  const who = l.speaker ? `${l.speaker}: ` : "";
  if (l.kind === "scene") return `        # ${l.text}`;
  if (l.kind === "marker") {
    const lang = LANG_NAME[l.marker!.language] ?? l.marker!.language;
    const until = l.marker!.endTimestamp;
    const hint =
      (l.text ? ` — scriptwriter's note: "${l.text}"` : "") +
      (until !== undefined && until > w.start && until <= w.end ? ` — this turn runs until about [${mmss(until - w.start)}]` : "");
    if (own.has(l.marker!.index)) return `${time} ▶${l.marker!.index} ${who}(${lang})${hint}`;
    const k = o.known?.get(l.marker!.index);
    if (k) {
      const at = k.start >= w.start && k.start <= w.end ? `[${mmss(k.start - w.start)}]` : time;
      return `${at} ${who}(${lang} — already translated: "${k.ko}")`;
    }
    return `${time} ${who}(${lang} — another foreign-language turn, not for you to fill)`;
  }
  if (l.kind === "unrequested") return `${time} ${who}(외국어 — a foreign-language turn that is not requested)`;
  if (o.mask?.has(l.no)) return `${time} ${who}(한국어 — text withheld)`;
  return `${time} ${who}${l.text}`;
}

export function buildFillPrompt(w: ListenWindow, o: PromptOptions = {}): string {
  const own = new Set(w.markers.map((m) => m.marker!.index));
  const langs = [...new Set(w.markers.map((m) => LANG_NAME[m.marker!.language] ?? m.marker!.language))];
  const script = w.excerpt.map((l) => lineText(l, w, own, o)).join("\n");
  return `You are an interpreter working on raw footage of a Korean TV travel programme. The audio clip is ${Math.round(w.end - w.start)} seconds of that footage. Below is the production script for the same stretch. The scriptwriter wrote out the Korean speech and described the shots, but left each foreign-language turn as a placeholder. Listen to the clip and fill in the placeholders marked ▶.
${o.brief ? `\n## About this episode\n${o.brief}\n` : ""}
## How to read the script
- \`[MM:SS]\` is where the line happens in THIS clip. It comes from the scriptwriter's timecode, so it is right to within a few seconds. A line with no time follows the line above it. \`[before]\` and \`[after]\` lines are outside the clip and are there for context only.
- \`speaker: text\`. 큐 is the Korean host, 피 is the director (off camera), 코 is the coordinator who interprets between Korean and the local language. Other names are locals, named by how they look (for example 모남 = man in a hat, 검여 = woman in black).
- \`▶N speaker: (language)\` is a foreign-language turn that you must fill in. N is its id.
- Other foreign-language turns are shown without ▶. They take their turn in the conversation, so their speech does not belong in a ▶ line.
- A line with no speaker is a shot description.

## What to do
For each ▶ line, find that speaker's turn in the audio. Use the times, the order of the lines, and the Korean around it: the question before it, and the coordinator's Korean interpretation after it, tell you which turn it is. Then return for that id:
- \`start\` / \`end\`: where the turn is in the clip (MM:SS.d). If the same speaker's turn runs over a short interjection from someone else, give the whole turn.
- \`source\`: what the speaker says, verbatim, in the original language and script (${langs.join(", ")} or whatever was really spoken).
- \`ko\`: the Korean translation of that turn, complete and faithful, in natural spoken Korean as a script line. Translate what was said, every sentence of it. Do not copy or paraphrase the coordinator's Korean line: the coordinator often shortens or changes what was said, and the editors need the speaker's own words. Write only this speaker's words, with no speaker label. Use polite 해요-style speech unless the speaker is clearly talking down or to family, and keep one speaker at one speech level through the exchange. Do not write 당신: leave the pronoun out, or use the name or title, as natural Korean does. Spell names and places the way the script spells them.
- \`heard\`: false if you cannot find the turn or cannot make out the words. Then leave \`source\` and \`ko\` empty. Never invent speech, and never fill a line from the context alone.
- \`confidence\`: high = the words are clear and the turn is certain; medium = you are sure of the turn but some words are unclear, or the words are clear but the turn could be a neighbour's; low = mostly a guess.

When the 코 line is ▶, the coordinator is speaking the local language (usually passing on the Korean question or comment before it). Translate what the coordinator really says, which may differ from the Korean question.

Return one entry for each ▶ id: ${[...own].join(", ")}.

## Script
${script}`;
}
