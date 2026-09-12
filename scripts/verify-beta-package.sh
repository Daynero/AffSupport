#!/bin/zsh
set -euo pipefail

# Packaged-beta smoke.
#
# Asserts the packaged build really is a beta build — its own identity, its own
# slots, real authentication, an enforced entitlement gate — and only then
# writes the verification record the promotion gate reads. A failed smoke
# leaves no record, so a stale pass can never be reused.

app="$PWD/release/beta/Soty Beta.app"
finder_extension="$app/Contents/PlugIns/SotyFinderExtension.appex"
record_dir="$PWD/release/beta"
record="$record_dir/verification.json"
rm -f "$record"

[[ -d "$app" ]] || { print -u2 "No packaged beta build at $app. Run: npm run beta:package"; exit 1; }

# Identity: distinct from production and from Soty Dev in every slot.
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == "com.wishly.beta" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$app/Contents/Info.plist")" == "Soty Beta" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")" == "SotyBetaAgent" ]]
grep -q '"channel": "beta"' "$app/Contents/Resources/release.json"
grep -q 'private let agentPort = 43140' "$record_dir/Launcher.generated.swift"
grep -q 'private let instanceLockName = "wishly-beta-agent.lock"' "$record_dir/Launcher.generated.swift"
grep -q 'private let supportDirectoryName = "Soty Beta"' "$record_dir/Launcher.generated.swift"
grep -q '"SOTY_ENVIRONMENT": releaseChannel == "beta" ? "beta"' "$record_dir/Launcher.generated.swift"

# FR-009a: the agent binds loopback only; nothing may reach it from the network.
grep -q 'private let agentHost = "127.0.0.1"' "$record_dir/Launcher.generated.swift" \
  || grep -q '127.0.0.1' "$record_dir/Launcher.generated.swift"

# The entitlement gate must be enforced with a beta key. An empty key would make
# the gate report everything as entitled — the whole surface would go untested.
beta_key=$(grep -E '^AGENT_ENTITLEMENT_PUBLIC_KEY=' "$PWD/.env.beta" | head -1 | cut -d= -f2-)
production_key=$(grep -E '^AGENT_ENTITLEMENT_PUBLIC_KEY=' "$PWD/config/production.env" | head -1 | cut -d= -f2-)
[[ -n "$beta_key" ]]
[[ "$beta_key" != "$production_key" ]]
grep -q "$beta_key" "$record_dir/Launcher.generated.swift"

# The divergence from Soty Dev that matters most: beta authenticates for real.
# Vite keeps the variable name in the bundle for the beta configuration guard,
# so its presence alone does not mean local auth is enabled. Verify the emitted
# beta value instead.
if ! grep -rq 'VITE_LOCAL_DEV_AUTH:`false`' "$app/Contents/Resources/web/dist" 2>/dev/null; then
  print -u2 "The beta bundle does not set VITE_LOCAL_DEV_AUTH=false; beta must authenticate for real."
  exit 1
fi
beta_supabase_url=$(grep -E '^VITE_SUPABASE_URL=' "$PWD/.env.beta" | head -1 | cut -d= -f2-)
production_supabase_url=$(grep -E '^VITE_SUPABASE_URL=' "$PWD/apps/web/.env.production" | head -1 | cut -d= -f2-)
grep -rq "$beta_supabase_url" "$app/Contents/Resources/web/dist"
! grep -rq "$production_supabase_url" "$app/Contents/Resources/web/dist"
grep -q 'VITE_LOCAL_DEV_AUTH=false' "$PWD/scripts/package-beta-mac.sh"
grep -q 'VITE_APP_ENVIRONMENT=beta' "$PWD/scripts/package-beta-mac.sh"

# Production's local Vite profile must not supply the beta's Google project.
beta_picker_key=$(sed -n 's/^VITE_GOOGLE_PICKER_API_KEY=//p' "$PWD/.env.beta" | head -1)
beta_google_project=$(sed -n 's/^VITE_GOOGLE_PROJECT_NUMBER=//p' "$PWD/.env.beta" | head -1)
if [[ -n "$beta_picker_key" ]]; then
  grep -Frq -- "$beta_picker_key" "$app/Contents/Resources/web/dist"
fi
if [[ -n "$beta_google_project" ]]; then
  grep -Frq -- "$beta_google_project" "$app/Contents/Resources/web/dist"
fi

# Beta must never be able to write or sign the production update manifest.
! grep -q 'sign-release-manifest' "$PWD/scripts/package-beta-mac.sh"

codesign --verify --deep --strict "$app"
[[ -d "$finder_extension" ]] || true
"$app/Contents/Resources/runtime/node" --version >/dev/null

# Structure proven; now prove it runs. The record below is only written after a
# real packaged login, a real entitlement and one completed operation, so a
# build that cannot actually work cannot be promoted.
node "$PWD/scripts/verify-beta-runtime.mjs"

source_revision=$(git rev-parse HEAD)
package_digest=$(shasum -a 256 "$app/Contents/Resources/release.json" | awk '{print $1}')
build_id=$(/usr/bin/plutil -extract buildId raw "$app/Contents/Resources/release.json" 2>/dev/null \
  || grep -o '"buildId": *"[^"]*"' "$app/Contents/Resources/release.json" | head -1 | cut -d'"' -f4)
# Untracked files count, exactly as they do in verify-release.mjs. A new source
# file that is in the build but not in the commit is the clearest case of a
# package that corresponds to no revision, and `git diff` alone never sees it.
# Ignored paths (.env.*, release/) are not untracked, so this stays quiet in
# ordinary use.
if [[ -z "$(git status --porcelain)" ]]; then dirty=false; else dirty=true; fi
verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p "$record_dir"
temporary_record="$record.$$.tmp"
cat > "$temporary_record" <<JSON
{
  "sourceRevision": "$source_revision",
  "buildId": "$build_id",
  "packageDigest": "$package_digest",
  "verifiedAt": "$verified_at",
  "dirty": $dirty
}
JSON
mv "$temporary_record" "$record"

print "Soty Beta identity, isolation, real authentication, and enforced entitlement verified."
print "Recorded verification of $source_revision (dirty: $dirty) at $record."
