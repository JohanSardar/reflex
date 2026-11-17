#!/bin/bash
# Archive and export locally. This script never uploads or submits a build.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEVELOPMENT_TEAM:?Set the Apple Developer team ID}"
: "${BUILD_NUMBER:?Set an unused App Store Connect build number}"
: "${PROVISIONING_PROFILE_SPECIFIER:?Set the installed App Store distribution profile name}"
: "${CODE_SIGN_IDENTITY:?Set the installed Apple Distribution certificate identity}"
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo 'BUILD_NUMBER must be a positive integer' >&2; exit 1; }
OUTPUT_DIR="${OUTPUT_DIR:-$PWD/build/release-$BUILD_NUMBER}"
[[ "$OUTPUT_DIR" = /* ]] || { echo 'OUTPUT_DIR must be absolute' >&2; exit 1; }
# Require a new output directory so an older IPA cannot be mistaken for this build.
mkdir -p "$(dirname "$OUTPUT_DIR")"
mkdir "$OUTPUT_DIR"
export DEVELOPMENT_TEAM PROVISIONING_PROFILE_SPECIFIER CODE_SIGN_IDENTITY OUTPUT_DIR
python3 - <<'PY'
import os, plistlib
from pathlib import Path
options = {
    'method': 'app-store-connect',
    'destination': 'export',
    'teamID': os.environ['DEVELOPMENT_TEAM'],
    'signingStyle': 'manual',
    'signingCertificate': os.environ['CODE_SIGN_IDENTITY'],
    'provisioningProfiles': {'si.eilmer.reflex': os.environ['PROVISIONING_PROFILE_SPECIFIER']},
    'manageAppVersionAndBuildNumber': False,
    'uploadSymbols': True,
}
with (Path(os.environ['OUTPUT_DIR']) / 'ExportOptions.plist').open('wb') as f:
    plistlib.dump(options, f)
PY
xcodegen generate --spec project.yml
xcodebuild -project Reflex.xcodeproj -scheme Reflex -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUTPUT_DIR/Reflex.xcarchive" \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="$CODE_SIGN_IDENTITY" PROVISIONING_PROFILE_SPECIFIER="$PROVISIONING_PROFILE_SPECIFIER" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" archive
xcodebuild -exportArchive -archivePath "$OUTPUT_DIR/Reflex.xcarchive" \
  -exportOptionsPlist "$OUTPUT_DIR/ExportOptions.plist" -exportPath "$OUTPUT_DIR/export"
shasum -a 256 "$OUTPUT_DIR/export/Reflex.ipa"
git rev-parse HEAD
