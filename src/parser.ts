export interface Marker {
  index: number;
  language: string;
  charName: string;
  timestamp: number;
  endTimestamp?: number;
  hint?: string;
  scene: string;
  rawText: string;
}

export interface SceneChunk {
  name: string;
  markers: Marker[];
  startTime: number;
  endTime: number;
  context: string[];
}

// Script language codes (the "x" in @@(x)) to the language names the STT returns.
// 오 (Austrian German) is reported by the STT as 독일어.
export const LANG_NAME: Record<string, string> = {
  영: "영어",
  독: "독일어",
  오: "독일어",
  베: "베트남어",
  조: "조지아어",
};

export function parseTimestamp(ts: string): number {
  ts = ts.trim();
  if (ts.length >= 5) {
    const h = parseInt(ts.slice(0, ts.length - 4));
    const m = parseInt(ts.slice(ts.length - 4, ts.length - 2));
    const s = parseInt(ts.slice(ts.length - 2));
    return h * 3600 + m * 60 + s;
  } else if (ts.length === 4) {
    const m = parseInt(ts.slice(0, 2));
    const s = parseInt(ts.slice(2, 4));
    return m * 60 + s;
  }
  return 0;
}

export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function parseMarkers(xml: string, selectedIds?: Set<string>): {
  markers: Marker[];
  scenes: SceneChunk[];
} {
  const paragraphs = [
    ...xml.matchAll(/<hp:p[^>]*>.*?<\/hp:p>/g),
  ].map((m) => m[0]);

  const markers: Marker[] = [];
  let currentScene = "";
  let currentTimestamp = 0;
  let currentChar = "";

  const sceneMap = new Map<
    string,
    {
      markers: Marker[];
      context: string[];
      startTime: number;
      endTime: number;
    }
  >();

  // The ids of the character styles that mark a requested line (see select.ts).
  const markerStyleIds = selectedIds ?? new Set<string>();

  let markerIndex = 0;

  for (const para of paragraphs) {
    const runs = [
      ...para.matchAll(
        /<hp:run\s+charPrIDRef="(\d+)">(.*?)<\/hp:run>/gs,
      ),
    ];

    let paraHasMarker = false;
    let paraIsScene = false;
    const paraContextTexts: string[] = [];

    for (const [, charPrId, runContent] of runs) {
      const tElements = [
        ...runContent.matchAll(/<hp:t>(.*?)<\/hp:t>/gs),
      ];

      for (const [, tContent] of tElements) {
        const segments = tContent.split(/<hp:tab[^/]*\/>/);
        const cleanSegments = segments.map((s) =>
          s.replace(/<[^>]+>/g, "").trim(),
        );
        const fullClean = cleanSegments.filter(Boolean).join(" ");

        // Scene header
        // "# 하차프리 식당" and "#케이블카" are both scene headers: writers do not
        // always put a space after #. With /^#\s/ the 1104 cable-car scene went
        // unseen and its markers were filed under the scene listed before it.
        if (fullClean.match(/^#(?!#)\s*\S/)) {
          currentScene = fullClean.replace(/^#\s*/, "").trim();
          if (!sceneMap.has(currentScene)) {
            sceneMap.set(currentScene, {
              markers: [],
              context: [],
              startTime: Infinity,
              endTime: 0,
            });
          }
          paraIsScene = true;
          continue;
        }

        // Timestamp (leading digits in first segment)
        const tsMatch = cleanSegments[0]?.match(/^(\d{4,6})/);
        if (tsMatch) {
          currentTimestamp = parseTimestamp(tsMatch[1]);
        }

        // Character name (second segment after first tab, must contain Korean).
        // When the leading TC tab sits in its own run, this <hp:t> is just
        // "name<tab>@@(\uc911)": the name is the first segment, and the second is
        // the marker itself (\uc911 is Hangul, so it would pass the Korean test).
        if (
          cleanSegments.length >= 2 &&
          cleanSegments[1] &&
          /[\uac00-\ud7a3]/.test(cleanSegments[1])
        ) {
          if (!cleanSegments[1].startsWith("@@")) {
            currentChar = cleanSegments[1];
          } else if (
            cleanSegments[0] &&
            !tsMatch &&
            /[\uac00-\ud7a3]/.test(cleanSegments[0])
          ) {
            currentChar = cleanSegments[0];
          }
        }

        // Marker check: @@ with optional (lang)
        if (fullClean.includes("@@")) {
          paraHasMarker = true;

          if (markerStyleIds.has(charPrId)) {
            const markerMatch = fullClean.match(/@@(?:\(([^)]+)\))?(.*)/);
            if (markerMatch) {
              const language = markerMatch[1] || "영";
              const suffix = markerMatch[2].trim();

              let endTimestamp: number | undefined;
              let hint: string | undefined;

              const rangeMatch = suffix.match(/^~\s*(\d{4,6})$/);
              if (rangeMatch) {
                endTimestamp = parseTimestamp(rangeMatch[1]);
                if (endTimestamp < currentTimestamp) {
                  const h = Math.floor(currentTimestamp / 3600);
                  endTimestamp = h * 3600 + endTimestamp;
                }
              } else if (suffix) {
                hint = suffix;
              }

              const marker: Marker = {
                index: markerIndex++,
                language,
                charName: currentChar,
                timestamp: currentTimestamp,
                endTimestamp,
                hint,
                scene: currentScene,
                rawText: fullClean,
              };

              markers.push(marker);

              if (!sceneMap.has(currentScene)) {
                sceneMap.set(currentScene, {
                  markers: [],
                  context: [],
                  startTime: Infinity,
                  endTime: 0,
                });
              }
              const scene = sceneMap.get(currentScene)!;
              scene.markers.push(marker);
              scene.context.push(`${fullClean} [marker ${marker.index}]`);
              const end = endTimestamp || currentTimestamp;
              scene.startTime = Math.min(scene.startTime, currentTimestamp);
              scene.endTime = Math.max(scene.endTime, end);
            }
          } else if (currentScene && sceneMap.has(currentScene)) {
            // An @@ line that is not requested is not translated, but it still takes a turn
            // in the exchange. Keep it in the context so a mapper does not
            // give its speech to a neighbouring requested marker.
            sceneMap.get(currentScene)!.context.push(`${fullClean} [not requested]`);
          }
          continue;
        }

        // Collect text for context
        if (fullClean && /[\uac00-\ud7a3]/.test(fullClean)) {
          paraContextTexts.push(fullClean);
        }
      }
    }

    // Add non-marker, non-scene Korean text as context
    if (
      !paraHasMarker &&
      !paraIsScene &&
      currentScene &&
      sceneMap.has(currentScene)
    ) {
      for (const text of paraContextTexts) {
        if (!text.match(/^-+$/) && text.length > 1) {
          sceneMap.get(currentScene)!.context.push(text);
        }
      }
    }
  }

  // Build scene chunks (only scenes with markers)
  const scenes: SceneChunk[] = [];
  for (const [name, data] of sceneMap) {
    if (data.markers.length > 0) {
      scenes.push({
        name,
        markers: data.markers,
        startTime: data.startTime === Infinity ? 0 : data.startTime,
        endTime: data.endTime,
        context: data.context,
      });
    }
  }

  return { markers, scenes };
}
