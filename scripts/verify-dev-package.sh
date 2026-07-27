#!/bin/zsh
set -euo pipefail

app="$PWD/release/dev/Wishly Dev.app"
finder_extension="$app/Contents/PlugIns/WishlyFinderExtension.appex"
finder_binary="$finder_extension/Contents/MacOS/WishlyFinderExtension"
[[ -d "$app" ]]
[[ -d "$finder_extension" && -x "$finder_binary" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == "com.wishly.dev" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$app/Contents/Info.plist")" == "Wishly Dev" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSServices:0:NSMenuItem:default' "$app/Contents/Info.plist")" == "Wishly Dev Finder Action" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSServices:0:NSPortName' "$app/Contents/Info.plist")" == "Wishly Dev" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$finder_extension/Contents/Info.plist")" == "com.wishly.dev.finder-extension" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :NSExtension:NSExtensionPointIdentifier' "$finder_extension/Contents/Info.plist")" == "com.apple.FinderSync" ]]
grep -q '"channel": "development"' "$app/Contents/Resources/release.json"
grep -q 'private let agentPort = 43130' "$PWD/release/dev/Launcher.generated.swift"
grep -q 'private let instanceLockName = "wishly-dev-agent.lock"' "$PWD/release/dev/Launcher.generated.swift"
grep -q 'private let supportDirectoryName = "Wishly Dev"' "$PWD/release/dev/Launcher.generated.swift"
grep -q 'private let finderServiceName = "Wishly Dev Finder Action"' "$PWD/release/dev/FinderSync.generated.swift"
grep -q 'private let finderMenuSuffix = " — Wishly Dev"' "$PWD/release/dev/FinderSync.generated.swift"
! grep -q '__[A-Z0-9_]*__' "$PWD/release/dev/FinderSync.generated.swift"
! grep -qiE 'case heic|case heif|\"heic\"|\"heif\"' "$PWD/release/dev/FinderSync.generated.swift"
grep -q 'VITE_ANALYTICS_ENABLED=false' scripts/package-dev-mac.sh
grep -q 'VITE_LOCAL_DEV_AUTH=true' scripts/package-dev-mac.sh
codesign --verify --deep --strict "$app"
codesign --verify --strict "$finder_extension"
finder_entitlements=$(codesign -d --entitlements - "$finder_extension" 2>/dev/null)
print -r -- "$finder_entitlements" | grep -q 'com.apple.security.app-sandbox'
print -r -- "$finder_entitlements" | grep -q 'com.apple.security.files.user-selected.read-only'
for binary in "$app/Contents/MacOS/WishlyAgent" "$finder_binary" "$app/Contents/Resources/runtime/node" "$app/Contents/Resources/runtime/bin/ffmpeg" "$app/Contents/Resources/runtime/bin/ffprobe" "$app/Contents/Resources/runtime/bin/whisper-cli"; do
  file "$binary" | grep -q arm64
done
for binary in "$app/Contents/MacOS/WishlyAgent" "$finder_binary"; do
  vtool -show-build "$binary" | grep -q 'minos 13.0'
done
[[ -s "$app/Contents/Resources/runtime/models/ggml-silero-v5.1.2.bin" ]]
[[ ! -e "$app/Contents/Resources/runtime/llama" ]]
[[ -f "$app/Contents/Resources/licenses/llama.cpp-LICENSE" ]]
for notice in GEMMA_TERMS.md GEMMA_PROHIBITED_USE_POLICY.md NOTICE-Gemma.txt multilingual-e5-small-MIT.txt; do
  [[ -s "$app/Contents/Resources/licenses/$notice" ]]
done
[[ -s "$app/Contents/Resources/agent/production-dependencies.json" ]]
for unwanted in @electric-sql @testing-library eslint jsdom prettier react react-dom tsx typescript vite vitest; do
  [[ ! -e "$app/Contents/Resources/agent/node_modules/$unwanted" ]]
done
"$app/Contents/Resources/runtime/node" --version >/dev/null
(
  cd "$app/Contents/Resources/agent"
  ../runtime/node --input-type=module -e \
    "await import('fastify'); await import('@jsquash/webp/encode.js'); await import('@video-compressor/shared'); await import('./dist/media-actions/image-converter.js');"
)
print "Wishly Dev identity, isolation, slim dependencies, signature, and runtimes verified."
