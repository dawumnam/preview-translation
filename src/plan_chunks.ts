import path from "path";
import { extractHwpx } from "./hwpx";
import { parseMarkers, formatTimestamp } from "./parser";
import type { Marker, SceneChunk } from "./parser";

const MAX_CHUNK_DURATION = 300; // 5 minutes in seconds
const BUFFER = 60; // leading buffer
const END_BUFFER = 60; // trailing buffer for last marker

interface ChunkPlan {
  chunk_id: string;
  scene: string;
  start_sec: number;
  end_sec: number;
  audio_start: number; // with buffer applied
  audio_end: number; // with buffer applied
  marker_indices: number[];
  markers: Marker[];
  context: string[];
}

function splitScene(
  scene: SceneChunk,
  chunkPrefix: string,
): ChunkPlan[] {
  const markers = [...scene.markers].sort((a, b) => a.timestamp - b.timestamp);

  if (markers.length === 0) return [];

  const startTime = markers[0].timestamp;
  const endTime = Math.max(
    ...markers.map((m) => m.endTimestamp || m.timestamp),
  );
  const duration = endTime - startTime;

  // Single chunk if under threshold
  if (duration <= MAX_CHUNK_DURATION) {
    return [
      {
        chunk_id: chunkPrefix,
        scene: scene.name,
        start_sec: startTime,
        end_sec: endTime,
        audio_start: Math.max(0, startTime - BUFFER),
        audio_end: endTime + END_BUFFER,
        marker_indices: markers.map((m) => m.index),
        markers,
        context: scene.context,
      },
    ];
  }

  // Find largest gap between consecutive marker timestamps
  const uniqueTimes = [...new Set(markers.map((m) => m.timestamp))].sort(
    (a, b) => a - b,
  );

  let bestGapIdx = 0;
  let bestGapSize = 0;
  for (let i = 1; i < uniqueTimes.length; i++) {
    const gap = uniqueTimes[i] - uniqueTimes[i - 1];
    if (gap > bestGapSize) {
      bestGapSize = gap;
      bestGapIdx = i;
    }
  }

  // If no meaningful gap found (all same timestamp), just return as one chunk
  if (bestGapSize === 0) {
    return [
      {
        chunk_id: chunkPrefix,
        scene: scene.name,
        start_sec: startTime,
        end_sec: endTime,
        audio_start: Math.max(0, startTime - BUFFER),
        audio_end: endTime + END_BUFFER,
        marker_indices: markers.map((m) => m.index),
        markers,
        context: scene.context,
      },
    ];
  }

  const splitTime = uniqueTimes[bestGapIdx];
  const leftMarkers = markers.filter((m) => m.timestamp < splitTime);
  const rightMarkers = markers.filter((m) => m.timestamp >= splitTime);

  const leftScene: SceneChunk = {
    name: scene.name,
    markers: leftMarkers,
    startTime: leftMarkers[0]?.timestamp ?? startTime,
    endTime: Math.max(
      ...leftMarkers.map((m) => m.endTimestamp || m.timestamp),
    ),
    context: scene.context,
  };

  const rightScene: SceneChunk = {
    name: scene.name,
    markers: rightMarkers,
    startTime: rightMarkers[0]?.timestamp ?? splitTime,
    endTime: Math.max(
      ...rightMarkers.map((m) => m.endTimestamp || m.timestamp),
    ),
    context: scene.context,
  };

  const leftChunks = splitScene(leftScene, `${chunkPrefix}a`);
  const rightChunks = splitScene(rightScene, `${chunkPrefix}b`);

  return [...leftChunks, ...rightChunks];
}

// --- Main ---
const hwpxPath = process.argv[2];
const mp3Path = process.argv[3];

if (!hwpxPath || !mp3Path) {
  console.error("Usage: bun src/plan_chunks.ts <hwpx-file> <mp3-file>");
  process.exit(1);
}

const resolvedHwpxPath = path.resolve(hwpxPath);
const resolvedMp3Path = path.resolve(mp3Path);
const baseDir = path.dirname(resolvedHwpxPath);

const hwpx = extractHwpx(resolvedHwpxPath);
const { markers, scenes } = parseMarkers(hwpx.xml, hwpx.boldIds);

console.error(
  `Parsed ${markers.length} markers in ${scenes.length} scenes`,
);

const allChunks: ChunkPlan[] = [];
for (let i = 0; i < scenes.length; i++) {
  const scene = scenes[i];
  const prefix = String(i + 1).padStart(2, "0");
  const chunks = splitScene(scene, prefix);
  allChunks.push(...chunks);

  for (const chunk of chunks) {
    console.error(
      `  ${chunk.chunk_id} ${scene.name}: ${formatTimestamp(chunk.start_sec)}-${formatTimestamp(chunk.end_sec)} (${chunk.marker_indices.length} markers, ${Math.round((chunk.end_sec - chunk.start_sec) / 60 * 10) / 10}min)`,
    );
  }
}

const output = {
  hwpx_path: resolvedHwpxPath,
  mp3_path: resolvedMp3Path,
  total_markers: markers.length,
  total_chunks: allChunks.length,
  chunks: allChunks,
};

const outPath = path.join(baseDir, "chunks_plan.json");
await Bun.write(outPath, JSON.stringify(output, null, 2));
console.error(`\nWrote ${outPath} (${allChunks.length} chunks)`);
