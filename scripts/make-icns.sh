#!/bin/zsh
set -euo pipefail
source_png="${1:?source PNG required}"; destination="${2:?destination ICNS required}"
iconset=$(mktemp -d /tmp/lvc-iconset.XXXXXX).iconset
mkdir -p "$iconset"
for spec in '16 icon_16x16' '32 icon_16x16@2x' '32 icon_32x32' '64 icon_32x32@2x' '128 icon_128x128' '256 icon_128x128@2x' '256 icon_256x256' '512 icon_256x256@2x' '512 icon_512x512' '1024 icon_512x512@2x'; do
  size=${spec%% *}; name=${spec#* }; sips -z "$size" "$size" "$source_png" --out "$iconset/$name.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$destination"
