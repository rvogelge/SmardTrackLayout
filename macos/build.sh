#!/usr/bin/env bash
# SmardTrackLayout - model railway track layout editor
# Copyright (C) 2026 Rolf Vogelgesang
#
# This program is free software: you can redistribute it and/or modify it under the terms of
# the GNU General Public License as published by the Free Software Foundation, either
# version 3 of the License, or (at your option) any later version. It is distributed
# WITHOUT ANY WARRANTY; see the GNU General Public License for details (file LICENSE).
#
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds dist/SmardTrackLayout.app (universal: Apple silicon + Intel) and a zip of it.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=SmardTrackLayout
APP="dist/$NAME.app"
BUILD=build/macos
VERSION=$(sed -nE 's/.*"version": *"([^"]+)".*/\1/p' package.json)
MIN_OS=13.0

rm -rf "$APP" "$BUILD"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$BUILD"

echo "› compiling ($VERSION)"
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos$MIN_OS" macos/main.swift -o "$BUILD/$NAME-$arch"
done
lipo -create "$BUILD/$NAME-arm64" "$BUILD/$NAME-x86_64" -output "$APP/Contents/MacOS/$NAME"

echo "› resources"
cp -R public "$APP/Contents/Resources/web"
scripts/build-info.sh "$APP/Contents/Resources/web/build.json"
cp -R seed "$APP/Contents/Resources/seed"
swift macos/make-icon.swift public/favicon.svg "$BUILD/AppIcon.iconset"
iconutil -c icns "$BUILD/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>com.github.rvogelge.smardtracklayout</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_OS</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.graphics-design</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleAllowMixedLocalizations</key><true/>
  <key>CFBundleLocalizations</key><array><string>en</string><string>de</string><string>fr</string><string>it</string><string>es</string></array>
  <key>NSHumanReadableCopyright</key><string>© 2026 Rolf Vogelgesang · GNU GPL v3 or later. Track geometry: XTrackCAD (GPL v2+).</string>
</dict></plist>
EOF

echo "› signing (ad-hoc)"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --strict "$APP"

ditto -c -k --keepParent "$APP" "dist/$NAME-macOS.zip"
echo "✓ $APP"
echo "✓ dist/$NAME-macOS.zip"
