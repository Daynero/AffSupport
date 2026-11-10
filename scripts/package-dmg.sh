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
sync; hdiutil detach -quiet "$device"; hdiutil convert -quiet "$rw" -format UDZO -imagekey zlib-level=9 -o "$dmg"; (cd "$root"; shasum -a 256 "${dmg:t}" > "${dmg:t}.sha256"); rm -rf "$stage"; rm -f "$rw"
