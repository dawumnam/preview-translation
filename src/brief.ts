// Episode brief: one text call over the whole script, made while the audio is
// decoded. It gives every listening window the same notes: who the speakers
// are, and how the scriptwriter spells the names and local words.
//
// Without it each window spells names on its own. That was the most frequent
// fix in review (1025: 17 of 23 changed lines were spellings such as
// 틀라피 → 끌라비).
import { callJson } from "./llm";
import { LANG_NAME } from "./parser";
import type { ScriptLine } from "./script";

export interface Brief {
  summary: string;
  cast: { name: string; who: string }[];
  glossary: { ko: string; original: string; meaning: string }[];
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "2-3 sentences in English: where the episode is shot and what happens" },
    cast: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "Speaker label exactly as in the script" },
          who: { type: "STRING", description: "Who this is, in a few English words (role, sex, age if the script shows it, what language they speak)" },
        },
        required: ["name", "who"],
      },
    },
    glossary: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          ko: { type: "STRING", description: "The word exactly as the script spells it in Korean" },
          variants: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Other spellings of the same word that the script also uses. Empty when there is one spelling.",
          },
          original: { type: "STRING", description: "The word in the local language and script, if you know it; else empty" },
          meaning: { type: "STRING", description: "What it is, in a few English words" },
        },
        required: ["ko", "variants", "original", "meaning"],
      },
    },
  },
  required: ["summary", "cast", "glossary"],
};

export async function makeBrief(lines: ScriptLine[], model: string): Promise<Brief | null> {
  const langs = [...new Set(lines.filter((l) => l.marker).map((l) => LANG_NAME[l.marker!.language] ?? l.marker!.language))];
  const text = lines
    .map((l) => {
      if (l.kind === "scene") return `# ${l.text}`;
      if (l.kind === "marker" || l.kind === "unrequested") return `${l.speaker ?? ""}: (foreign-language turn)`;
      return `${l.speaker ? l.speaker + ": " : ""}${l.text.slice(0, 220)}`;
    })
    .join("\n");
  const prompt = `Below is the production script (shot log) of one day of raw footage for a Korean TV travel programme. Korean speech is written out; foreign-language turns (${langs.join(", ")}) are placeholders. Interpreters will listen to the footage and translate those turns into Korean. Prepare their notes.

1. summary: where this is and what happens.
2. cast: every speaker label that has dialogue or a foreign-language turn. 큐 is the Korean host, 피 the director, 코 the coordinator/interpreter. Other labels name locals by look (모남 = man in a hat, 검여 = woman in black, 할 = grandfather ...). Use the shot descriptions and dialogue to say who each one is.
3. glossary: every proper noun and local word in the script that an interpreter could spell another way: place names, people's names, dishes, drinks, tools, buildings, customs. Give the script's own Korean spelling, with no particle attached. If the script spells one thing in several ways, make ONE entry and put the other spellings in \`variants\`. Leave out ordinary Korean words.

## Script
${text}`;
  const r = await callJson<Brief>({
    model, parts: [{ text: prompt }], schema: SCHEMA, thinkingLevel: "LOW",
    timeoutMs: 60_000, hedgeAfterMs: 15_000, attempts: 2, label: "brief",
  });
  if (!r.value || !Array.isArray(r.value.glossary) || !Array.isArray(r.value.cast)) return null;
  return { ...r.value, glossary: tidyGlossary(r.value.glossary, text) };
}

/**
 * One spelling for each thing, and only spellings that are in the script.
 * Scripts spell one word in several ways (1025: 끌라비 four times, 클라피 and
 * 틀라비 once each). The model groups the spellings; the count in the script
 * picks the one to use.
 */
export function tidyGlossary(
  glossary: (Brief["glossary"][number] & { variants?: string[] })[],
  scriptText: string,
): Brief["glossary"] {
  const count = (word: string) => (word ? scriptText.split(word).length - 1 : 0);
  const out: Brief["glossary"] = [];
  const seen = new Set<string>();
  for (const entry of glossary) {
    const spellings = [entry.ko, ...(entry.variants ?? [])].map((w) => (w ?? "").trim()).filter(Boolean);
    const ranked = spellings.map((w) => ({ w, n: count(w) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    if (!ranked.length || seen.has(ranked[0].w)) continue; // not in the script, or listed twice
    seen.add(ranked[0].w);
    out.push({ ko: ranked[0].w, original: entry.original ?? "", meaning: entry.meaning ?? "" });
  }
  return out;
}

/** The brief as prompt text. */
export function briefText(b: Brief | null): string {
  if (!b) return "";
  const cast = b.cast.map((c) => `- ${c.name}: ${c.who}`).join("\n");
  const glossary = b.glossary.map((g) => `- ${g.ko}${g.original ? ` (${g.original})` : ""}: ${g.meaning}`).join("\n");
  return `${b.summary}\n\nSpeakers:\n${cast}\n\nSpellings to use in Korean (the scriptwriter's own):\n${glossary}`;
}
