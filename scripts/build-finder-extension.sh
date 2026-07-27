#!/bin/zsh
set -euo pipefail

app="${1:?Pass the containing .app path}"
bundle_identifier="${2:?Pass the Finder extension bundle identifier}"
display_name="${3:?Pass the Finder extension display name}"
service_name="${4:?Pass the containing app service name}"
short_version="${5:?Pass CFBundleShortVersionString}"
build_number="${6:?Pass CFBundleVersion}"
generated_source="${7:?Pass a generated Swift source path}"
menu_suffix="${8-}"

extension="$app/Contents/PlugIns/WishlyFinderExtension.appex"
executable="$extension/Contents/MacOS/WishlyFinderExtension"
mkdir -p "$extension/Contents/MacOS" \
  "$extension/Contents/Resources/en.lproj" \
  "$extension/Contents/Resources/uk.lproj"

node scripts/render-launcher.mjs \
  packaging/FinderExtension/FinderSync.swift \
  "$generated_source" \
  "FINDER_SERVICE_NAME=$service_name" \
  "FINDER_MENU_SUFFIX=$menu_suffix"
swiftc "$generated_source" \
  -o "$executable" \
  -target arm64-apple-macos13.0 \
  -module-name WishlyFinderExtension \
  -parse-as-library \
  -application-extension \
  -Xlinker -e \
  -Xlinker _NSExtensionMain \
  -framework AppKit \
  -framework FinderSync \
  -framework UniformTypeIdentifiers

cp packaging/FinderExtension/Info.plist "$extension/Contents/Info.plist"
cp packaging/FinderExtension/en.lproj/Localizable.strings \
  "$extension/Contents/Resources/en.lproj/Localizable.strings"
cp packaging/FinderExtension/uk.lproj/Localizable.strings \
  "$extension/Contents/Resources/uk.lproj/Localizable.strings"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $bundle_identifier" \
  "$extension/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $display_name" \
  "$extension/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $display_name" \
  "$extension/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $short_version" \
  "$extension/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" \
  "$extension/Contents/Info.plist"
xattr -cr "$extension"
codesign --force --sign - \
  --entitlements packaging/FinderExtension/FinderExtension.entitlements \
  "$extension"
