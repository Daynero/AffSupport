#!/bin/zsh
set -euo pipefail
: "${PUBLIC_SITE_ORIGIN:?Set PUBLIC_SITE_ORIGIN to the final HTTPS Cloudflare Pages origin}"
: "${FFMPEG_BINARY:?Set FFMPEG_BINARY to an approved standalone arm64 FFmpeg binary}"
: "${FFPROBE_BINARY:?Set FFPROBE_BINARY to its matching FFprobe binary}"
: "${FFMPEG_SOURCE_ARCHIVE:?Set FFMPEG_SOURCE_ARCHIVE to the matching FFmpeg source archive}"
: "${X264_SOURCE_ARCHIVE:?Set X264_SOURCE_ARCHIVE to the matching x264 source archive}"
: "${WHISPER_BINARY:?Set WHISPER_BINARY to an approved portable (statically linked) arm64 whisper-cli}"
# WHISPER_MODEL is OPTIONAL: leave it unset to ship a small installer and let the
# app download large-v3 on first use (into Application Support). Set it to a local
# ggml-large-v3.bin to bundle the model for a fully offline DMG.
WHISPER_MODEL="${WHISPER_MODEL:-}"
: "${WHISPER_VAD_MODEL:?Set WHISPER_VAD_MODEL to the silero VAD ggml model (ggml-silero-v5.1.2.bin) — required to skip silence and avoid hallucinated text}"
[[ "$PUBLIC_SITE_ORIGIN" == https://* ]] || { print -u2 "PUBLIC_SITE_ORIGIN must use HTTPS"; exit 1; }
# Public half of the entitlement token keypair (config/keys, generate-signing-keys.mjs).
# Packaged production agents refuse tool operations without a server-issued token.
AGENT_ENTITLEMENT_PUBLIC_KEY="${AGENT_ENTITLEMENT_PUBLIC_KEY:-$(grep '^AGENT_ENTITLEMENT_PUBLIC_KEY=' config/production.env | cut -d= -f2-)}"
[[ -n "$AGENT_ENTITLEMENT_PUBLIC_KEY" ]] || { print -u2 "AGENT_ENTITLEMENT_PUBLIC_KEY is missing; set it in config/production.env or the environment"; exit 1; }
node_binary="${NODE_BINARY:-$(command -v node)}"; [[ -x "$node_binary" ]] || { print -u2 "No node binary found; set NODE_BINARY to a portable arm64 Node.js"; exit 1; }
output_app="$PWD/release/Soty.app"
for input in "$node_binary" "$FFMPEG_BINARY" "$FFPROBE_BINARY" "$FFMPEG_SOURCE_ARCHIVE" "$X264_SOURCE_ARCHIVE" "$WHISPER_BINARY" "$WHISPER_VAD_MODEL" ${WHISPER_MODEL:+"$WHISPER_MODEL"}; do
  case "${input:A}" in
    "${output_app:A}"/*) print -u2 "Package input must not be inside the output app: $input"; exit 1 ;;
  esac
done
for binary in "$node_binary" "$FFMPEG_BINARY" "$FFPROBE_BINARY" "$WHISPER_BINARY"; do file "$binary" | grep -q 'arm64' || { print -u2 "$binary is not arm64"; exit 1; }; otool -L "$binary" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)' && { print -u2 "$binary has non-system dynamic dependencies (Homebrew builds are not portable; use a statically linked arm64 build)"; exit 1; } || true; done
product_version=$(node scripts/release-meta.mjs product-version)
bundle_version=$(node scripts/release-meta.mjs bundle-version)
build_number=$(node scripts/release-meta.mjs build-number)
build_id=$(node scripts/release-meta.mjs build-id)
api_version=$(node scripts/release-meta.mjs api-version)
release_channel=$(node scripts/release-meta.mjs release-channel)
dmg_name=$(node scripts/release-meta.mjs artifact-name)
source_revision=$(git rev-parse HEAD)
root="$PWD/release"; app="$root/Soty.app"; archive="$root/${dmg_name%.dmg}.zip"
mkdir -p "$root"
[[ ! -e "$archive" ]] || { print -u2 "$archive already exists. Published build identities are immutable; bump PRODUCT_VERSION and BUILD_NUMBER."; exit 1; }
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/runtime/bin" "$app/Contents/Resources/runtime/models" "$app/Contents/Resources/agent"
node scripts/render-launcher.mjs packaging/Launcher.swift "$root/Launcher.generated.swift" \
  "AGENT_PORT=43120" \
  "APP_NAME=Soty" \
  "INSTANCE_LOCK_NAME=local-video-compressor-agent.lock" \
  "SUPPORT_DIRECTORY_NAME=Soty" \
  "PUBLIC_SITE_ORIGIN=$PUBLIC_SITE_ORIGIN" \
  "APP_VERSION=$product_version" \
  "BUILD_NUMBER=$build_number" \
  "BUILD_ID=$build_id" \
  "API_VERSION=$api_version" \
  "RELEASE_CHANNEL=$release_channel" \
  "SOURCE_REVISION=$source_revision" \
  "AGENT_ENTITLEMENT_PUBLIC_KEY=$AGENT_ENTITLEMENT_PUBLIC_KEY"
swiftc "$root/Launcher.generated.swift" \
  -o "$app/Contents/MacOS/SotyAgent" \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework FinderSync
cp "$node_binary" "$app/Contents/Resources/runtime/node"
codesign --remove-signature "$app/Contents/Resources/runtime/node" 2>/dev/null || true
/usr/bin/strip -x "$app/Contents/Resources/runtime/node"
codesign --force --sign - "$app/Contents/Resources/runtime/node"
cp "$FFMPEG_BINARY" "$app/Contents/Resources/runtime/bin/ffmpeg"; cp "$FFPROBE_BINARY" "$app/Contents/Resources/runtime/bin/ffprobe"
cp "$WHISPER_BINARY" "$app/Contents/Resources/runtime/bin/whisper-cli"; chmod +x "$app/Contents/Resources/runtime/bin/whisper-cli"; cp "$WHISPER_VAD_MODEL" "$app/Contents/Resources/runtime/models/ggml-silero-v5.1.2.bin"
[[ -n "$WHISPER_MODEL" ]] && cp "$WHISPER_MODEL" "$app/Contents/Resources/runtime/models/ggml-large-v3.bin" || print "WHISPER_MODEL not set — large-v3 will be downloaded on first use"
node scripts/stage-agent-runtime.mjs "$app/Contents/Resources/agent"
mkdir -p "$app/Contents/Resources/web" "$app/Contents/Resources/licenses/sources"; cp -R apps/web/dist "$app/Contents/Resources/web/dist"
cp "$FFMPEG_SOURCE_ARCHIVE" "$app/Contents/Resources/licenses/sources/"; cp "$X264_SOURCE_ARCHIVE" "$app/Contents/Resources/licenses/sources/"
cp packaging/licenses/llama.cpp-LICENSE "$app/Contents/Resources/licenses/"
cp packaging/licenses/GEMMA_TERMS.md "$app/Contents/Resources/licenses/"
cp packaging/licenses/GEMMA_PROHIBITED_USE_POLICY.md "$app/Contents/Resources/licenses/"
cp packaging/licenses/NOTICE-Gemma.txt "$app/Contents/Resources/licenses/"
cp packaging/licenses/multilingual-e5-small-MIT.txt "$app/Contents/Resources/licenses/"
cp packaging/Info.plist "$app/Contents/Info.plist"; cp THIRD_PARTY_NOTICES.md "$app/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $bundle_version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
zsh scripts/build-finder-extension.sh \
  "$app" \
  "local.video.compressor.test.finder-extension" \
  "Soty Finder" \
  "Soty Finder Action" \
  "$bundle_version" \
  "$build_number" \
  "$root/FinderSync.generated.swift" \
  ""
node scripts/release-meta.mjs --json "$source_revision" > "$app/Contents/Resources/release.json"
zsh scripts/make-icns.sh assets/AppIcon.png "$app/Contents/Resources/AppIcon.icns"
codesign --force --deep --preserve-metadata=entitlements --sign - "$app"; ditto -c -k --keepParent "$app" "$archive"; (cd "$root"; shasum -a 256 "${archive:t}" > "${archive:t}.sha256")
