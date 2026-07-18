#!/bin/zsh
set -euo pipefail
: "${PUBLIC_SITE_ORIGIN:?Set PUBLIC_SITE_ORIGIN to the final HTTPS Cloudflare Pages origin}"
: "${FFMPEG_BINARY:?Set FFMPEG_BINARY to an approved standalone arm64 FFmpeg binary}"
: "${FFPROBE_BINARY:?Set FFPROBE_BINARY to its matching FFprobe binary}"
: "${FFMPEG_SOURCE_ARCHIVE:?Set FFMPEG_SOURCE_ARCHIVE to the matching FFmpeg source archive}"
: "${X264_SOURCE_ARCHIVE:?Set X264_SOURCE_ARCHIVE to the matching x264 source archive}"
[[ "$PUBLIC_SITE_ORIGIN" == https://* ]] || { print -u2 "PUBLIC_SITE_ORIGIN must use HTTPS"; exit 1; }
node_binary="${NODE_BINARY:-$(command -v node)}"; [[ -x "$node_binary" ]] || { print -u2 "No node binary found; set NODE_BINARY to a portable arm64 Node.js"; exit 1; }
output_app="$PWD/release/Wishly Agent.app"
for input in "$node_binary" "$FFMPEG_BINARY" "$FFPROBE_BINARY" "$FFMPEG_SOURCE_ARCHIVE" "$X264_SOURCE_ARCHIVE"; do
  case "${input:A}" in
    "${output_app:A}"/*) print -u2 "Package input must not be inside the output app: $input"; exit 1 ;;
  esac
done
for binary in "$node_binary" "$FFMPEG_BINARY" "$FFPROBE_BINARY"; do file "$binary" | grep -q 'arm64' || { print -u2 "$binary is not arm64"; exit 1; }; otool -L "$binary" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)' && { print -u2 "$binary has non-system dynamic dependencies (Homebrew node is not portable; use an official Node.js build via NODE_BINARY)"; exit 1; } || true; done
product_version=$(node scripts/release-meta.mjs product-version)
bundle_version=$(node scripts/release-meta.mjs bundle-version)
build_number=$(node scripts/release-meta.mjs build-number)
build_id=$(node scripts/release-meta.mjs build-id)
api_version=$(node scripts/release-meta.mjs api-version)
release_channel=$(node scripts/release-meta.mjs release-channel)
dmg_name=$(node scripts/release-meta.mjs artifact-name)
source_revision=$(git rev-parse HEAD)
root="$PWD/release"; app="$root/Wishly Agent.app"; archive="$root/${dmg_name%.dmg}.zip"
mkdir -p "$root"
[[ ! -e "$archive" ]] || { print -u2 "$archive already exists. Published build identities are immutable; bump PRODUCT_VERSION and BUILD_NUMBER."; exit 1; }
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/runtime/bin" "$app/Contents/Resources/agent"
node scripts/render-launcher.mjs packaging/Launcher.swift "$root/Launcher.generated.swift" \
  "PUBLIC_SITE_ORIGIN=$PUBLIC_SITE_ORIGIN" \
  "APP_VERSION=$product_version" \
  "BUILD_NUMBER=$build_number" \
  "BUILD_ID=$build_id" \
  "API_VERSION=$api_version" \
  "RELEASE_CHANNEL=$release_channel" \
  "SOURCE_REVISION=$source_revision"
swiftc "$root/Launcher.generated.swift" -o "$app/Contents/MacOS/WishlyAgent" -framework AppKit
cp "$node_binary" "$app/Contents/Resources/runtime/node"; cp "$FFMPEG_BINARY" "$app/Contents/Resources/runtime/bin/ffmpeg"; cp "$FFPROBE_BINARY" "$app/Contents/Resources/runtime/bin/ffprobe"
cp -R apps/agent/dist apps/agent/package.json node_modules "$app/Contents/Resources/agent/"; rm -rf "$app/Contents/Resources/agent/node_modules/@video-compressor"; mkdir -p "$app/Contents/Resources/agent/node_modules/@video-compressor/shared"; cp -R packages/shared/dist packages/shared/package.json "$app/Contents/Resources/agent/node_modules/@video-compressor/shared/"
rm -rf "$app/Contents/Resources/agent/node_modules/ffmpeg-static" "$app/Contents/Resources/agent/node_modules/@derhuerst/ffprobe-static"
mkdir -p "$app/Contents/Resources/web" "$app/Contents/Resources/licenses/sources"; cp -R apps/web/dist "$app/Contents/Resources/web/dist"
cp "$FFMPEG_SOURCE_ARCHIVE" "$app/Contents/Resources/licenses/sources/"; cp "$X264_SOURCE_ARCHIVE" "$app/Contents/Resources/licenses/sources/"
cp packaging/Info.plist "$app/Contents/Info.plist"; cp THIRD_PARTY_NOTICES.md "$app/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $bundle_version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
node scripts/release-meta.mjs --json "$source_revision" > "$app/Contents/Resources/release.json"
zsh scripts/make-icns.sh assets/AppIcon.png "$app/Contents/Resources/AppIcon.icns"
codesign --force --deep --sign - "$app"; ditto -c -k --keepParent "$app" "$archive"; (cd "$root"; shasum -a 256 "${archive:t}" > "${archive:t}.sha256")
