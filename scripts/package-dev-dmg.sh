#!/bin/zsh
set -euo pipefail

root="$PWD/release/dev"
app="$root/Soty Dev.app"
[[ -d "$app" ]] || { print -u2 "Run npm run package:dev first."; exit 1; }
version=$(node -e 'const f=require("fs"); const p=JSON.parse(f.readFileSync(process.argv[1])); process.stdout.write(p.productVersion)' "$app/Contents/Resources/release.json")
dmg="$root/Soty-Dev-$version-macOS-arm64.dmg"
stage=$(mktemp -d /tmp/wishly-dev-dmg.XXXXXX)
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/Soty Dev.app"
ln -s /Applications "$stage/Applications"
rm -f "$root"/Soty-Dev-*-macOS-arm64.dmg(N) "$root"/Soty-Dev-*-macOS-arm64.dmg.sha256(N)
hdiutil create -quiet -srcfolder "$stage" -volname "Soty Dev" -fs HFS+ -format UDZO \
  -imagekey zlib-level=9 "$dmg"
(cd "$root"; shasum -a 256 "${dmg:t}" > "${dmg:t}.sha256")
print "Built $dmg"
