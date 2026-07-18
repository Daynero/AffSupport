#!/bin/zsh
set -euo pipefail
root="$PWD/release"; app="$root/Local Video Compressor Agent.app"; dmg_name=$(node scripts/release-meta.mjs artifact-name); dmg="$root/$dmg_name"
[[ -d "$app" ]] || { print -u2 "Build the app first with npm run package:mac"; exit 1; }
[[ ! -e "$dmg" ]] || { print -u2 "$dmg already exists. Published build identities are immutable; bump PRODUCT_VERSION and BUILD_NUMBER."; exit 1; }
stage="$root/dmg-stage"; rw="$root/LocalVideoCompressor-rw.dmg"; rm -rf "$stage"; rm -f "$rw"; mkdir -p "$stage/.background"
cp -R "$app" "$stage/"; ln -s /Applications "$stage/Applications"
swiftc packaging/DmgBackground.swift -o "$root/DmgBackground" -framework AppKit; "$root/DmgBackground" "$stage/.background/background.png"
hdiutil create -quiet -srcfolder "$stage" -volname "Local Video Compressor Agent" -fs HFS+ -format UDRW "$rw"
device=$(hdiutil attach -readwrite -noverify -noautoopen "$rw" | awk '/Apple_HFS/{print $1; exit}')
mount="/Volumes/Local Video Compressor Agent"
osascript <<APPLESCRIPT
tell application "Finder"
  tell disk "Local Video Compressor Agent"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {120, 120, 780, 520}
    set theViewOptions to the icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 104
    set background picture of theViewOptions to file ".background:background.png"
    set position of item "Local Video Compressor Agent.app" of container window to {175, 205}
    set position of item "Applications" of container window to {485, 205}
    close
    open
    update without registering applications
    delay 2
  end tell
end tell
APPLESCRIPT
sync; hdiutil detach -quiet "$device"; hdiutil convert -quiet "$rw" -format UDZO -imagekey zlib-level=9 -o "$dmg"; (cd "$root"; shasum -a 256 "${dmg:t}" > "${dmg:t}.sha256"); rm -rf "$stage"; rm -f "$rw"
