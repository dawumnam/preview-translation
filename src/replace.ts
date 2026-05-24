import type { Translation } from "./translate";

function stripLineSegArrays(xml: string): string {
  return xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
}

export function replaceMarkers(
  xml: string,
  translations: Translation[],
  boldIds: Set<string>,
): string {
  // Build map: global marker index -> translation
  const translationMap = new Map<number, Translation>();
  for (const t of translations) {
    translationMap.set(t.markerIndex, t);
  }

  // Match bold <hp:run> containing @@ markers (with optional language code) in document order
  const idPattern = [...boldIds].join("|");
  const regex = new RegExp(
    `(<hp:run\\s+charPrIDRef="(?:${idPattern})"><hp:t>(?:[^<]|<hp:tab[^/]*\\/>)*)` +
    `(@@(?:\\([^)]+\\))?)[^<]*(</hp:t>)`,
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
      return `${prefix}${markerPrefix} ${t.translation}${confidenceSuffix}${suffix}`;
    },
  );

  // Strip cached line layout metrics so the viewer recalculates for new text lengths
  return stripLineSegArrays(newXml);
}
