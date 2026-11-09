#!/bin/zsh
set -euo pipefail
# Validate before any builds, admission, cleanup or listener changes.
arch=$(node scripts/lib/macos-target.mjs arch production "$@")
macho=$(node scripts/lib/macos-target.mjs macho production "$@")
swift_target=$(node scripts/lib/macos-target.mjs swift production "$@")
target_root=$(node scripts/lib/macos-target.mjs root production "$@")
app="$target_root/Soty.app"
finder_extension="$app/Contents/PlugIns/SotyFinderExtension.appex"
node scripts/verify-macos-payload.mjs "$app" --arch="$arch"
[[ "$arch" == x64 || "$(node -p process.arch)" == "$arch" ]] || { print -u2 "Matching native runtime required; static payload checks passed but runtime acceptance is unproven."; exit 1; }
finder_binary="$finder_extension/Contents/MacOS/SotyFinderExtension"
product_version=$(node scripts/release-meta.mjs product-version); bundle_version=$(node scripts/release-meta.mjs bundle-version); build_number=$(node scripts/release-meta.mjs build-number); build_id=$(node scripts/release-meta.mjs build-id); api_version=$(node scripts/release-meta.mjs api-version)
[[ -d "$app" && -x "$app/Contents/MacOS/SotyAgent" && -x "$app/Contents/Resources/runtime/node" ]]
[[ -d "$finder_extension" && -x "$finder_binary" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" == "$bundle_version" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist")" == "$build_number" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSServices:0:NSMenuItem:default' "$app/Contents/Info.plist")" == "Soty Finder Action" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$finder_extension/Contents/Info.plist")" == "local.video.compressor.test.finder-extension" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' "$finder_extension/Contents/Info.plist")" == "com.apple.FinderSync" ]]
file "$finder_binary" | grep -q "$macho"
for binary in "$app/Contents/MacOS/SotyAgent" "$finder_binary"; do
  vtool -show-build "$binary" | grep -q 'minos 13.0'
done
grep -q 'private let finderServiceName = "Soty Finder Action"' "$target_root/FinderSync.generated.swift"
grep -q 'private let finderMenuSuffix = ""' "$target_root/FinderSync.generated.swift"
! grep -q '__[A-Z0-9_]*__' "$target_root/FinderSync.generated.swift"
! grep -qiE 'case heic|case heif|\"heic\"|\"heif\"' "$target_root/FinderSync.generated.swift"
grep -q "\"productVersion\": \"$product_version\"" "$app/Contents/Resources/release.json"
grep -q "\"buildId\": \"$build_id\"" "$app/Contents/Resources/release.json"
grep -q "\"apiVersion\": $api_version" "$app/Contents/Resources/release.json"
for name in ffmpeg ffprobe; do binary="$app/Contents/Resources/runtime/bin/$name"; [[ -x "$binary" ]]; file "$binary" | grep -q "$macho"; if [[ "$arch" != x64 ]]; then "$binary" -version >/dev/null; fi; done
whisper_cli="$app/Contents/Resources/runtime/bin/whisper-cli"
[[ -x "$whisper_cli" && -s "$app/Contents/Resources/runtime/models/ggml-silero-v5.1.2.bin" ]]
file "$whisper_cli" | grep -q "$macho"
[[ -f apps/web/dist/index.html && -f "$app/Contents/Resources/agent/dist/index.js" ]]
diff -qr apps/agent/dist "$app/Contents/Resources/agent/dist" >/dev/null
diff -qr apps/web/dist "$app/Contents/Resources/web/dist" >/dev/null
diff -qr packages/shared/dist "$app/Contents/Resources/agent/node_modules/@video-compressor/shared/dist" >/dev/null
[[ -s "$app/Contents/Resources/agent/production-dependencies.json" ]]
if [[ "$arch" == x64 ]]; then
  node scripts/verify-staged-dependencies.mjs "$app/Contents/Resources/agent" --static
else
  node scripts/verify-staged-dependencies.mjs "$app/Contents/Resources/agent"
fi
for unwanted in @electric-sql @testing-library eslint jsdom prettier react react-dom tsx typescript vite vitest; do
  [[ ! -e "$app/Contents/Resources/agent/node_modules/$unwanted" ]]
done
grep -q 'appendingPathComponent("local")' "$target_root/Launcher.generated.swift"
! grep -q '__[A-Z0-9_]*__' "$target_root/Launcher.generated.swift"
! grep -rnE '127\.0\.0\.1:5173|localhost:5173' apps/web/dist
! grep -rn '/opt/homebrew' "$app/Contents/Resources/agent" "$app/Contents/Resources/web"
for name in ffmpeg ffprobe; do ! otool -L "$app/Contents/Resources/runtime/bin/$name" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'; done
! otool -L "$whisper_cli" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'
! otool -L "$app/Contents/Resources/runtime/node" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)'
if [[ "$arch" != x64 ]]; then
"$app/Contents/Resources/runtime/node" --version >/dev/null
(
  cd "$app/Contents/Resources/agent"
  ../runtime/node --input-type=module -e \
    "await import('fastify'); await import('@jsquash/webp/encode.js'); await import('@video-compressor/shared'); await import('playwright-core'); await import('yauzl'); await import('./dist/media-actions/image-converter.js'); await import('./dist/landing-preview/catalog.js');"
)
fi
[[ -n "$(find "$app/Contents/Resources/licenses/sources" -type f -maxdepth 1)" ]]
codesign --verify --deep --strict "$app"
codesign --verify --strict "$finder_extension"
finder_entitlements=$(codesign -d --entitlements - "$finder_extension" 2>/dev/null)
print -r -- "$finder_entitlements" | grep -q 'com.apple.security.app-sandbox'
print -r -- "$finder_entitlements" | grep -q 'com.apple.security.files.user-selected.read-only'
if [[ "$arch" == x64 ]]; then
  print "Intel package static checks passed under intel-user-feedback-v1. Native runtime is unverified; user feedback follows release."
else
  print "Slim package dependencies, runtimes, architecture, and production web build verified."
fi
