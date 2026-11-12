#!/bin/zsh
# Sign a Soty macOS app bundle inside-out with the hardened runtime and a
# per-binary entitlement profile; with a Developer ID identity also timestamp,
# notarize and staple it. Specification: specs/048-macos-apple-trust.
#
#   zsh scripts/sign-mac-app.sh <App.app>
#
# Environment, never read from tracked files:
#   SOTY_SIGNING_IDENTITY         codesign identity; "-" (default) is ad-hoc
#   SOTY_SIGNING_KEYCHAIN         keychain file holding the identity (optional)
#   SOTY_SKIP_NOTARIZATION=1      sign only; mandatory with the ad-hoc identity
#   SOTY_NOTARY_KEYCHAIN_PROFILE  `xcrun notarytool store-credentials` profile
#   SOTY_ENTITLEMENTS_DIR         profile directory (default packaging/macos/entitlements)
#   SOTY_NOTARY_TIMEOUT           how long to wait for Apple (default 30m; the release
#                                 runner's packaging step allows 45m for build and wait)
#
# Prints one JSON line on success. Every failure exits non-zero with a closed
# code on stderr; there is no fallback between identities or policies.
set -euo pipefail
setopt null_glob

fail() { print -u2 -- "$1${2:+: $2}"; exit 1; }

app=${1:-}
[[ -n "$app" && -d "$app" && -f "$app/Contents/Info.plist" ]] || fail SIGN_INPUT_INVALID "expected an .app bundle path"
app=${app:A}
identity=${SOTY_SIGNING_IDENTITY:--}
keychain=${SOTY_SIGNING_KEYCHAIN:-}
skip_notarization=${SOTY_SKIP_NOTARIZATION:-}
notary_profile=${SOTY_NOTARY_KEYCHAIN_PROFILE:-}
here=${0:A:h}
entitlements_dir=${SOTY_ENTITLEMENTS_DIR:-$here/../packaging/macos/entitlements}
entitlements_dir=${entitlements_dir:A}
finder_entitlements="$here/../packaging/FinderExtension/FinderExtension.entitlements"
finder_entitlements=${finder_entitlements:A}
for profile in launcher node chromium; do
  [[ -f "$entitlements_dir/$profile.plist" ]] || fail SIGN_ENTITLEMENTS_MISSING "$entitlements_dir/$profile.plist"
done
if [[ "$identity" == "-" && "$skip_notarization" != 1 ]]; then
  fail SIGN_ADHOC_CANNOT_NOTARIZE "set SOTY_SKIP_NOTARIZATION=1 with the ad-hoc identity, or provide SOTY_SIGNING_IDENTITY"
fi
if [[ "$identity" != "-" && "$skip_notarization" != 1 && -z "$notary_profile" ]]; then
  fail NOTARY_PROFILE_REQUIRED "set SOTY_NOTARY_KEYCHAIN_PROFILE (xcrun notarytool store-credentials) or SOTY_SKIP_NOTARIZATION=1"
fi

executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist" 2>/dev/null) \
  || fail SIGN_INPUT_INVALID "Info.plist has no CFBundleExecutable"
main_executable="$app/Contents/MacOS/$executable"
[[ -f "$main_executable" ]] || fail SIGN_INPUT_INVALID "missing $main_executable"

sign_args=(--force --options runtime)
if [[ "$identity" == "-" ]]; then sign_args+=(--timestamp=none); else sign_args+=(--timestamp); fi
[[ -n "$keychain" ]] && sign_args+=(--keychain "$keychain")

# Every Mach-O under the bundle, found by magic in one process. The list is
# what gets signed; `--deep` would skip the loose executables in Resources.
mach_o_files() {
  find "$1" -type f -print0 | perl -0 -ne '
    chomp;
    open(my $fh, "<:raw", $_) or next;
    my $n = read($fh, my $magic, 4);
    close $fh;
    next unless $n == 4;
    my $hex = unpack("H8", $magic);
    print "$_\0" if $hex =~ /^(?:feedface|feedfacf|cefaedfe|cffaedfe|cafebabe|bebafeca)$/;
  '
}

# Nested bundles, deepest first, so each is sealed before its parent.
nested_bundles=()
while IFS= read -r -d '' bundle; do nested_bundles+=("$bundle"); done < <(
  find "$app/Contents" -type d \( -name '*.appex' -o -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) -print0 \
    | perl -0 -e 'chomp(my @d = <STDIN>); print "$_\0" for sort { ($b =~ tr#/##) <=> ($a =~ tr#/##) } @d'
)
inside_nested() {
  local candidate=$1 bundle
  for bundle in "${nested_bundles[@]}"; do [[ "$candidate" == "$bundle"/* ]] && return 0; done
  return 1
}

profile_for() {
  local relative=${1#$app/}
  case "$relative" in
    Contents/Resources/runtime/node) print node ;;
    */chrome-headless-shell) print chromium ;;
    *) print hardened ;;
  esac
}

loose=()
while IFS= read -r -d '' file; do
  [[ "$file" == "$main_executable" ]] && continue
  inside_nested "$file" && continue
  loose+=("$file")
done < <(mach_o_files "$app")

typeset -A profile_counts
profile_counts=(node 0 chromium 0 hardened 0)
typeset -A profile_of
# The chain attests what it signed: the digest of each Mach-O as it was handed over and
# as it leaves. Staging records the pinned upstream bytes before signing changes them;
# verify-staged-dependencies.mjs ties the two ends together through this record.
digest_of() { /usr/bin/shasum -a 256 "$1" | cut -d ' ' -f1; }
typeset -A before_of after_of
for file in "${loose[@]}"; do
  profile=$(profile_for "$file")
  profile_of[$file]=$profile
  profile_counts[$profile]=$(( profile_counts[$profile] + 1 ))
  before_of[$file]=$(digest_of "$file")
  # Drop the input's own signature and entitlements first: the official Node
  # ships six, four of which notarization and the hardened runtime forbid.
  codesign --remove-signature "$file" 2>/dev/null || true
  args=("${sign_args[@]}")
  case "$profile" in
    node|chromium) args+=(--entitlements "$entitlements_dir/$profile.plist") ;;
  esac
  codesign "${args[@]}" --sign "$identity" "$file" 2>/dev/null || fail SIGN_FAILED "$file"
  after_of[$file]=$(digest_of "$file")
done

for bundle in "${nested_bundles[@]}"; do
  args=("${sign_args[@]}")
  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Contents/Info.plist" 2>/dev/null || /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$bundle/Resources/Info.plist" 2>/dev/null || true)
  if [[ "$bundle" == *.appex && "$bundle_id" == *.finder-extension ]]; then
    [[ -f "$finder_entitlements" ]] || fail SIGN_ENTITLEMENTS_MISSING "$finder_entitlements"
    args+=(--entitlements "$finder_entitlements")
  else
    args+=(--preserve-metadata=entitlements)
  fi
  codesign "${args[@]}" --sign "$identity" "$bundle" 2>/dev/null || fail SIGN_FAILED "$bundle"
done

before_of[$main_executable]=$(digest_of "$main_executable")
codesign "${sign_args[@]}" --entitlements "$entitlements_dir/launcher.plist" --sign "$identity" "$app" 2>/dev/null \
  || fail SIGN_FAILED "$app"
after_of[$main_executable]=$(digest_of "$main_executable")

# Verification: the chain does not trust its own signing calls.
entitlement_keys() {
  codesign -d --entitlements - --xml "$1" 2>/dev/null | perl -0 -ne 'print "$1\n" while /<key>([^<]+)<\/key>/g' | sort -u
}
forbidden=(
  com.apple.security.cs.disable-library-validation
  com.apple.security.cs.allow-dyld-environment-variables
  com.apple.security.cs.disable-executable-page-protection
  com.apple.security.get-task-allow
)
jit_pair=$'com.apple.security.cs.allow-jit\ncom.apple.security.cs.allow-unsigned-executable-memory'
# The app was signed last; every Mach-O under it must name the same team (ad-hoc prints
# "not set", which is fine because the team check below runs only for a real identity).
team_id=$(codesign -dvv "$app" 2>&1 | awk -F= '/^TeamIdentifier=/{print $2; exit}')
if [[ "$identity" != "-" && ! "$team_id" =~ ^[A-Z0-9]{10}$ ]]; then
  fail SIGN_VERIFY_FAILED "$app: no TeamIdentifier on the signed app"
fi
check_signature() { # file expected-profile
  local file=$1 expected=$2 details keys key
  details=$(codesign -dvv "$file" 2>&1) || fail SIGN_VERIFY_FAILED "$file: not signed"
  [[ "$details" =~ 'flags=0x[0-9a-f]+\([^)]*runtime' ]] || fail SIGN_VERIFY_FAILED "$file: hardened runtime flag missing"
  if [[ "$identity" != "-" ]]; then
    [[ "$details" == *"Timestamp="* ]] || fail SIGN_VERIFY_FAILED "$file: no secure timestamp"
    [[ "$details" == *"Authority=Developer ID Application:"* ]] || fail SIGN_VERIFY_FAILED "$file: not a Developer ID signature"
    grep -qx "TeamIdentifier=$team_id" <<< "$details" || fail SIGN_VERIFY_FAILED "$file: TeamIdentifier differs from the app"
  fi
  keys=$(entitlement_keys "$file")
  for key in "${forbidden[@]}"; do
    [[ "$keys" == *"$key"* ]] && fail SIGN_VERIFY_FAILED "$file: carries $key"
  done
  case "$expected" in
    node|chromium) [[ "$keys" == "$jit_pair" ]] || fail SIGN_VERIFY_FAILED "$file: entitlements must be exactly the JIT pair" ;;
    hardened|launcher) [[ -z "$keys" ]] || fail SIGN_VERIFY_FAILED "$file: unexpected entitlements" ;;
    nested) [[ "$keys" != *allow-jit* && "$keys" != *allow-unsigned-executable-memory* ]] || fail SIGN_VERIFY_FAILED "$file: nested bundle carries JIT entitlements" ;;
  esac
}
for file in "${loose[@]}"; do check_signature "$file" "${profile_of[$file]}"; done
for bundle in "${nested_bundles[@]}"; do check_signature "$bundle" nested; done
check_signature "$main_executable" launcher
codesign --verify --deep --strict --verbose=2 "$app" 2>/dev/null || fail SIGN_VERIFY_FAILED "$app: deep strict verification"

notarized=false; stapled=false; submission_id=""
if [[ "$skip_notarization" != 1 ]]; then
  work=$(mktemp -d "${TMPDIR:-/tmp}/soty-notarize-XXXXXX")
  archive="$work/${app:t:r}.zip"
  ditto -c -k --keepParent "$app" "$archive"
  notary_args=(--keychain-profile "$notary_profile" --wait --timeout "${SOTY_NOTARY_TIMEOUT:-30m}")
  [[ -n "$keychain" ]] && notary_args+=(--keychain "$keychain")
  if ! submission=$(xcrun notarytool submit "$archive" "${notary_args[@]}" 2>&1); then
    print -u2 -- "$submission"; rm -rf "$work"; fail NOTARIZE_FAILED "submission did not complete"
  fi
  # Apple's receipt for this exact archive; the publish journal keeps it (048 T013).
  submission_id=$(print -r -- "$submission" | awk '/^[[:space:]]*id:/{print $2; exit}')
  if ! print -r -- "$submission" | grep -Eq '^\s*status: Accepted\s*$'; then
    print -u2 -- "$submission"
    if [[ -n "$submission_id" ]]; then
      log_args=(--keychain-profile "$notary_profile"); [[ -n "$keychain" ]] && log_args+=(--keychain "$keychain")
      xcrun notarytool log "$submission_id" "${log_args[@]}" >&2 || true
    fi
    rm -rf "$work"; fail NOTARIZE_FAILED "status is not Accepted"
  fi
  rm -rf "$work"
  xcrun stapler staple "$app" >/dev/null 2>&1 || fail STAPLE_FAILED "$app"
  xcrun stapler validate "$app" >/dev/null 2>&1 || fail STAPLE_FAILED "validate $app"
  spctl --assess --type execute --verbose=2 "$app" 2>/dev/null || fail GATEKEEPER_REJECTED "$app"
  notarized=true; stapled=true
fi

json_string() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
if [[ "$identity" == "-" ]]; then identity_kind=adhoc; team_json=null; else identity_kind=developer-id; team_json="\"$(json_string "$team_id")\""; fi
if [[ -n "$submission_id" ]]; then submission_json="\"$(json_string "$submission_id")\""; else submission_json=null; fi
# One entry per Mach-O the chain signed on its own (the `machO` count), by path.
typeset -A entry_by_path
for file in "${loose[@]}" "$main_executable"; do
  relative=${file#$app/}
  entry_by_path[$relative]="{\"path\":\"$(json_string "$relative")\",\"profile\":\"${profile_of[$file]:-launcher}\",\"before\":\"${before_of[$file]}\",\"after\":\"${after_of[$file]}\"}"
done
file_entries=()
for relative in "${(@ko)entry_by_path}"; do file_entries+=("${entry_by_path[$relative]}"); done
files_json="[${(j:,:)file_entries}]"
printf '{"app":"%s","identity":"%s","teamId":%s,"machO":%d,"nestedBundles":%d,"profiles":{"node":%d,"chromium":%d,"hardened":%d},"files":%s,"notarized":%s,"stapled":%s,"submissionId":%s}\n' \
  "$(json_string "$app")" "$identity_kind" "$team_json" $(( ${#loose[@]} + 1 )) "${#nested_bundles[@]}" \
  "${profile_counts[node]}" "${profile_counts[chromium]}" "${profile_counts[hardened]}" "$files_json" "$notarized" "$stapled" "$submission_json"
