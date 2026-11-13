#!/bin/zsh
set -euo pipefail
# This is the same launcher and native updater source for ARM and Intel.
source_file=$1; output=$2; target=$3; app=$4; arch=$5
policy="${source_file:h}/NativeUpdateBuildPolicy.generated.swift"
object="${source_file:h}/SparkleDriver.o"
node scripts/stage-native-updates.mjs "$app" "$policy" "$arch"
clang_args=()
swift_args=()
if [[ -n "${SOTY_NATIVE_MODULE_CACHE:-}" ]]; then
  clang_args+=(-fmodules-cache-path="$SOTY_NATIVE_MODULE_CACHE")
  swift_args+=(-module-cache-path "$SOTY_NATIVE_MODULE_CACHE")
fi
clang "${clang_args[@]}" -fobjc-arc -fmodules -target "$target" -F "$app/Contents/Frameworks" \
  -c packaging/NativeUpdates/SparkleDriver.m -o "$object"
cp "$source_file" "${source_file:h}/main.swift"
swiftc -j 1 "${swift_args[@]}" "${source_file:h}/main.swift" packaging/NativeUpdates/*.swift "$policy" "$object" \
  -import-objc-header packaging/NativeUpdates/SparkleDriver.h \
  -o "$output" -target "$target" -F "$app/Contents/Frameworks" \
  -Xlinker -rpath -Xlinker @executable_path/../Frameworks \
  -framework AppKit -framework FinderSync -framework Security -framework Sparkle
