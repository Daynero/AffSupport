#!/bin/zsh
set -euo pipefail
# Validate before any builds, admission, cleanup or listener changes.
arch=$(node scripts/lib/macos-target.mjs arch production "$@")
macho=$(node scripts/lib/macos-target.mjs macho production "$@")
swift_target=$(node scripts/lib/macos-target.mjs swift production "$@")
target_root=$(node scripts/lib/macos-target.mjs root production "$@")
source "$PWD/scripts/release-admission.zsh"
release_require_admission
root="$target_root"; app="$root/Soty.app"; dmg_name=$(node scripts/release-meta.mjs "$([[ "$arch" == x64 ]] && print intel-artifact-name || print artifact-name)"); dmg="$root/$dmg_name"
[[ -d "$app" ]] || { print -u2 "Build the app first with npm run package:mac"; exit 1; }
[[ ! -e "$dmg" ]] || { print -u2 "$dmg already exists. Published build identities are immutable; bump PRODUCT_VERSION and BUILD_NUMBER."; exit 1; }
volume_name="Soty"; [[ "$arch" == x64 ]] && volume_name="Soty-x64"
[[ ! -e "/Volumes/$volume_name" ]] || { print -u2 "The target DMG volume is already mounted. Eject it before packaging."; exit 1; }
node scripts/verify-macos-payload.mjs "$app" --arch="$arch"
stage="$root/dmg-stage"; rw="$root/Soty-rw.dmg"; rm -rf "$stage"; rm -f "$rw"; mkdir -p "$stage/.background"
cp -R "$app" "$stage/"; ln -s /Applications "$stage/Applications"
swiftc packaging/DmgBackground.swift -o "$root/DmgBackground" -framework AppKit; "$root/DmgBackground" "$stage/.background/background.png" "$PWD/apps/web/public/soty-header-logo-light.svg"
hdiutil create -quiet -srcfolder "$stage" -volname "$volume_name" -fs HFS+ -format UDRW "$rw"
device=$(hdiutil attach -readwrite -noverify -noautoopen "$rw" | awk '/Apple_HFS/{print $1; exit}')
mount="/Volumes/$volume_name"
# Disk Arbitration reports the device before Finder has registered the mounted
# volume. Wait for the mount point so the Finder layout script cannot race it.
for _ in {1..40}; do
  [[ -d "$mount" ]] && break
  sleep 0.25
done
[[ -d "$mount" ]] || { print -u2 "DMG volume did not mount at $mount"; hdiutil detach -quiet "$device" || true; exit 1; }
# Finder registers the volume later still; the layout script fails with -1728 if it asks
# first. Wait until Finder itself can see the disk.
for _ in {1..60}; do
  osascript -e "tell application \"Finder\" to exists disk \"$volume_name\"" 2>/dev/null | grep -q true && break
  sleep 0.5
done
osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "$volume_name"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {120, 120, 780, 520}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 104
    set background picture of theViewOptions to file ".background:background.png"
    set position of item "Soty.app" of container window to {175, 205}
    set position of item "Applications" of container window to {485, 205}
    close
    open
    update without registering applications
    delay 2
  end tell
end tell
APPLESCRIPT
sync; hdiutil detach -quiet "$device"; hdiutil convert -quiet "$rw" -format UDZO -imagekey zlib-level=9 -o "$dmg"; rm -rf "$stage"; rm -f "$rw"
# 048 FR-004 (T011): with a Developer ID the image is signed, notarized and stapled on
# its own, after the app inside it was; ad-hoc needs the owner's explicit pre-048 policy
# and leaves the image unsigned, as every release up to 1.4.x shipped. The digest is
# taken last, because stapling rewrites the image.
identity="${SOTY_SIGNING_IDENTITY:--}"
if [[ "$identity" == "-" ]]; then
  [[ "${SOTY_MACOS_TRUST_POLICY:-}" == adhoc-pre-048 || "${SOTY_SKIP_NOTARIZATION:-}" == 1 ]] \
    || { print -u2 "SIGN_IDENTITY_REQUIRED: set SOTY_SIGNING_IDENTITY to the Developer ID Application identity, or explicitly SOTY_MACOS_TRUST_POLICY=adhoc-pre-048 to ship the image unsigned as before 048"; exit 1; }
else
  keychain_args=(); [[ -n "${SOTY_SIGNING_KEYCHAIN:-}" ]] && keychain_args=(--keychain "$SOTY_SIGNING_KEYCHAIN")
  codesign --force --timestamp "${keychain_args[@]}" --sign "$identity" "$dmg" || { print -u2 "SIGN_FAILED: $dmg"; exit 1; }
  if [[ "${SOTY_SKIP_NOTARIZATION:-}" != 1 ]]; then
    [[ -n "${SOTY_NOTARY_KEYCHAIN_PROFILE:-}" ]] || { print -u2 "NOTARY_PROFILE_REQUIRED: set SOTY_NOTARY_KEYCHAIN_PROFILE (xcrun notarytool store-credentials) or SOTY_SKIP_NOTARIZATION=1"; exit 1; }
    # The app inside carries its own ticket from scripts/sign-mac-app.sh: the image's
    # ticket covers the download, the app's covers the first offline launch after the drag.
    xcrun stapler validate "$app" >/dev/null 2>&1 || { print -u2 "STAPLE_FAILED: $app has no stapled ticket; sign it through scripts/sign-mac-app.sh first"; exit 1; }
    notary_args=(--keychain-profile "$SOTY_NOTARY_KEYCHAIN_PROFILE" --wait --timeout "${SOTY_NOTARY_TIMEOUT:-30m}")
    log_args=(--keychain-profile "$SOTY_NOTARY_KEYCHAIN_PROFILE")
    if [[ -n "${SOTY_SIGNING_KEYCHAIN:-}" ]]; then notary_args+=(--keychain "$SOTY_SIGNING_KEYCHAIN"); log_args+=(--keychain "$SOTY_SIGNING_KEYCHAIN"); fi
    submission=$(xcrun notarytool submit "$dmg" "${notary_args[@]}" 2>&1) || { print -u2 -- "$submission"; print -u2 "NOTARIZE_FAILED: $dmg submission did not complete"; exit 1; }
    if ! print -r -- "$submission" | grep -Eq '^\s*status: Accepted\s*$'; then
      print -u2 -- "$submission"
      submission_id=$(print -r -- "$submission" | awk '/^[[:space:]]*id:/{print $2; exit}')
      [[ -z "$submission_id" ]] || xcrun notarytool log "$submission_id" "${log_args[@]}" >&2 || true
      print -u2 "NOTARIZE_FAILED: $dmg status is not Accepted"; exit 1
    fi
    xcrun stapler staple "$dmg" >/dev/null 2>&1 || { print -u2 "STAPLE_FAILED: $dmg"; exit 1; }
    xcrun stapler validate "$dmg" >/dev/null 2>&1 || { print -u2 "STAPLE_FAILED: validate $dmg"; exit 1; }
    spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg" 2>/dev/null || { print -u2 "GATEKEEPER_REJECTED: $dmg"; exit 1; }
  fi
fi
(cd "$root"; shasum -a 256 "${dmg:t}" > "${dmg:t}.sha256")
