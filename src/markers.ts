import { extractHwpx } from "./hwpx";
import { parseMarkers } from "./parser";
import { selectFor, takeSelectArg } from "./select";

const argv = process.argv.slice(2);
const selectArg = takeSelectArg(argv);
const hwpxPath = argv[0];
if (!hwpxPath) {
  console.error('Usage: bun src/markers.ts <hwpx-file> [--select "<words>"]');
  process.exit(1);
}

const hwpx = extractHwpx(hwpxPath, selectFor(hwpxPath, selectArg));
const { markers, scenes } = parseMarkers(hwpx.xml, hwpx.selectedIds);

console.log(JSON.stringify({ markers, scenes }, null, 2));
