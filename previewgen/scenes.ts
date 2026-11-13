// Scene headers. A text call reads the finished lines and says where each
// scene starts and what its title is.
//
// The human previews have one level of "# title" lines with no fixed rule: a
// scene is 1 to 51 minutes, and one episode has 6 to 19 of them. The writer
// starts a scene when the footage becomes another kind of footage (scenery
// shots, the host alone, a meeting, an interview, an activity, a meal) or
// when the place changes.
//
// Two divisions, measured on the nine Georgia previews with the "#" lines
// taken out (104 scenes of the writer):
// - one level (the default): 1.3 times the writer's count of scenes; 70% of
//   the writer's scene starts are a start here to within 30 s (80% to within
//   90 s);
// - two levels (place, then activity at the place): 2 times the count; 76%
//   of the writer's starts to within 30 s (87% to within 90 s).
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
          level: { type: "INTEGER", description: "1 = a scene, or a new place when two levels are asked for. 2 = a new activity or person at the same place." },
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

export const SCENE_INTRO = `Below is the preview log of one day of raw footage for a Korean TV travel documentary: shots and spoken turns in time order, each with a line number and a time. 큐 is the host, 피 the director, 카감 the camera director, 코 the coordinator; other labels are locals.`;

/** One level, as in the human previews. The examples in it are made up: they are not from a human preview. */
export const SCENE_RULES = `Divide the log into scenes, as the 프리뷰어 does with "# title" lines, and give each scene a title.

The 프리뷰어 starts a new scene when the footage becomes another kind of footage for some minutes, or when the place changes:
- a block of scenery or detail shots with no talk (the title ends in sk);
- the host alone: he walks, drives or speaks to the camera (all takes of it together are one scene);
- the host meets a person and they talk; an interview with one person (a new scene when the interview proper starts after the meeting, or when another person becomes the main person);
- an activity or a work process that someone shows. A long process is cut at its main steps (양털 깎는 흰남, then 양털 씻는, then 실 잣는 할머);
- a visit to a house or a room that the people walk through; a meal; a goodbye; a drive or a walk to the next place.
Talk between takes and directions of the crew do not start a scene. Takes of the same action are one scene.

How many scenes: a day of footage has 6 to 19 scenes, about one for each 10 to 18 minutes. A scene is 1 to 50 minutes long: a short goodbye or a drive can be a scene of one or two minutes, and a visit with one long conversation can be one scene of 40 minutes. Do not cut a long conversation or a long activity into parts when its subject stays the same.

The title is a short Korean phrase in the style of the shot lines. It names the people or the place and the activity. For example: 시장 sk / 흰남 인터뷰 / 양털 깎는 흰남 / 국수 먹어보는 큐 / 흰남 집에 가는 / 가족과 식사하는 큐 / 차 안, 창밖 풍경 tr.

Return the scenes in order. \`first_line\` is the number of the first line of the scene, \`level\` is 1. The first scene starts at line 1. A scene nearly always starts at a shot line: take the first shot line of the new footage.`;

const TWO_LEVEL_RULES = `Divide the log into parts on two levels, and give each part a title.

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

Return the parts in order. \`first_line\` is the number of the first line of the part, \`level\` is 1 or 2. The first part starts at line 1 with level 1. A part starts at a shot line when there is one at the change.`;

/** The prompt that asks for the scenes of these lines: one level as in the human previews, or two levels. */
export function buildScenePrompt(lines: PreviewLine[], levels: 1 | 2 = 1): string {
  const body = lines.map((l, i) => `${i + 1} [${clock(l.tc ?? 0)}] ${brief(l)}`).join("\n");
  return `${SCENE_INTRO}\n\n${levels === 2 ? TWO_LEVEL_RULES : SCENE_RULES}\n\n## Log\n${body}`;
}

/**
 * The lines with a scene line before the first line of each part. Without a
 * usable answer: one scene for all. With `levels` 1 every scene is of level 1.
 */
export function applyScenes(lines: PreviewLine[], answer: SceneAnswer | undefined, levels: 1 | 2 = 2): PreviewLine[] {
  const starts = new Map<number, { title: string; level: 1 | 2 }>();
  for (const s of answer?.scenes ?? []) {
    const k = Math.round(s.first_line) - 1;
    const title = (s.title ?? "").replace(/^#+\s*(-\s*)?/, "").trim();
    if (k >= 0 && k < lines.length && title && !starts.has(k)) starts.set(k, { title, level: levels === 2 && s.level === 2 ? 2 : 1 });
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

export async function addScenes(lines: PreviewLine[], model: string, levels: 1 | 2 = 1): Promise<PreviewLine[]> {
  if (!lines.length) return lines;
  const r = await callJson<SceneAnswer>({ model, parts: [{ text: buildScenePrompt(lines, levels) }], schema: SCENE_SCHEMA, thinkingLevel: "MEDIUM", timeoutMs: 240_000, hedgeAfterMs: [90_000], label: "scenes" });
  if (!r.value?.scenes?.length) console.error(`NOTE: no answer for the scenes (${r.error ?? r.blocked ?? "empty"}); the document has one scene.`);
  return applyScenes(lines, r.value, levels);
}
