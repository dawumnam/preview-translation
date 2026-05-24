import { extractHwpx } from "./hwpx";
import { parseMarkers } from "./parser";

const hwpxPath = process.argv[2];
if (!hwpxPath) {
  console.error("Usage: bun src/markers.ts <hwpx-file>");
  process.exit(1);
}

const hwpx = extractHwpx(hwpxPath);
const { markers, scenes } = parseMarkers(hwpx.xml, hwpx.boldIds);

console.log(JSON.stringify({ markers, scenes }, null, 2));
