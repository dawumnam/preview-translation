// One label for one local person through the whole episode.
//
// Each window is logged on its own, so the same woman can be 두여 in one
// window and 모여 in the next. A text call reads the notes of all windows
// (label, look, role, time) and says which notes are the same person. The
// labels in the lines are then changed by code.
import { callJson } from "../src/llm";
import { clock } from "../src/script";
import type { PreviewLine } from "./gt";
import type { WindowOut } from "./gen";

const CAST = new Set(["큐", "코", "피", "카감"]);

export interface CastAnswer {
  persons: { label: string; look: string; notes: number[] }[];
}

const CAST_SCHEMA = {
  type: "OBJECT",
  properties: {
    persons: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING", description: "The one label for this person" },
          look: { type: "STRING", description: "The person in a few Korean words" },
          notes: { type: "ARRAY", items: { type: "INTEGER" }, description: "The numbers of all notes that are this person" },
        },
        required: ["label", "look", "notes"],
        propertyOrdering: ["label", "look", "notes"],
      },
    },
  },
  required: ["persons"],
};

export interface CastResult {
  /** For each window (see `windowKey`): label in that window → label in the document. */
  rename: Map<string, Map<string, string>>;
  /** The people of the episode, for the report. */
  persons: { label: string; look: string; from: number; to: number; turns: number }[];
}

/** The usual pass and the picture-only pass have windows with the same times: the pass is a part of the key. */
export const windowKey = (w: WindowOut) => `${w.pass ?? "main"}:${w.start}`;

interface Note {
  win: WindowOut;
  label: string;
  look: string;
  role: string;
  turns: number;
}

/** One note for each local of each window: the label, the look, and how often the person speaks. */
export function castNotes(windows: WindowOut[]): Note[] {
  const notes: Note[] = [];
  for (const w of windows) {
    const turns = new Map<string, number>();
    for (const l of w.lines) if (l.kind !== "shot" && l.speaker && !CAST.has(l.speaker)) turns.set(l.speaker, (turns.get(l.speaker) ?? 0) + 1);
    const seen = new Set<string>();
    for (const p of w.people) {
      if (!p.label || CAST.has(p.label) || seen.has(p.label)) continue;
      seen.add(p.label);
      notes.push({ win: w, label: p.label, look: p.look, role: p.role, turns: turns.get(p.label) ?? 0 });
    }
    // A speaker label with no note in `people`.
    for (const [label, n] of turns) if (!seen.has(label)) notes.push({ win: w, label, look: "", role: "", turns: n });
  }
  return notes;
}

/** The prompt that asks which notes are the same person. */
export function buildCastPrompt(notes: Note[]): string {
  const list = notes
    .map((n, i) => `${i + 1}. [${clock(n.win.start)}–${clock(n.win.end)}, log ${n.win.pass === "shots" ? "B" : "A"}] ${n.label}: ${n.look || "(no description)"}${n.role ? ` / ${n.role}` : ""} / ${n.turns} turns`)
    .join("\n");
  return `A logger wrote the preview log of one day of raw footage for a Korean TV travel documentary. The footage was logged in windows of about five minutes, each on its own. In each window the logger gave every local person a short Korean label by look and wrote a note: the label, what the person looks like, what the person does, and how many times the person speaks.

Some windows were logged two times, each time on its own: log A with picture and sound, log B with the picture only (so its notes have 0 turns). A person of log A is most often also in log B of the same window.

Because each window was logged on its own, one person can have different labels in different windows (the look is described from another angle, or another feature was picked), and two different persons can have the same label.

Decide which notes are the same person, and give each person one label for the whole day.

How to decide:
- The footage runs in time order. A person who is with the host in one window is most often still there in the next window. Notes in windows next to each other with the same sex and age, a look that does not contradict, and the same role are the same person, also when the words for the clothes differ a little (the light changes, a jacket comes off).
- Notes that are far apart in time, in a different place, are different persons, also when the labels are the same.
- Two notes of the same log and the same window are never the same person. A note of log A and a note of log B of the same window are the same person when sex, age and look agree.

How to label:
- Take the label that most of the person's notes of log A use (count the turns).
- An old man is 할, an old woman is 할머, a child is 아이. For other people: one syllable for the colour of the clothes or for a clear feature, then 남 or 여 (검남, 흰여, 두여 = 두건, 모남 = 모자, 안여 = 안경, 수남 = 수염).
- Two different persons who are in the footage at the same time or in windows next to each other must not have the same label. Persons who are far apart in time can have the same label.

Return every person with the numbers of all the notes that are that person. Each note number goes to exactly one person.

## Notes
${list}`;
}

/** The renames that follow from the answer. A note that the answer leaves out keeps its label. */
export function castFromAnswer(notes: Note[], answer: CastAnswer | undefined): CastResult {
  const result: CastResult = { rename: new Map(), persons: [] };
  const used = new Set<number>();
  for (const p of answer?.persons ?? []) {
    const label = (p.label ?? "").trim();
    const mine = (p.notes ?? []).map((k) => k - 1).filter((k) => k >= 0 && k < notes.length && !used.has(k));
    if (!label || CAST.has(label) || !mine.length) continue;
    for (const k of mine) {
      used.add(k);
      const n = notes[k];
      if (!result.rename.has(windowKey(n.win))) result.rename.set(windowKey(n.win), new Map());
      result.rename.get(windowKey(n.win))!.set(n.label, label);
    }
    result.persons.push({
      label,
      look: p.look ?? "",
      from: Math.min(...mine.map((k) => notes[k].win.start)),
      to: Math.max(...mine.map((k) => notes[k].win.end)),
      turns: mine.reduce((a, k) => a + notes[k].turns, 0),
    });
  }
  return result;
}

/** Asks which window notes are the same person. Returns no renames when the call fails. */
export async function unifyCast(windows: WindowOut[], model: string): Promise<CastResult> {
  const notes = castNotes(windows);
  if (!notes.length) return { rename: new Map(), persons: [] };
  const r = await callJson<CastAnswer>({ model, parts: [{ text: buildCastPrompt(notes) }], schema: CAST_SCHEMA, thinkingLevel: "MEDIUM", timeoutMs: 120_000, hedgeAfterMs: [40_000], label: "cast" });
  if (!r.value?.persons) console.error(`NOTE: no answer for the cast (${r.error ?? r.blocked ?? "empty"}); the labels stay as each window wrote them.`);
  return castFromAnswer(notes, r.value);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The windows with the labels of the document: in the speaker field and inside shot descriptions. */
export function applyCast(windows: WindowOut[], cast: CastResult): WindowOut[] {
  return windows.map((w) => {
    const map = cast.rename.get(windowKey(w));
    if (!map || ![...map].some(([a, b]) => a !== b)) return w;
    // Longest label first, so that 검남 is not changed inside 검남자.
    const pairs = [...map].filter(([a, b]) => a !== b).sort((x, y) => y[0].length - x[0].length);
    const fix = (l: PreviewLine): PreviewLine => {
      if (l.kind === "shot") {
        let text = l.text;
        for (const [a, b] of pairs) text = text.replace(new RegExp(`(^|[\\s,(])${escapeRe(a)}(?=$|[\\s,)와과의이가은는을를도])`, "g"), `$1${b}`);
        return text === l.text ? l : { ...l, text };
      }
      const to = l.speaker ? map.get(l.speaker) : undefined;
      return to && to !== l.speaker ? { ...l, speaker: to } : l;
    };
    return { ...w, lines: w.lines.map(fix), people: w.people.map((p) => ({ ...p, label: map.get(p.label) ?? p.label })) };
  });
}
