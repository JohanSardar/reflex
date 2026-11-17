#!/bin/bash
# Run from any directory. Pass an available iPad Simulator destination.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DESTINATION:?Set DESTINATION, e.g. platform=iOS Simulator,name=iPad Pro 13-inch (M5),OS=26.4}"
DERIVED_DATA="${DERIVED_DATA:-$PWD/build/check}"
RESULT_BUNDLE="$DERIVED_DATA/TestResults/$(uuidgen).xcresult"
mkdir -p "$(dirname "$RESULT_BUNDLE")"
xcrun swift-format lint --strict --recursive --configuration .swift-format Reflex Packages
xcodegen generate --spec project.yml
xcodebuild -project Reflex.xcodeproj -scheme Reflex -configuration Release \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO build
xcodebuild -project Reflex.xcodeproj -scheme Reflex -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED_DATA" -resultBundlePath "$RESULT_BUNDLE" \
  CODE_SIGNING_ALLOWED=NO test
