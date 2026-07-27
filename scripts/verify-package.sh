#!/bin/zsh
set -euo pipefail
app="$PWD/release/Wishly Agent.app"
finder_extension="$app/Contents/PlugIns/WishlyFinderExtension.appex"
finder_binary="$finder_extension/Contents/MacOS/WishlyFinderExtension"
product_version=$(node scripts/release-meta.mjs product-version); bundle_version=$(node scripts/release-meta.mjs bundle-version); build_number=$(node scripts/release-meta.mjs build-number); build_id=$(node scripts/release-meta.mjs build-id); api_version=$(node scripts/release-meta.mjs api-version)
[[ -d "$app" && -x "$app/Contents/MacOS/WishlyAgent" && -x "$app/Contents/Resources/runtime/node" ]]
[[ -d "$finder_extension" && -x "$finder_binary" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$bundle_version" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")" == "$build_number" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSServices:0:NSMenuItem:default' "$app/Contents/Info.plist")" == "Wishly Finder Action" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$finder_extension/Contents/Info.plist")" == "local.video.compressor.test.finder-extension" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' "$finder_extension/Contents/Info.plist")" == "com.apple.FinderSync" ]]
file "$finder_binary" | grep -q arm64
for binary in "$app/Contents/MacOS/WishlyAgent" "$finder_binary"; do
  vtool -show-build "$binary" | grep -q 'minos 13.0'
done
grep -q 'private let finderServiceName = "Wishly Finder Action"' "$PWD/release/FinderSync.generated.swift"
grep -q 'private let finderMenuSuffix = ""' "$PWD/release/FinderSync.generated.swift"
! grep -q '__[A-Z0-9_]*__' "$PWD/release/FinderSync.generated.swift"
! grep -qiE 'case heic|case heif|\"heic\"|\"heif\"' "$PWD/release/FinderSync.generated.swift"
grep -q "\"productVersion\": \"$product_version\"" "$app/Contents/Resources/release.json"
grep -q "\"buildId\": \"$build_id\"" "$app/Contents/Resources/release.json"
grep -q "\"apiVersion\": $api_version" "$app/Contents/Resources/release.json"
for name in ffmpeg ffprobe; do binary="$app/Contents/Resources/runtime/bin/$name"; [[ -x "$binary" ]]; file "$binary" | grep -q arm64; "$binary" -version >/dev/null; done
whisper_cli="$app/Contents/Resources/runtime/bin/whisper-cli"
[[ -x "$whisper_cli" && -s "$app/Contents/Resources/runtime/models/ggml-silero-v5.1.2.bin" ]]
file "$whisper_cli" | grep -q arm64
[[ ! -e "$app/Contents/Resources/runtime/llama" ]]
[[ -f "$app/Contents/Resources/licenses/llama.cpp-LICENSE" ]]
for notice in GEMMA_TERMS.md GEMMA_PROHIBITED_USE_POLICY.md NOTICE-Gemma.txt multilingual-e5-small-MIT.txt; do
  [[ -s "$app/Contents/Resources/licenses/$notice" ]]
done
[[ -f apps/web/dist/index.html && -f "$app/Contents/Resources/agent/dist/index.js" ]]
diff -qr apps/agent/dist "$app/Contents/Resources/agent/dist" >/dev/null
diff -qr apps/web/dist "$app/Contents/Resources/web/dist" >/dev/null
diff -qr packages/shared/dist "$app/Contents/Resources/agent/node_modules/@video-compressor/shared/dist" >/dev/null
[[ -s "$app/Contents/Resources/agent/production-dependencies.json" ]]
for unwanted in @electric-sql @testing-library eslint jsdom prettier react react-dom tsx typescript vite vitest; do
  [[ ! -e "$app/Contents/Resources/agent/node_modules/$unwanted" ]]
done
grep -q 'appendingPathComponent("local")' "$PWD/release/Launcher.generated.swift"
! grep -q '__[A-Z0-9_]*__' "$PWD/release/Launcher.generated.swift"
! grep -rnE '127\.0\.0\.1:5173|localhost:5173' apps/web/dist
! grep -rn '/opt/homebrew' "$app/Contents/Resources/agent" "$app/Contents/Resources/web"
for name in ffmpeg ffprobe; do ! otool -L "$app/Contents/Resources/runtime/bin/$name" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'; done
! otool -L "$whisper_cli" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'
! otool -L "$app/Contents/Resources/runtime/node" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'
"$app/Contents/Resources/runtime/node" --version >/dev/null
(
  cd "$app/Contents/Resources/agent"
  ../runtime/node --input-type=module -e \
    "await import('fastify'); await import('@jsquash/webp/encode.js'); await import('@video-compressor/shared'); await import('./dist/media-actions/image-converter.js');"
)
[[ -n "$(find "$app/Contents/Resources/licenses/sources" -type f -maxdepth 1)" ]]
codesign --verify --deep --strict "$app"
codesign --verify --strict "$finder_extension"
finder_entitlements=$(codesign -d --entitlements - "$finder_extension" 2>/dev/null)
print -r -- "$finder_entitlements" | grep -q 'com.apple.security.app-sandbox'
print -r -- "$finder_entitlements" | grep -q 'com.apple.security.files.user-selected.read-only'
print "Slim package dependencies, runtimes, architecture, and production web build verified."
