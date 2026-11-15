#!/usr/bin/env bash
set -euo pipefail

# node_modules contains native addons, so a lockfile alone is not its identity.
# Derive every CI consumer's key here from the runtime that installs/loads it.
# v2 also quarantines caches populated before runtime isolation was enforced.
LOCK=${1:?Usage: ci-dependency-cache-key.sh <lockfile-hash>}
RUNTIME=$(node -p '[process.platform, process.arch, process.versions.modules].join("-")')
BUN_VERSION=$(bun --version)
printf 'bun-v2-%s-%s-%s\n' "$RUNTIME" "$BUN_VERSION" "$LOCK"
