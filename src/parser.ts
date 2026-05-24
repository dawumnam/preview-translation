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

export function parseMarkers(xml: string, boldIds?: Set<string>): {
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

  // Use provided boldIds, or fall back to detecting bold IDs from @@ runs
  const markerStyleIds = boldIds ?? new Set<string>();

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
        if (fullClean.match(/^#\s/)) {
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

        // Character name (second segment after first tab, must contain Korean)
        if (
          cleanSegments.length >= 2 &&
          cleanSegments[1] &&
          /[\uac00-\ud7a3]/.test(cleanSegments[1])
        ) {
          currentChar = cleanSegments[1];
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
              const end = endTimestamp || currentTimestamp;
              scene.startTime = Math.min(scene.startTime, currentTimestamp);
              scene.endTime = Math.max(scene.endTime, end);
            }
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
