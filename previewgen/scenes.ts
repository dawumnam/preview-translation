// Scene headers ("# 두여 만나서 인터뷰"). A text call reads the finished lines
// and says where each scene starts and what its title is.
import { callJson } from "../src/llm";
import { clock } from "../src/script";
import type { PreviewLine } from "./gt";

export interface SceneAnswer {
  scenes: { first_line: number; title: string }[];
}

const SCENE_SCHEMA = {
  type: "OBJECT",
  properties: {
    scenes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          first_line: { type: "INTEGER", description: "Number of the first line of the scene" },
          title: { type: "STRING", description: "Short Korean title in the house style" },
        },
        required: ["first_line", "title"],
        propertyOrdering: ["first_line", "title"],
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

/** The prompt that asks for the scenes of these lines. */
export function buildScenePrompt(lines: PreviewLine[]): string {
  const body = lines.map((l, i) => `${i + 1} [${clock(l.tc ?? 0)}] ${brief(l)}`).join("\n");
  return `Below is the preview log of one day of raw footage for a Korean TV travel documentary: shots and spoken turns in time order, each with a line number and a time. 큐 is the host, 피 the director, 카감 the camera director, 코 the coordinator; other labels are locals.

Divide the log into scenes, as the 프리뷰어 does with "# title" lines, and give each scene a title.

A scene is a stretch of footage in one place with one activity: the host walks and talks to the camera (all the takes together), a set of scenery shots, a visit to a house, an interview with one person, a meal, a drive. A new scene starts when the place or the activity changes. Takes of the same action are one scene. A scene is seldom shorter than three minutes; most are 5 to 25 minutes, and two hours of footage have about 6 to 12 scenes. One visit or one interview is one scene, also when the people move from room to room; start a new scene inside it only when the subject of the talk and the place both change for a long time. Scenery shots that go with the scene around them (the house before the visit to it) can stay in that scene, but a long set of scenery shots is its own scene.

The title is a short Korean phrase that ends in a noun, in the style of the shot lines. It names the place or the people and the activity. Examples from finished logs:
걸어가는 큐, 길, 집 등 sk / 두여 집 방문하는 큐 / 두여와 작별인사 / 포도나무 sk / 게스트하우스에 간 큐 / 주인들과 식사하는 큐 / 마을 sk / 하차프리 식당 / 음식 먹는 큐 / 산길 걷는 큐, 산길 sk / 동네주민들 인터뷰 / 흰여 인터뷰 / 포도따는 자매들, 인터뷰

Return the scenes in order. \`first_line\` is the number of the first line of the scene. The first scene starts at line 1. A scene starts at a shot line when there is one at the change.

## Log
${body}`;
}

/** The lines with a scene line before the first line of each scene. Without a usable answer: one scene for all. */
export function applyScenes(lines: PreviewLine[], answer: SceneAnswer | undefined): PreviewLine[] {
  const starts = new Map<number, string>();
  for (const s of answer?.scenes ?? []) {
    const k = Math.round(s.first_line) - 1;
    const title = (s.title ?? "").replace(/^#+\s*/, "").trim();
    if (k >= 0 && k < lines.length && title && !starts.has(k)) starts.set(k, title);
  }
  if (!starts.size) starts.set(0, "촬영본");
  // The lines before the first scene of the answer belong to it.
  if (!starts.has(0)) {
    const [k, title] = [...starts].sort((a, b) => a[0] - b[0])[0];
    starts.delete(k);
    starts.set(0, title);
  }
  const out: PreviewLine[] = [];
  lines.forEach((l, i) => {
    if (starts.has(i)) out.push({ kind: "scene", text: starts.get(i)!, tc: l.tc });
    out.push(l);
  });
  return out;
}

export async function addScenes(lines: PreviewLine[], model: string): Promise<PreviewLine[]> {
  if (!lines.length) return lines;
  const r = await callJson<SceneAnswer>({ model, parts: [{ text: buildScenePrompt(lines) }], schema: SCENE_SCHEMA, thinkingLevel: "MEDIUM", timeoutMs: 180_000, hedgeAfterMs: [60_000], label: "scenes" });
  if (!r.value?.scenes?.length) console.error(`NOTE: no answer for the scenes (${r.error ?? r.blocked ?? "empty"}); the document has one scene.`);
  return applyScenes(lines, r.value);
}
