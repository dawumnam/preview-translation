#!/bin/bash
# Convert .hwp → .hwpx using the hwp2hwpx Java library.
# usage: tools/hwp2hwpx/convert.sh <input.hwp> [output.hwpx]
# Default output: same path with .hwpx extension.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
JAVA=/opt/homebrew/opt/openjdk/bin/java
[ -f "$DIR/classes/Hwp2HwpxCli.class" ] || "$DIR/build.sh"
IN="$1"
OUT="${2:-${IN%.hwp}.hwpx}"
exec "$JAVA" -cp "$DIR/classes:$DIR/lib/hwplib-1.1.10.jar:$DIR/lib/hwpxlib-1.0.9.jar" Hwp2HwpxCli "$IN" "$OUT"
