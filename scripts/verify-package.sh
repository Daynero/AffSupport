#!/bin/zsh
set -euo pipefail
app="$PWD/release/Local Video Compressor Agent.app"
product_version=$(node scripts/release-meta.mjs product-version); bundle_version=$(node scripts/release-meta.mjs bundle-version); build_number=$(node scripts/release-meta.mjs build-number); build_id=$(node scripts/release-meta.mjs build-id); api_version=$(node scripts/release-meta.mjs api-version)
[[ -d "$app" && -x "$app/Contents/MacOS/LocalVideoCompressor" && -x "$app/Contents/Resources/runtime/node" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$bundle_version" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")" == "$build_number" ]]
grep -q "\"productVersion\": \"$product_version\"" "$app/Contents/Resources/release.json"
grep -q "\"buildId\": \"$build_id\"" "$app/Contents/Resources/release.json"
grep -q "\"apiVersion\": $api_version" "$app/Contents/Resources/release.json"
for name in ffmpeg ffprobe; do binary="$app/Contents/Resources/runtime/bin/$name"; [[ -x "$binary" ]]; file "$binary" | grep -q arm64; "$binary" -version >/dev/null; done
[[ -f apps/web/dist/index.html && -f "$app/Contents/Resources/agent/dist/index.js" ]]
diff -qr apps/agent/dist "$app/Contents/Resources/agent/dist" >/dev/null
diff -qr apps/web/dist "$app/Contents/Resources/web/dist" >/dev/null
diff -qr packages/shared/dist "$app/Contents/Resources/agent/node_modules/@video-compressor/shared/dist" >/dev/null
grep -q 'appendingPathComponent("local")' "$PWD/release/Launcher.generated.swift"
! grep -q '__[A-Z0-9_]*__' "$PWD/release/Launcher.generated.swift"
! grep -rnE '127\.0\.0\.1:5173|localhost:5173' apps/web/dist
! grep -rn '/opt/homebrew' "$app/Contents/Resources/agent" "$app/Contents/Resources/web"
for name in ffmpeg ffprobe; do ! otool -L "$app/Contents/Resources/runtime/bin/$name" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'; done
! otool -L "$app/Contents/Resources/runtime/node" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'
[[ -n "$(find "$app/Contents/Resources/licenses/sources" -type f -maxdepth 1)" ]]
codesign --verify --deep --strict "$app"
print "Package structure, runtime, media tools, architecture, and production web build verified."
