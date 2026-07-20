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
for binary in "$app/Contents/MacOS/WishlyAgent" "$app/Contents/Resources/runtime/node" "$app/Contents/Resources/runtime/bin/ffmpeg" "$app/Contents/Resources/runtime/bin/ffprobe"; do
  file "$binary" | grep -q arm64
done
print "Wishly Dev identity, isolation, analytics disablement, signature, and runtimes verified."
