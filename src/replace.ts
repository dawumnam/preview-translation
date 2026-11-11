export interface TranslationSegment {
  timestamp: number; // seconds from the start of the media
  text: string;
}

export interface Translation {
  markerIndex: number;
  language: string;
  charName: string;
  timestamp: number;
  scene: string;
  speech_start?: number; // seconds: the audio this translation was written from
  speech_end?: number; //   (the billing basis)
  translation?: string; // the Korean text for the marker line
  segments?: TranslationSegment[]; // old split format; joined into one line
  confidence: "high" | "medium" | "low";
}

function stripLineSegArrays(xml: string): string {
  return xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// The text that goes into the marker line. The script's TC stays as the
// writer typed it: no line is added and no TC is changed (editor request —
// inserted TC lines drifted from the video and made editing hard). Entries
// from older runs that still carry several segments are joined into one line.
export function translationText(t: Translation): string {
  if (t.segments && t.segments.length > 0) {
    return [...t.segments]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(" ");
  }
  return t.translation ?? "";
}

export function replaceMarkers(
  xml: string,
  translations: Translation[],
  selectedIds: Set<string>,
): string {
  const translationMap = new Map<number, Translation>();
  for (const t of translations) {
    translationMap.set(t.markerIndex, t);
  }

  // Match each <hp:run> in a requested style that contains an @@ marker (with optional language code) in document order
  const idPattern = [...selectedIds].join("|");
  const regex = new RegExp(
    `(<hp:run\\s+charPrIDRef="(?:${idPattern})"><hp:t>(?:[^<]|<hp:tab[^/]*\\/>)*)` +
    `(@@(?:\\([^)]+\\))?)(?:[^<]|<hp:tab[^/]*\\/>)*(</hp:t>)`,
    "g",
  );

  let markerIndex = 0;
  const newXml = xml.replace(
    regex,
    (_match, prefix: string, markerPrefix: string, suffix: string) => {
      const t = translationMap.get(markerIndex);
      markerIndex++;

      if (!t) {
        // No translation: keep marker prefix, strip any hint/range text
        return `${prefix}${markerPrefix}${suffix}`;
      }

      const confidenceSuffix = t.confidence === "low" ? " ??" : "";
      return `${prefix}${markerPrefix} ${escapeXml(translationText(t))}${confidenceSuffix}${suffix}`;
    },
  );

  // Strip cached line layout metrics so the viewer recalculates for new text lengths
  return stripLineSegArrays(newXml);
}
