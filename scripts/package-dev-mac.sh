#!/bin/zsh
set -euo pipefail

root="$PWD/release/dev"
app="$root/Wishly Dev.app"
source_app="${DEV_RUNTIME_SOURCE_APP:-$PWD/release/Wishly Agent.app}"
port="${DEV_AGENT_PORT:-43130}"

[[ "$port" == <1024-65535> ]] || { print -u2 "DEV_AGENT_PORT must be between 1024 and 65535."; exit 1; }
[[ -x "$source_app/Contents/Resources/runtime/node" ]] || {
  print -u2 "No verified packaged runtime found at $source_app. Build production locally once or set DEV_RUNTIME_SOURCE_APP."
  exit 1
}

if listener=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); then
  health=$(/usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$port/health" 2>/dev/null || true)
  print -r -- "$health" | grep -q '"busy":false' || {
    print -u2 "Wishly Dev is using port $port and may be busy. Finish its work and quit it before rebuilding."
    exit 1
  }
  /usr/bin/osascript -e 'tell application id "com.wishly.dev" to quit' >/dev/null 2>&1 || kill $listener 2>/dev/null || true
  for _ in {1..40}; do lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep .1; done
  lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && { print -u2 "Wishly Dev did not quit cleanly."; exit 1; }
fi

base_version=$(node scripts/release-meta.mjs product-version)
bundle_version=$(node scripts/release-meta.mjs bundle-version)
api_version=$(node scripts/release-meta.mjs api-version)
source_revision=$(git rev-parse HEAD)
short_revision=${source_revision[1,8]}
dirty=""; git diff --quiet && git diff --cached --quiet || dirty=".dirty"
stamp=$(date -u +%Y%m%d%H%M%S)
version="$base_version-dev.$short_revision$dirty.$stamp"
build_number=$(date -u +%s)
build_id="$version+$build_number"
archive_name="Wishly-Dev-$version-macOS-arm64.zip"

npm run build -w @video-compressor/shared
VITE_AGENT_URL="http://127.0.0.1:$port" \
VITE_ANALYTICS_ENABLED=false \
VITE_LOCAL_DEV_AUTH=true \
VITE_WEB_BUILD_ID="$build_id" \
  npm run build -w @video-compressor/web
npm run build -w @video-compressor/agent

mkdir -p "$root"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/runtime/bin" "$app/Contents/Resources/agent"
node scripts/render-launcher.mjs packaging/Launcher.swift "$root/Launcher.generated.swift" \
  "AGENT_PORT=$port" \
  "APP_NAME=Wishly Dev" \
  "INSTANCE_LOCK_NAME=wishly-dev-agent.lock" \
  "SUPPORT_DIRECTORY_NAME=Wishly Dev" \
  "PUBLIC_SITE_ORIGIN=http://127.0.0.1:$port" \
  "APP_VERSION=$version" \
  "BUILD_NUMBER=$build_number" \
  "BUILD_ID=$build_id" \
  "API_VERSION=$api_version" \
  "RELEASE_CHANNEL=development" \
  "SOURCE_REVISION=$source_revision"
swiftc "$root/Launcher.generated.swift" -o "$app/Contents/MacOS/WishlyAgent" -framework AppKit

cp "$source_app/Contents/Resources/runtime/node" "$app/Contents/Resources/runtime/node"
cp "$source_app/Contents/Resources/runtime/bin/ffmpeg" "$app/Contents/Resources/runtime/bin/ffmpeg"
cp "$source_app/Contents/Resources/runtime/bin/ffprobe" "$app/Contents/Resources/runtime/bin/ffprobe"
cp -R apps/agent/dist apps/agent/package.json node_modules "$app/Contents/Resources/agent/"
rm -rf "$app/Contents/Resources/agent/node_modules/@video-compressor"
mkdir -p "$app/Contents/Resources/agent/node_modules/@video-compressor/shared"
cp -R packages/shared/dist packages/shared/package.json "$app/Contents/Resources/agent/node_modules/@video-compressor/shared/"
rm -rf "$app/Contents/Resources/agent/node_modules/ffmpeg-static" "$app/Contents/Resources/agent/node_modules/@derhuerst/ffprobe-static"
mkdir -p "$app/Contents/Resources/web" "$app/Contents/Resources/licenses/sources"
cp -R apps/web/dist "$app/Contents/Resources/web/dist"
cp "$source_app/Contents/Resources/licenses/sources/"* "$app/Contents/Resources/licenses/sources/"
cp packaging/Info.plist "$app/Contents/Info.plist"
cp THIRD_PARTY_NOTICES.md "$app/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier com.wishly.dev" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName Wishly Dev" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Wishly Dev" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $bundle_version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
node scripts/dev-release-meta.mjs "$version" "$bundle_version" "$build_number" "$build_id" "$api_version" "$source_revision" "$archive_name" > "$app/Contents/Resources/release.json"
zsh scripts/make-icns.sh assets/AppIcon.png "$app/Contents/Resources/AppIcon.icns"
xattr -cr "$app"
codesign --force --deep --sign - "$app"
archive="$root/$archive_name"
rm -f "$root"/Wishly-Dev-*-macOS-arm64.zip(N) "$root"/Wishly-Dev-*-macOS-arm64.zip.sha256(N)
ditto -c -k --keepParent "$app" "$archive"
(cd "$root"; shasum -a 256 "${archive:t}" > "${archive:t}.sha256")
print "Built $archive"
