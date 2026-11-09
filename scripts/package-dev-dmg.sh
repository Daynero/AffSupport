#!/bin/zsh
set -euo pipefail
# Validate before any builds, admission, cleanup or listener changes.
arch=$(node scripts/lib/macos-target.mjs arch dev "$@")
macho=$(node scripts/lib/macos-target.mjs macho dev "$@")
swift_target=$(node scripts/lib/macos-target.mjs swift dev "$@")
target_root=$(node scripts/lib/macos-target.mjs root dev "$@")

root="$target_root"
app="$root/Soty Dev.app"
[[ -d "$app" ]] || { print -u2 "Run npm run package:dev first."; exit 1; }
node scripts/verify-macos-payload.mjs "$app" --arch="$arch"
version=$(node -e 'const f=require("fs"); const p=JSON.parse(f.readFileSync(process.argv[1])); process.stdout.write(p.productVersion)' "$app/Contents/Resources/release.json")
dmg="$root/Soty-Dev-$version-macOS-$arch.dmg"
stage=$(mktemp -d "$root/.wishly-dev-dmg.XXXXXX")
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Soty Dev.app"
ln -s /Applications "$stage/Applications"
rm -f "$root"/Soty-Dev-*-macOS-$arch.dmg(N) "$root"/Soty-Dev-*-macOS-$arch.dmg.sha256(N)
hdiutil create -quiet -srcfolder "$stage" -volname "Soty Dev" -fs HFS+ -format UDZO \
  -imagekey zlib-level=9 "$dmg"
(cd "$root"; shasum -a 256 "${dmg:t}" > "${dmg:t}.sha256")
print "Built $dmg"
