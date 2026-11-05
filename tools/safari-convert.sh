#!/usr/bin/env bash
# Builds the extension for Safari and turns it into an Xcode project (macOS with Xcode only).
#
#   tools/safari-convert.sh [output-directory]
#
# The project it writes is for trying the extension locally. The one that ships is the app target in dlm-app that
# embeds the same build (docs/safari.md).
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-.output/safari-xcode}"

pnpm build:safari
rm -rf "$out"
mkdir -p "$out"
xcrun safari-web-extension-converter .output/safari-mv3 \
  --project-location "$out" \
  --app-name "DLM Safari" \
  --bundle-identifier io.github.sabadia.dlm.safari \
  --macos-only --no-open --no-prompt --force

cat <<MSG

Done. Next:
  1. open "$out/DLM Safari/DLM Safari.xcodeproj" and run the "DLM Safari" scheme (set your team, or sign to run locally);
  2. Safari > Develop > Allow Unsigned Extensions (it resets every time Safari restarts);
  3. Safari > Settings > Extensions > turn DLM on, and allow it on the sites you want.
MSG
