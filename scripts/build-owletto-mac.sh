#!/usr/bin/env bash
# Build Lobu.app with the same Developer ID identity as mac-release CI.
# TCC grants (Screen Recording, Accessibility, etc.) then match the notarized
# release — unlike a default Xcode Debug build (Apple Development cert).
#
# Usage:
#   make owletto-mac                  # build → /tmp/owletto-build/.../Lobu.app
#   make owletto-mac INSTALL=1        # also replace /Applications/Lobu.app
#   make owletto-mac INSTALL=1 OPEN=1 # install and launch
#   VERSION=14.8.1-dev make owletto-mac   # stamp a specific version
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/scripts/sync-owletto-submodule.sh"
MAC="$ROOT/packages/owletto/apps/mac"
DERIVED="${DERIVED:-/tmp/owletto-build}"
TEAM_ID="CCV9Q352W3"
SIGN_ID="Developer ID Application"
# Stamp a version instead of inheriting the pbxproj placeholders
# (MARKETING_VERSION=0.1.0, CURRENT_PROJECT_VERSION=1). Two failures come from
# leaving them alone, and this script is the Release+Developer ID+/Applications
# path, so the DEBUG guard in OwlettoUpdater does not apply:
#   1. The app reports app_version 0.1.0 to the server, which is
#      indistinguishable from a real release and hid for weeks that two paired
#      Macs were running local builds.
#   2. CFBundleVersion=1 is below every appcast <sparkle:version>, so Sparkle
#      treats a release as newer forever and silently replaces the build you
#      deliberately made — re-downloading and re-staging on every check.
# The default sorts above any real release so a dev build is never clobbered.
# Override for a build meant to be superseded by a later release:
#   VERSION=14.8.1-dev make owletto-mac
VERSION="${VERSION:-99.0.0-dev}"

die() { echo "error: $*" >&2; exit 1; }

[ -f "$MAC/Owletto.xcodeproj/project.pbxproj" ] \
  || die "packages/owletto not initialized — run: git submodule update --init packages/owletto"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  die "$(cat <<EOF
No Developer ID Application cert in your login keychain.
  • Keychain Access → import the Developer ID .p12 (same cert as CI), or
  • Download it from developer.apple.com (team $TEAM_ID), or
  • For prod E2E only: install the release DMG instead of building locally
    https://github.com/lobu-ai/lobu/releases/latest/download/Lobu.dmg
EOF
)"
fi

echo ">> Building Lobu (Release, $SIGN_ID, version $VERSION)..."
(
  cd "$MAC"
  "$ROOT/scripts/with-owletto-mac-daemon.sh" \
    xcodebuild -scheme Owletto -configuration Release \
    -derivedDataPath "$DERIVED" \
    CODE_SIGN_STYLE=Manual \
    CODE_SIGN_IDENTITY="$SIGN_ID" \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    ENABLE_HARDENED_RUNTIME=YES \
    MARKETING_VERSION="$VERSION" \
    CURRENT_PROJECT_VERSION="$VERSION" \
    build
)

APP="$DERIVED/Build/Products/Release/Lobu.app"
[ -d "$APP" ] || die "build succeeded but $APP is missing"
AUTH_CLI="$APP/Contents/Resources/lobu-cli/bin/lobu"
"$ROOT/scripts/build-mac-auth-cli.sh" "$AUTH_CLI"
AUTH_ENTITLEMENTS="$ROOT/config/macos/lobu-auth.entitlements"
DAEMON="$APP/Contents/Resources/lobu-device-daemon/lobu-device-daemon"
"$ROOT/scripts/verify-mac-device-daemon.sh" "$DAEMON" >/dev/null

# Xcode + SPM Sparkle: re-seal nested helpers (same leaf-first order as CI).
echo ">> Re-signing Sparkle helpers..."
SPARKLE="$APP/Contents/Frameworks/Sparkle.framework/Versions/B"
OPTS=(--force --options runtime --timestamp --sign "$SIGN_ID")

# Xcode treats the daemon as a resource, so seal its Mach-O explicitly before
# re-signing the umbrella app that records the nested signature. Both CLI and
# daemon are standalone Bun executables needing MAP_JIT executable memory under
# Hardened Runtime.
codesign "${OPTS[@]}" --entitlements "$AUTH_ENTITLEMENTS" "$AUTH_CLI"
codesign "${OPTS[@]}" --entitlements "$AUTH_ENTITLEMENTS" "$DAEMON"
"$ROOT/scripts/verify-mac-device-daemon.sh" "$DAEMON" >/dev/null

resign_xpc() {
  local name="$1"
  local dir="$SPARKLE/XPCServices/${name}.xpc"
  [ -d "$dir" ] || return 0
  codesign "${OPTS[@]}" "$dir/Contents/MacOS/$name"
  codesign "${OPTS[@]}" "$dir"
}

resign_xpc Downloader
resign_xpc Installer
if [ -d "$SPARKLE/Updater.app" ]; then
  codesign "${OPTS[@]}" "$SPARKLE/Updater.app/Contents/MacOS/Updater"
  codesign "${OPTS[@]}" "$SPARKLE/Updater.app"
fi
[ -f "$SPARKLE/Autoupdate" ] && codesign "${OPTS[@]}" "$SPARKLE/Autoupdate"
codesign "${OPTS[@]}" "$APP/Contents/Frameworks/Sparkle.framework"
codesign "${OPTS[@]}" "$APP"
codesign --verify --deep --strict "$APP"

echo ">> Built: $APP"

if [ "${INSTALL:-}" = "1" ]; then
  # Cutover from the pre-rename bundle: Owletto.app and Lobu.app share the
  # bundle identifier, so a leftover Owletto.app would collide with the new
  # install (LaunchServices + the single-instance guard). Retire it first.
  # Login Items registration is per bundle ID, so it carries over untouched.
  echo ">> Quitting running copies (Lobu and legacy Owletto)..."
  osascript -e 'tell application "Lobu" to quit' 2>/dev/null || true
  osascript -e 'tell application "Owletto" to quit' 2>/dev/null || true
  sleep 1
  if [ -d /Applications/Owletto.app ]; then
    echo ">> Retiring legacy /Applications/Owletto.app (superseded by Lobu.app)"
    rm -rf /Applications/Owletto.app
  fi
  rm -rf /Applications/Lobu.app
  cp -R "$APP" /Applications/Lobu.app
  echo ">> Installed: /Applications/Lobu.app"
fi

if [ "${OPEN:-}" = "1" ]; then
  if [ "${INSTALL:-}" = "1" ]; then
    open /Applications/Lobu.app
  else
    open "$APP"
  fi
fi
