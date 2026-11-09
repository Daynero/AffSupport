#!/bin/zsh
set -euo pipefail
# Validate before any builds, admission, cleanup or listener changes.
arch=$(node scripts/lib/macos-target.mjs arch dev "$@")
macho=$(node scripts/lib/macos-target.mjs macho dev "$@")
swift_target=$(node scripts/lib/macos-target.mjs swift dev "$@")
target_root=$(node scripts/lib/macos-target.mjs root dev "$@")

root="$target_root"
app="$root/Soty Dev.app"
source_app="${DEV_RUNTIME_SOURCE_APP:-$(node scripts/lib/macos-target.mjs app production --arch="$arch")}"
# Bootstrap the first target without requiring a prior production .app.
if [[ -z "${DEV_RUNTIME_SOURCE_APP:-}" && ! -d "$source_app" && -f "$PWD/release/inputs/$arch/approved-inputs.json" ]]; then
  source_app="$PWD/release/inputs/$arch"
fi

# The shared package is built first because everything below reads dev's
# identity out of it. Those slots — port, app name, bundle id, support
# directory, lock file — are never retyped here: a second spelling of a lock
# name is how two builds end up fighting over one.
npm run build -w @video-compressor/shared
app_name=$(node scripts/environment-meta.mjs dev app-name)
port="${DEV_AGENT_PORT:-$(node scripts/environment-meta.mjs dev agent-port)}"
instance_lock_name=$(node scripts/environment-meta.mjs dev instance-lock-name)
support_directory_name=$(node scripts/environment-meta.mjs dev support-directory-name)
bundle_id=$(node scripts/environment-meta.mjs dev bundle-id)

[[ "$port" == <1024-65535> ]] || { print -u2 "DEV_AGENT_PORT must be between 1024 and 65535."; exit 1; }
[[ -x "$source_app/Contents/Resources/runtime/node" ]] || {
  print -u2 "No verified packaged runtime found at $source_app. Build production locally once or set DEV_RUNTIME_SOURCE_APP."
  exit 1
}
[[ -x "$source_app/Contents/Resources/runtime/bin/whisper-cli" ]] || {
  print -u2 "The verified source runtime does not include whisper-cli."
  exit 1
}
[[ -s "$source_app/Contents/Resources/runtime/models/ggml-silero-v5.1.2.bin" ]] || {
  print -u2 "The verified source runtime does not include the Silero VAD model."
  exit 1
}

if [[ -f "$source_app/approved-inputs.json" ]]; then
  node scripts/stage-macos-inputs.mjs --verify="$source_app" --arch="$arch"
else
  node scripts/verify-macos-payload.mjs "$source_app" --arch="$arch"
fi

if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  print -u2 "The target environment is running on port $port. Finish its work and quit it before rebuilding; packaging never stops another app."
  exit 1
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
archive_name="Soty-Dev-$version-macOS-$arch.zip"

VITE_AGENT_URL="http://127.0.0.1:$port" \
VITE_ANALYTICS_ENABLED=false \
VITE_LOCAL_DEV_AUTH=true \
VITE_WEB_BUILD_ID="$build_id" \
  npm run build -w @video-compressor/web
npm run build -w @video-compressor/agent

mkdir -p "$root"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/runtime/bin" "$app/Contents/Resources/runtime/models" "$app/Contents/Resources/agent"
node scripts/render-launcher.mjs packaging/Launcher.swift "$root/Launcher.generated.swift" \
  "AGENT_PORT=$port" \
  "APP_NAME=$app_name" \
  "INSTANCE_LOCK_NAME=$instance_lock_name" \
  "SUPPORT_DIRECTORY_NAME=$support_directory_name" \
  "PUBLIC_SITE_ORIGIN=http://127.0.0.1:$port" \
  "APP_VERSION=$version" \
  "BUILD_NUMBER=$build_number" \
  "BUILD_ID=$build_id" \
  "API_VERSION=$api_version" \
  "RELEASE_CHANNEL=development" \
  "SOURCE_REVISION=$source_revision" \
  "AGENT_ENTITLEMENT_PUBLIC_KEY="
swiftc "$root/Launcher.generated.swift" \
  -o "$app/Contents/MacOS/SotyDevAgent" \
  -target "$swift_target" \
  -framework AppKit \
  -framework FinderSync

cp "$source_app/Contents/Resources/runtime/node" "$app/Contents/Resources/runtime/node"
codesign --remove-signature "$app/Contents/Resources/runtime/node" 2>/dev/null || true
/usr/bin/strip -x "$app/Contents/Resources/runtime/node"
cp "$source_app/Contents/Resources/runtime/bin/ffmpeg" "$app/Contents/Resources/runtime/bin/ffmpeg"
cp "$source_app/Contents/Resources/runtime/bin/ffprobe" "$app/Contents/Resources/runtime/bin/ffprobe"
cp "$source_app/Contents/Resources/runtime/bin/whisper-cli" "$app/Contents/Resources/runtime/bin/whisper-cli"
cp "$source_app/Contents/Resources/runtime/models/ggml-silero-v5.1.2.bin" "$app/Contents/Resources/runtime/models/"
if [[ -f "$source_app/approved-inputs.json" ]]; then
  cp "$source_app/approved-inputs.json" "$app/Contents/Resources/runtime-inputs.json"
fi
node scripts/stage-agent-runtime.mjs "$app/Contents/Resources/agent" --arch="$arch"
mkdir -p "$app/Contents/Resources/web" "$app/Contents/Resources/licenses/sources"
cp -R apps/web/dist "$app/Contents/Resources/web/dist"
cp -R "$source_app/Contents/Resources/licenses/." "$app/Contents/Resources/licenses/"
cp packaging/Info.plist "$app/Contents/Info.plist"
cp THIRD_PARTY_NOTICES.md "$app/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable SotyDevAgent" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $app_name" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Soty Dev" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :NSServices:0:NSMenuItem:default Soty Dev Finder Action" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :NSServices:0:NSPortName Soty Dev" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $bundle_version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
zsh scripts/build-finder-extension.sh \
  "$app" \
  "$bundle_id.finder-extension" \
  "Soty Dev Finder" \
  "Soty Dev Finder Action" \
  "$bundle_version" \
  "$build_number" \
  "$root/FinderSync.generated.swift" \
  " — Soty Dev" \
  "$arch"
node scripts/dev-release-meta.mjs "$version" "$bundle_version" "$build_number" "$build_id" "$api_version" "$source_revision" "$archive_name" "$arch" > "$app/Contents/Resources/release.json"
node scripts/verify-macos-payload.mjs "$app" --arch="$arch"
zsh scripts/make-icns.sh assets/AppIcon.png "$app/Contents/Resources/AppIcon.icns"
xattr -cr "$app"
# 048: the dev build is signed the way production is, through the chain, ad-hoc.
SOTY_SIGNING_IDENTITY=- SOTY_SKIP_NOTARIZATION=1 zsh scripts/sign-mac-app.sh "$app" > "$root/signing.json"
archive="$root/$archive_name"
rm -f "$root"/Soty-Dev-*-macOS-$arch.zip(N) "$root"/Soty-Dev-*-macOS-$arch.zip.sha256(N)
ditto -c -k --keepParent "$app" "$archive"
(cd "$root"; shasum -a 256 "${archive:t}" > "${archive:t}.sha256")
print "Built $archive"
