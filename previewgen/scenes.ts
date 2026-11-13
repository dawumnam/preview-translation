// Scene headers. A text call reads the finished lines and says where each
// part starts and what its title is.
//
// The human previews have one level of "# title" lines with no fixed rule: a
// scene is 1 to 51 minutes, and one episode has 6 to 19 of them. Asked to
// divide a human preview in the same way, the model finds 63 to 68% of the
// writer's scene starts. So the division here has a rule and two levels:
// level 1 is the place, level 2 the activity at that place. On the nine
// Georgia previews, 76% of the writer's scene starts are the start of such a
// part to within 30 s (87% to within 90 s), with twice as many parts.
import { callJson } from "../src/llm";
import { clock } from "../src/script";
import type { PreviewLine } from "./gt";

export interface SceneAnswer {
  scenes: { first_line: number; level?: number; title: string }[];
}

const SCENE_SCHEMA = {
  type: "OBJECT",
  properties: {
    scenes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          first_line: { type: "INTEGER", description: "Number of the first line of the part" },
          level: { type: "INTEGER", description: "1 = a new place, 2 = a new activity or person at the same place" },
          title: { type: "STRING", description: "Short Korean title in the house style" },
        },
        required: ["first_line", "level", "title"],
        propertyOrdering: ["first_line", "level", "title"],
      },
    },
  },
  required: ["scenes"],
};

function brief(l: PreviewLine): string {
  if (l.kind === "shot") return `shot: ${l.text}`;
  if (l.kind === "foreign") return `${l.speaker}: (외국어)`;
  return `${l.speaker}: ${l.text.length > 46 ? `${l.text.slice(0, 46)}…` : l.text}`;
}

/** The prompt that asks for the parts of these lines. */
export function buildScenePrompt(lines: PreviewLine[]): string {
  const body = lines.map((l, i) => `${i + 1} [${clock(l.tc ?? 0)}] ${brief(l)}`).join("\n");
  return `Below is the preview log of one day of raw footage for a Korean TV travel documentary: shots and spoken turns in time order, each with a line number and a time. 큐 is the host, 피 the director, 카감 the camera director, 코 the coordinator; other labels are locals.

Divide the log into parts on two levels, and give each part a title.

Level 1 is the place. A new level 1 part starts when the crew is at a new place: another village, another house or shop, the road or a car between two places, a walk to the next place. All that happens at one place is one level 1 part, also when it is long.

Level 2 is the activity at that place. Inside a level 1 part, a new level 2 part starts when the main thing in the footage changes for some minutes:
- from takes of the host alone to a meeting or an interview with a local;
- from an interview to a work process that someone shows (they cook, build, harvest), or from one such process to the next;
- to a meal, to a goodbye;
- to a block of scenery or detail shots with no talk (at least five shot lines one after the other, or two minutes), and back from it;
- to another local who becomes the main person.
A part of level 2 is seldom shorter than two minutes. Takes of the same action are one part. Talk between takes and directions do not start a part.

Each level 1 part starts with a first level 2 part at the same line: give that line once, as level 1, with a title that fits the place and the first activity.

The title is a short Korean phrase that ends in a noun, in the style of the shot lines of the log. It names the place or the people and the activity (for example: 시장 sk / 시장 구경하는 큐 / 검남 인터뷰 / 치즈 만드는 흰여 / 가족과 식사하는 큐).

Return the parts in order. \`first_line\` is the number of the first line of the part, \`level\` is 1 or 2. The first part starts at line 1 with level 1. A part starts at a shot line when there is one at the change.

## Log
${body}`;
}

/** The lines with a scene line before the first line of each part. Without a usable answer: one scene for all. */
export function applyScenes(lines: PreviewLine[], answer: SceneAnswer | undefined): PreviewLine[] {
  const starts = new Map<number, { title: string; level: 1 | 2 }>();
  for (const s of answer?.scenes ?? []) {
    const k = Math.round(s.first_line) - 1;
    const title = (s.title ?? "").replace(/^#+\s*(-\s*)?/, "").trim();
    if (k >= 0 && k < lines.length && title && !starts.has(k)) starts.set(k, { title, level: s.level === 2 ? 2 : 1 });
  }
  if (!starts.size) starts.set(0, { title: "촬영본", level: 1 });
  // The lines before the first part of the answer belong to it.
  if (!starts.has(0)) {
    const [k, first] = [...starts].sort((a, b) => a[0] - b[0])[0];
    starts.delete(k);
    starts.set(0, first);
  }
  // The document starts with a place.
  starts.get(0)!.level = 1;
  const out: PreviewLine[] = [];
  lines.forEach((l, i) => {
    const s = starts.get(i);
    if (s) out.push({ kind: "scene", text: s.title, level: s.level, tc: l.tc });
    out.push(l);
  });
  return out;
}

export async function addScenes(lines: PreviewLine[], model: string): Promise<PreviewLine[]> {
  if (!lines.length) return lines;
  const r = await callJson<SceneAnswer>({ model, parts: [{ text: buildScenePrompt(lines) }], schema: SCENE_SCHEMA, thinkingLevel: "MEDIUM", timeoutMs: 240_000, hedgeAfterMs: [90_000], label: "scenes" });
  if (!r.value?.scenes?.length) console.error(`NOTE: no answer for the scenes (${r.error ?? r.blocked ?? "empty"}); the document has one scene.`);
  return applyScenes(lines, r.value);
}
