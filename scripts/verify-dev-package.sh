#!/bin/zsh
set -euo pipefail

app="$PWD/release/dev/Wishly Dev.app"
[[ -d "$app" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == "com.wishly.dev" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$app/Contents/Info.plist")" == "Wishly Dev" ]]
grep -q '"channel": "development"' "$app/Contents/Resources/release.json"
grep -q 'private let agentPort = 43130' "$PWD/release/dev/Launcher.generated.swift"
grep -q 'private let instanceLockName = "wishly-dev-agent.lock"' "$PWD/release/dev/Launcher.generated.swift"
grep -q 'private let supportDirectoryName = "Wishly Dev"' "$PWD/release/dev/Launcher.generated.swift"
grep -q 'VITE_ANALYTICS_ENABLED=false' scripts/package-dev-mac.sh
grep -q 'VITE_LOCAL_DEV_AUTH=true' scripts/package-dev-mac.sh
codesign --verify --deep --strict "$app"
for binary in "$app/Contents/MacOS/WishlyAgent" "$app/Contents/Resources/runtime/node" "$app/Contents/Resources/runtime/bin/ffmpeg" "$app/Contents/Resources/runtime/bin/ffprobe" "$app/Contents/Resources/runtime/bin/whisper-cli"; do
  file "$binary" | grep -q arm64
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
    "await import('fastify'); await import('@jsquash/webp/encode.js'); await import('@video-compressor/shared');"
)
print "Wishly Dev identity, isolation, slim dependencies, signature, and runtimes verified."
