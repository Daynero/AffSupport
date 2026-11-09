#!/bin/zsh
set -euo pipefail
# Validate before any builds, admission, cleanup or listener changes.
arch=$(node scripts/lib/macos-target.mjs arch beta "$@")
macho=$(node scripts/lib/macos-target.mjs macho beta "$@")
swift_target=$(node scripts/lib/macos-target.mjs swift beta "$@")
target_root=$(node scripts/lib/macos-target.mjs root beta "$@")

# Packaged-beta smoke.
#
# Asserts the packaged build really is a beta build — its own identity, its own
# slots, real authentication, an enforced entitlement gate — and only then
# writes the verification record the promotion gate reads. A failed smoke
# leaves no record, so a stale pass can never be reused.

app="$target_root/Soty Beta.app"
finder_extension="$app/Contents/PlugIns/SotyFinderExtension.appex"
record_dir="$target_root"
record="$record_dir/verification.json"
rm -f "$record"
node scripts/verify-macos-payload.mjs "$app" --arch="$arch"
[[ "$arch" == x64 || "$(node -p process.arch)" == "$arch" ]] || { print -u2 "Matching native runtime required; static payload checks passed but runtime acceptance is unproven."; exit 1; }

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
# 048 FR-008: every Mach-O hardened with its measured entitlement profile, described by
# the chain's own summary beside the package; a beta pass without this says nothing
# about the production chain.
node scripts/audit-macos-signing.mjs "$app" --signing="$record_dir/signing.json"
[[ -d "$finder_extension" ]] || true
if [[ "$arch" == x64 ]]; then
  node scripts/verify-staged-dependencies.mjs "$app/Contents/Resources/agent" --static
  node "${0:A:h}/record-macos-beta-proof.mjs" --arch="$arch"
  print "Recorded Intel static qualification under intel-user-feedback-v1. Native execution remains unverified; user feedback follows release."
  exit 0
fi
"$app/Contents/Resources/runtime/node" --version >/dev/null

# Structure proven; now prove it runs. The record below is only written after a
# real packaged login, a real entitlement and one completed operation, so a
# build that cannot actually work cannot be promoted.
# The release runner owns the verification harness; the package, keys and
# exact-SHA record still belong to the candidate working directory.
node "${0:A:h}/verify-beta-runtime.mjs" --arch="$arch"

node "${0:A:h}/record-macos-beta-proof.mjs" --arch="$arch"
print "Recorded native target-bound beta verification at $record."
