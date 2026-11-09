#!/bin/zsh
set -euo pipefail
# Validate before any builds, admission, cleanup or listener changes.
arch=$(node scripts/lib/macos-target.mjs arch production "$@")
macho=$(node scripts/lib/macos-target.mjs macho production "$@")
swift_target=$(node scripts/lib/macos-target.mjs swift production "$@")
target_root=$(node scripts/lib/macos-target.mjs root production "$@")
source "$PWD/scripts/release-admission.zsh"
release_require_admission
: "${PUBLIC_SITE_ORIGIN:?Set PUBLIC_SITE_ORIGIN to the final HTTPS Cloudflare Pages origin}"
: "${FFMPEG_BINARY:?Set FFMPEG_BINARY to an approved standalone target-compatible FFmpeg binary}"
: "${FFPROBE_BINARY:?Set FFPROBE_BINARY to its matching FFprobe binary}"
: "${FFMPEG_SOURCE_ARCHIVE:?Set FFMPEG_SOURCE_ARCHIVE to the matching FFmpeg source archive}"
: "${X264_SOURCE_ARCHIVE:?Set X264_SOURCE_ARCHIVE to the matching x264 source archive}"
: "${WHISPER_BINARY:?Set WHISPER_BINARY to an approved portable (statically linked) target-compatible whisper-cli}"
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
node_binary="${NODE_BINARY:-$(command -v node)}"; [[ -x "$node_binary" ]] || { print -u2 "No node binary found; set NODE_BINARY to a portable target-compatible Node.js"; exit 1; }
if [[ -n "${MACOS_RUNTIME_INPUT_ROOT:-}" ]]; then
  NODE_BINARY="$node_binary" node scripts/stage-macos-inputs.mjs --verify="$MACOS_RUNTIME_INPUT_ROOT" --arch="$arch" --bind-env
fi
output_app="$target_root/Soty.app"
for input in "$node_binary" "$FFMPEG_BINARY" "$FFPROBE_BINARY" "$FFMPEG_SOURCE_ARCHIVE" "$X264_SOURCE_ARCHIVE" "$WHISPER_BINARY" "$WHISPER_VAD_MODEL" ${WHISPER_MODEL:+"$WHISPER_MODEL"}; do
  case "${input:A}" in
    "${output_app:A}"/*) print -u2 "Package input must not be inside the output app: $input"; exit 1 ;;
  esac
done
for binary in "$node_binary" "$FFMPEG_BINARY" "$FFPROBE_BINARY" "$WHISPER_BINARY"; do file "$binary" | grep -q "$macho" || { print -u2 "$binary does not include $macho"; exit 1; }; otool -L "$binary" | tail -n +2 | grep -Ev '^\s+(/usr/lib|/System/Library)' && { print -u2 "$binary has non-system dynamic dependencies (Homebrew builds are not portable; use a statically linked target build)"; exit 1; } || true; done
product_version=$(node scripts/release-meta.mjs product-version)
bundle_version=$(node scripts/release-meta.mjs bundle-version)
build_number=$(node scripts/release-meta.mjs build-number)
build_id=$(node scripts/release-meta.mjs build-id)
api_version=$(node scripts/release-meta.mjs api-version)
release_channel=$(node scripts/release-meta.mjs release-channel)
# Identity slots come from the shared environment profile, never retyped here:
# the bundle id, lock name, and support directory are what an installed copy is
# recognised by, and a second spelling of them is how two builds end up
# fighting over one lock file.
agent_port=$(node scripts/environment-meta.mjs production agent-port)
app_name=$(node scripts/environment-meta.mjs production app-name)
instance_lock_name=$(node scripts/environment-meta.mjs production instance-lock-name)
support_directory_name=$(node scripts/environment-meta.mjs production support-directory-name)
bundle_id=$(node scripts/environment-meta.mjs production bundle-id)
dmg_name=$(node scripts/release-meta.mjs "$([[ "$arch" == x64 ]] && print intel-artifact-name || print artifact-name)")
source_revision=$(git rev-parse HEAD)
root="$target_root"; app="$root/Soty.app"; archive="$root/${dmg_name%.dmg}.zip"
mkdir -p "$root"
[[ ! -e "$archive" ]] || { print -u2 "$archive already exists. Published build identities are immutable; bump PRODUCT_VERSION and BUILD_NUMBER."; exit 1; }
rm -rf "$app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/runtime/bin" "$app/Contents/Resources/runtime/models" "$app/Contents/Resources/agent"
node scripts/render-launcher.mjs packaging/Launcher.swift "$root/Launcher.generated.swift" \
  "AGENT_PORT=$agent_port" \
  "APP_NAME=$app_name" \
  "INSTANCE_LOCK_NAME=$instance_lock_name" \
  "SUPPORT_DIRECTORY_NAME=$support_directory_name" \
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
  -target "$swift_target" \
  -framework AppKit \
  -framework FinderSync
cp "$node_binary" "$app/Contents/Resources/runtime/node"
codesign --remove-signature "$app/Contents/Resources/runtime/node" 2>/dev/null || true
/usr/bin/strip -x "$app/Contents/Resources/runtime/node"
cp "$FFMPEG_BINARY" "$app/Contents/Resources/runtime/bin/ffmpeg"; cp "$FFPROBE_BINARY" "$app/Contents/Resources/runtime/bin/ffprobe"
cp "$WHISPER_BINARY" "$app/Contents/Resources/runtime/bin/whisper-cli"; chmod +x "$app/Contents/Resources/runtime/bin/whisper-cli"; cp "$WHISPER_VAD_MODEL" "$app/Contents/Resources/runtime/models/ggml-silero-v5.1.2.bin"
[[ -n "$WHISPER_MODEL" ]] && cp "$WHISPER_MODEL" "$app/Contents/Resources/runtime/models/ggml-large-v3.bin" || print "WHISPER_MODEL not set — large-v3 will be downloaded on first use"
node scripts/stage-agent-runtime.mjs "$app/Contents/Resources/agent" --arch="$arch"
mkdir -p "$app/Contents/Resources/web" "$app/Contents/Resources/licenses/sources"; cp -R apps/web/dist "$app/Contents/Resources/web/dist"
cp "$FFMPEG_SOURCE_ARCHIVE" "$app/Contents/Resources/licenses/sources/"; cp "$X264_SOURCE_ARCHIVE" "$app/Contents/Resources/licenses/sources/"
cp packaging/Info.plist "$app/Contents/Info.plist"; cp THIRD_PARTY_NOTICES.md "$app/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $bundle_version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
zsh scripts/build-finder-extension.sh \
  "$app" \
  "$bundle_id.finder-extension" \
  "Soty Finder" \
  "Soty Finder Action" \
  "$bundle_version" \
  "$build_number" \
  "$root/FinderSync.generated.swift" \
  "" \
  "$arch"
node scripts/release-meta.mjs --json "$source_revision" --arch="$arch" > "$app/Contents/Resources/release.json"
if [[ -n "${MACOS_RUNTIME_INPUT_ROOT:-}" ]]; then
  cp "$MACOS_RUNTIME_INPUT_ROOT/approved-inputs.json" "$app/Contents/Resources/runtime-inputs.json"
  cp -R "$MACOS_RUNTIME_INPUT_ROOT/Contents/Resources/licenses/." "$app/Contents/Resources/licenses/"
fi
node scripts/verify-macos-payload.mjs "$app" --arch="$arch"
zsh scripts/make-icns.sh assets/AppIcon.png "$app/Contents/Resources/AppIcon.icns"
# 048 (T010): sign through the chain — inside-out, hardened runtime, one measured
# entitlement profile per binary, and with a Developer ID a timestamp, notarization and
# a stapled ticket — after every file the resource seal covers (release.json,
# runtime-inputs.json, AppIcon.icns) is in place and before the archive, so the ZIP
# carries the signed bundle. An ad-hoc production package is the owner's explicit
# pre-048 choice; there is no silent fallback from Developer ID to ad-hoc.
if [[ "${SOTY_SIGNING_IDENTITY:--}" == "-" ]]; then
  [[ "${SOTY_MACOS_TRUST_POLICY:-}" == adhoc-pre-048 || "${SOTY_SKIP_NOTARIZATION:-}" == 1 ]] \
    || { print -u2 "SIGN_IDENTITY_REQUIRED: set SOTY_SIGNING_IDENTITY to the Developer ID Application identity, or explicitly SOTY_MACOS_TRUST_POLICY=adhoc-pre-048 to package ad-hoc as before 048"; exit 1; }
  export SOTY_SKIP_NOTARIZATION=1
fi
zsh scripts/sign-mac-app.sh "$app" > "$root/signing.json"
ditto -c -k --keepParent "$app" "$archive"; (cd "$root"; shasum -a 256 "${archive:t}" > "${archive:t}.sha256")
