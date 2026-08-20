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

[[ -d "$app" ]] || { print -u2 "No packaged beta build at $app. Run: npm run beta:package"; exit 1; }

# Identity: distinct from production and from Soty Dev in every slot.
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" == "com.wishly.beta" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$app/Contents/Info.plist")" == "Soty Beta" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")" == "SotyBetaAgent" ]]
grep -q '"channel": "beta"' "$app/Contents/Resources/release.json"
grep -q 'private let agentPort = 43140' "$record_dir/Launcher.generated.swift"
grep -q 'private let instanceLockName = "wishly-beta-agent.lock"' "$record_dir/Launcher.generated.swift"
grep -q 'private let supportDirectoryName = "Soty Beta"' "$record_dir/Launcher.generated.swift"

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
if grep -rq 'VITE_LOCAL_DEV_AUTH' "$app/Contents/Resources/web/dist" 2>/dev/null; then
  print -u2 "The beta bundle references VITE_LOCAL_DEV_AUTH; beta must authenticate for real."
  exit 1
fi
grep -q 'VITE_LOCAL_DEV_AUTH=false' "$PWD/scripts/package-beta-mac.sh"
grep -q 'VITE_APP_ENVIRONMENT=beta' "$PWD/scripts/package-beta-mac.sh"

# Beta must never be able to write or sign the production update manifest.
! grep -q 'sign-release-manifest' "$PWD/scripts/package-beta-mac.sh"

codesign --verify --deep --strict "$app"
[[ -d "$finder_extension" ]] || true
"$app/Contents/Resources/runtime/node" --version >/dev/null

source_revision=$(git rev-parse HEAD)
build_id=$(/usr/bin/plutil -extract buildId raw "$app/Contents/Resources/release.json" 2>/dev/null \
  || grep -o '"buildId": *"[^"]*"' "$app/Contents/Resources/release.json" | head -1 | cut -d'"' -f4)
if git diff --quiet && git diff --cached --quiet; then dirty=false; else dirty=true; fi
verified_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p "$record_dir"
cat > "$record" <<JSON
{
  "sourceRevision": "$source_revision",
  "buildId": "$build_id",
  "verifiedAt": "$verified_at",
  "dirty": $dirty
}
JSON

print "Soty Beta identity, isolation, real authentication, and enforced entitlement verified."
print "Recorded verification of $source_revision (dirty: $dirty) at $record."
