#!/bin/bash
# Build the hwp2hwpx converter: download hwplib/hwpxlib jars and compile.
# Sources in upstream/java are from https://github.com/neolord0/hwp2hwpx
# (commit 50ae71b, Apache-2.0 — see upstream/license.txt).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
JAVAC=/opt/homebrew/opt/openjdk/bin/javac

mkdir -p "$DIR/lib"
for a in "hwplib 1.1.10" "hwpxlib 1.0.9"; do
  set -- $a
  jar="$DIR/lib/$1-$2.jar"
  [ -f "$jar" ] || curl -sf -o "$jar" "https://repo1.maven.org/maven2/kr/dogfoot/$1/$2/$1-$2.jar"
done

mkdir -p "$DIR/classes"
find "$DIR/upstream/java" -name '*.java' > "$DIR/sources.txt"
"$JAVAC" -encoding UTF-8 -cp "$DIR/lib/hwplib-1.1.10.jar:$DIR/lib/hwpxlib-1.0.9.jar" \
  -d "$DIR/classes" @"$DIR/sources.txt" "$DIR/Hwp2HwpxCli.java"
echo "built $DIR/classes"
