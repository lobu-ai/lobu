#!/usr/bin/env bash
# Build the version-pinned auth helper embedded in Lobu.app.
#
# Usage:
#   scripts/build-mac-auth-cli.sh /path/to/Lobu.app/Contents/Resources/lobu-cli/bin/lobu
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-}"
TARGET="${LOBU_MAC_AUTH_TARGET:-bun-darwin-arm64}"

if [ -z "$OUTPUT" ]; then
  echo "usage: scripts/build-mac-auth-cli.sh <output-path>" >&2
  exit 2
fi

VERSION="$(cd "$ROOT" && bun -p 'require("./packages/cli/package.json").version')"
mkdir -p "$(dirname "$OUTPUT")"

(
  cd "$ROOT"
  export LOBU_MAC_AUTH_CLI_VERSION="$VERSION"
  bun build packages/cli/src/mac-auth.ts \
    --compile \
    --target="$TARGET" \
    '--env=LOBU_MAC_AUTH_CLI_*' \
    --outfile="$OUTPUT"
)

chmod 755 "$OUTPUT"
