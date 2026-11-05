#!/usr/bin/env bash
# Builds the two Safari downloads of a release (macOS with Xcode only):
#
#   dlm-extension-<version>-safari.zip               DLM Safari.app, ad-hoc signed, not notarized
#   dlm-extension-<version>-safari-xcode-project.zip the Xcode project, to build and sign with your own Apple ID
#
#   tools/safari-package.sh <version> [output-directory]
#
# Neither is signed by an Apple Developer ID: Safari runs them only with Develop > Allow Unsigned Extensions
# (docs/safari.md). A notarized build is planned inside the DLM app.
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:?version, such as 0.3.0}"
dest="${2:-release-safari}"

work=".output/safari-xcode"
tools/safari-convert.sh "$work" > /dev/null
mkdir -p "$dest"
dest="$(cd "$dest" && pwd)"
proj="$work/DLM Safari"

( cd "$work" && zip -qr "$dest/dlm-extension-$version-safari-xcode-project.zip" "DLM Safari" -x "*/build/*" )

( cd "$proj" && xcodebuild -project "DLM Safari.xcodeproj" -scheme "DLM Safari" -configuration Release \
    -derivedDataPath build CODE_SIGN_IDENTITY="-" CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual \
    DEVELOPMENT_TEAM="" ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO build > /dev/null )
ditto -c -k --keepParent "$proj/build/Build/Products/Release/DLM Safari.app" \
  "$dest/dlm-extension-$version-safari.zip"
ls -l "$dest"
