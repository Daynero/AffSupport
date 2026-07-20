#!/bin/zsh
set -euo pipefail

root="$PWD/release/dev"
app="$root/Wishly Dev.app"
[[ -d "$app" ]] || { print -u2 "Run npm run package:dev first."; exit 1; }
version=$(node -e 'const f=require("fs"); const p=JSON.parse(f.readFileSync(process.argv[1])); process.stdout.write(p.productVersion)' "$app/Contents/Resources/release.json")
dmg="$root/Wishly-Dev-$version-macOS-arm64.dmg"
stage=$(mktemp -d /tmp/wishly-dev-dmg.XXXXXX)
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Wishly Dev.app"
ln -s /Applications "$stage/Applications"
rm -f "$root"/Wishly-Dev-*-macOS-arm64.dmg(N) "$root"/Wishly-Dev-*-macOS-arm64.dmg.sha256(N)
hdiutil create -quiet -srcfolder "$stage" -volname "Wishly Dev" -fs HFS+ -format UDZO "$dmg"
(cd "$root"; shasum -a 256 "${dmg:t}" > "${dmg:t}.sha256")
print "Built $dmg"
