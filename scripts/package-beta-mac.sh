#!/bin/zsh
set -euo pipefail

# Packaged beta build.
#
# Modelled on package-dev-mac.sh, with three deliberate divergences that are the
# whole reason beta exists as a separate package:
#
#   1. VITE_LOCAL_DEV_AUTH=false. Soty Dev fakes a hardcoded user and bypasses
#      Supabase entirely; a beta build that did the same could never verify
#      sign-in, sessions, profiles, or account status.
#   2. A real beta entitlement key, so the gate is genuinely enforced and a
#      production-issued token is cryptographically invalid here.
#   3. VITE_APP_ENVIRONMENT=beta, which turns on the indicator, suppresses
#      telemetry structurally, permits loopback origins, and keeps the build
#      away from the production update channel.
#
# It must never touch production release identity. That is asserted before and
# after the build rather than trusted.

root="$PWD/release/beta"
app="$root/Soty Beta.app"
source_app="${BETA_RUNTIME_SOURCE_APP:-$PWD/release/Soty.app}"

# Files that carry production release identity. The constitution requires dev
# and test builds to leave versions, the stable manifest, git tags, Supabase
# migrations, and Cloudflare alone; this is that rule made executable.
protected=(
  packages/shared/src/release.ts
  apps/web/public/.well-known/wishly/stable.json
  config/production.env
  packaging
  supabase/migrations
)

protected_state() {
  git status --porcelain -- "${protected[@]}" 2>/dev/null || true
}
before_state=$(protected_state)
before_tags=$(git tag --list | sort)

# The shared package is built first because everything below reads beta's
# identity out of it. Those slots — port, app name, bundle id, support
# directory, lock file — are never retyped here: beta's whole purpose is that
# it cannot collide with production, and a second spelling of any of them is
# exactly how it would.
npm run build -w @video-compressor/shared
app_name=$(node scripts/environment-meta.mjs beta app-name)
port="${BETA_AGENT_PORT:-$(node scripts/environment-meta.mjs beta agent-port)}"
web_port="${BETA_WEB_PORT:-$(node scripts/environment-meta.mjs beta web-port)}"
instance_lock_name=$(node scripts/environment-meta.mjs beta instance-lock-name)
support_directory_name=$(node scripts/environment-meta.mjs beta support-directory-name)
bundle_id=$(node scripts/environment-meta.mjs beta bundle-id)

[[ "$port" == <1024-65535> ]] || { print -u2 "BETA_AGENT_PORT must be between 1024 and 65535."; exit 1; }
[[ -f .env.beta ]] || { print -u2 "No .env.beta found. Run: cp .env.beta.example .env.beta"; exit 1; }

beta_key=$(grep -E '^AGENT_ENTITLEMENT_PUBLIC_KEY=' .env.beta | head -1 | cut -d= -f2-)
production_key=$(grep -E '^AGENT_ENTITLEMENT_PUBLIC_KEY=' config/production.env | head -1 | cut -d= -f2-)
[[ -n "$beta_key" ]] || {
  print -u2 "AGENT_ENTITLEMENT_PUBLIC_KEY is empty in .env.beta. The entitlement gate would not be enforced."
  print -u2 "Run: node scripts/generate-signing-keys.mjs --beta"
  exit 1
}
[[ "$beta_key" != "$production_key" ]] || {
  print -u2 "The beta entitlement key is the production key. A beta token must never be valid in production."
  exit 1
}

# Vite loads apps/web/.env.production for a production build, not the
# repository-root beta profile. Pass the beta's public local-stack values
# explicitly or a packaged beta silently embeds production Supabase settings.
beta_supabase_url=$(grep -E '^VITE_SUPABASE_URL=' .env.beta | head -1 | cut -d= -f2-)
beta_supabase_publishable_key=$(grep -E '^VITE_SUPABASE_PUBLISHABLE_KEY=' .env.beta | head -1 | cut -d= -f2-)
beta_direct_add_mode=$(grep -E '^VITE_TEAM_DIRECT_ADD_MODE=' .env.beta | head -1 | cut -d= -f2-)
[[ "$beta_supabase_url" == http://127.0.0.1:* ]] || {
  print -u2 "VITE_SUPABASE_URL in .env.beta must point to the local stack."
  exit 1
}
[[ -n "$beta_supabase_publishable_key" ]] || {
  print -u2 "VITE_SUPABASE_PUBLISHABLE_KEY is empty in .env.beta."
  exit 1
}

[[ -x "$source_app/Contents/Resources/runtime/node" ]] || {
  print -u2 "No verified packaged runtime at $source_app. Build production locally once, or set BETA_RUNTIME_SOURCE_APP."
  exit 1
}

if listener=$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); then
  health=$(/usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$port/health" 2>/dev/null || true)
  print -r -- "$health" | grep -q '"busy":false' || {
    print -u2 "Soty Beta is using port $port and may be busy. Finish its work and quit it before rebuilding."
    exit 1
  }
  /usr/bin/osascript -e "tell application id \"$bundle_id\" to quit" >/dev/null 2>&1 || kill $listener 2>/dev/null || true
  for _ in {1..40}; do lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep .1; done
  lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && { print -u2 "Soty Beta did not quit cleanly."; exit 1; }
fi

base_version=$(node scripts/release-meta.mjs product-version)
bundle_version=$(node scripts/release-meta.mjs bundle-version)
api_version=$(node scripts/release-meta.mjs api-version)
source_revision=$(git rev-parse HEAD)
short_revision=${source_revision[1,8]}
dirty=""; git diff --quiet && git diff --cached --quiet || dirty=".dirty"
stamp=$(date -u +%Y%m%d%H%M%S)
# Derived from PRODUCT_VERSION, never forked from it: release identity has one
# source of truth and beta is a suffix on it.
version="$base_version-beta.$short_revision$dirty.$stamp"
build_number=$(date -u +%s)
build_id="$version+$build_number"
archive_name="Soty-Beta-$version-macOS-arm64.zip"

VITE_APP_ENVIRONMENT=beta \
VITE_AGENT_URL="http://127.0.0.1:$port" \
VITE_SUPABASE_URL="$beta_supabase_url" \
VITE_SUPABASE_PUBLISHABLE_KEY="$beta_supabase_publishable_key" \
VITE_SITE_URL="http://127.0.0.1:$port" \
VITE_ANALYTICS_ENABLED=false \
VITE_LOCAL_DEV_AUTH=false \
VITE_TEAM_DIRECT_ADD_MODE="$beta_direct_add_mode" \
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
  "RELEASE_CHANNEL=beta" \
  "SOURCE_REVISION=$source_revision" \
  "AGENT_ENTITLEMENT_PUBLIC_KEY=$beta_key"
swiftc "$root/Launcher.generated.swift" \
  -o "$app/Contents/MacOS/SotyBetaAgent" \
  -target arm64-apple-macos13.0 \
  -framework AppKit \
  -framework FinderSync

cp "$source_app/Contents/Resources/runtime/node" "$app/Contents/Resources/runtime/node"
codesign --remove-signature "$app/Contents/Resources/runtime/node" 2>/dev/null || true
/usr/bin/strip -x "$app/Contents/Resources/runtime/node"
codesign --force --sign - "$app/Contents/Resources/runtime/node"
for binary in ffmpeg ffprobe whisper-cli; do
  cp "$source_app/Contents/Resources/runtime/bin/$binary" "$app/Contents/Resources/runtime/bin/$binary"
done
cp "$source_app/Contents/Resources/runtime/models/ggml-silero-v5.1.2.bin" "$app/Contents/Resources/runtime/models/"
node scripts/stage-agent-runtime.mjs "$app/Contents/Resources/agent"
mkdir -p "$app/Contents/Resources/web" "$app/Contents/Resources/licenses/sources"
cp -R apps/web/dist "$app/Contents/Resources/web/dist"
cp "$source_app/Contents/Resources/licenses/sources/"* "$app/Contents/Resources/licenses/sources/"
for notice in llama.cpp-LICENSE GEMMA_TERMS.md GEMMA_PROHIBITED_USE_POLICY.md NOTICE-Gemma.txt multilingual-e5-small-MIT.txt; do
  cp "packaging/licenses/$notice" "$app/Contents/Resources/licenses/"
done
cp packaging/Info.plist "$app/Contents/Info.plist"
cp THIRD_PARTY_NOTICES.md "$app/Contents/Resources/"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_id" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable SotyBetaAgent" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $app_name" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Soty Beta" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :NSServices:0:NSMenuItem:default Soty Beta Finder Action" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :NSServices:0:NSPortName Soty Beta" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $bundle_version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$app/Contents/Info.plist"
zsh scripts/build-finder-extension.sh \
  "$app" \
  "$bundle_id.finder-extension" \
  "Soty Beta Finder" \
  "Soty Beta Finder Action" \
  "$bundle_version" \
  "$build_number" \
  "$root/FinderSync.generated.swift" \
  " — Soty Beta"
node scripts/dev-release-meta.mjs "$version" "$bundle_version" "$build_number" "$build_id" "$api_version" "$source_revision" "$archive_name" > "$app/Contents/Resources/release.json"
/usr/bin/sed -i '' 's/"channel": "development"/"channel": "beta"/' "$app/Contents/Resources/release.json"
zsh scripts/make-icns.sh assets/AppIcon.png "$app/Contents/Resources/AppIcon.icns"
xattr -cr "$app"
# Ad-hoc signature only. The release-manifest key signs stable.json and nothing
# else; beta never writes that file, so a beta artifact is not merely unsigned
# by it — it is unreachable by it.
codesign --force --deep --preserve-metadata=entitlements --sign - "$app"
archive="$root/$archive_name"
rm -f "$root"/Soty-Beta-*-macOS-arm64.zip(N) "$root"/Soty-Beta-*-macOS-arm64.zip.sha256(N)
ditto -c -k --keepParent "$app" "$archive"
(cd "$root"; shasum -a 256 "${archive:t}" > "${archive:t}.sha256")

after_state=$(protected_state)
after_tags=$(git tag --list | sort)
[[ "$before_state" == "$after_state" ]] || {
  print -u2 "Beta packaging modified a production-identity file. Refusing to continue:"
  print -u2 "$after_state"
  exit 1
}
[[ "$before_tags" == "$after_tags" ]] || { print -u2 "Beta packaging created or removed a git tag."; exit 1; }

print "Built $archive"
print "Beta build $build_id from $short_revision$dirty — production release identity untouched."
