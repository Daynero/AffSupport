#!/bin/zsh
set -euo pipefail
app="$PWD/release/Local Video Compressor Agent.app"
[[ -d "$app" && -x "$app/Contents/MacOS/LocalVideoCompressor" && -x "$app/Contents/Resources/runtime/node" ]]
for name in ffmpeg ffprobe; do binary="$app/Contents/Resources/runtime/bin/$name"; [[ -x "$binary" ]]; file "$binary" | grep -q arm64; "$binary" -version >/dev/null; done
[[ -f apps/web/dist/index.html && -f "$app/Contents/Resources/agent/dist/index.js" ]]
! grep -rnE '127\.0\.0\.1:5173|localhost:5173' apps/web/dist
! grep -rn '/opt/homebrew' "$app/Contents/Resources/agent" "$app/Contents/Resources/web"
for name in ffmpeg ffprobe; do ! otool -L "$app/Contents/Resources/runtime/bin/$name" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'; done
! otool -L "$app/Contents/Resources/runtime/node" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'
[[ -n "$(find "$app/Contents/Resources/licenses/sources" -type f -maxdepth 1)" ]]
print "Package structure, runtime, media tools, architecture, and production web build verified."
