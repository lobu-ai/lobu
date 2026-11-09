#!/usr/bin/env bash
# Assert that a prebuilt Linux pgvector library does not require a newer glibc
# than we promise to support.
#
# Why this exists: a shared library links against the glibc it was compiled on
# and refuses to load on anything older, so the BUILD HOST's glibc silently
# becomes the product's support floor. `build-pgvector-embedded.yml` used
# `ubuntu-latest`; when that label moved to 24.04 (glibc 2.39) the published
# `vector.so` picked up `__isoc23_strtol@GLIBC_2.38` — the gcc-13 uplift of
# plain `strtol` — and `lobu run` stopped being able to boot embedded Postgres
# on Debian 12 (including `node:26-slim`), Ubuntu 22.04 LTS, RHEL 9 and AL2023:
#
#   could not load library ".../vector.so": /lib/x86_64-linux-gnu/libc.so.6:
#   version `GLIBC_2.38' not found
#
# Nothing else catches it. CI only ever loads this library on a modern-glibc
# runner, so the artifact looks fine right up until a user on an older distro
# runs the quickstart from the landing page.
#
# Usage: assert-glibc-floor.sh <dir-containing-vector.so> [max-glibc-version]
set -euo pipefail

DIR="${1:?usage: assert-glibc-floor.sh <prebuilt-platform-dir> [max-glibc]}"

# debian:bullseye / Ubuntu 20.04. Also clears RHEL 9 (2.34), AL2023 (2.34),
# Ubuntu 22.04 (2.35) and Debian 12 (2.36). Raising this number is a product
# decision that drops distros — it is not a way to make a red build green.
MAX_GLIBC="${2:-2.31}"

LIB="${DIR}/vector.so"
if [[ ! -f "${LIB}" ]]; then
  echo "ERROR: no vector.so in ${DIR}" >&2
  exit 1
fi

# `strings` over the dynamic-symbol version table. Every versioned reference
# shows up as GLIBC_<major>.<minor>; the highest one is the effective floor.
# Kept to bash 3.2 constructs (no mapfile, no negative index) so this also runs
# on a stock macOS shell — the artifacts get inspected from dev machines too.
VERSIONS="$(strings "${LIB}" | grep -oE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' | sort -Vu | tr '\n' ' ')"
VERSIONS="${VERSIONS% }"

if [[ -z "${VERSIONS}" ]]; then
  echo "ERROR: no GLIBC_* version symbols found in ${LIB} — refusing to pass." >&2
  echo "       Either the file is not an ELF shared object or \`strings\` is missing;" >&2
  echo "       both mean this gate is not actually checking anything." >&2
  exit 1
fi

HIGHEST="$(printf '%s\n' ${VERSIONS} | sort -V | tail -1)"
HIGHEST="${HIGHEST#GLIBC_}"

# sort -V puts the larger version last; if that is still MAX_GLIBC, we are fine.
if [[ "$(printf '%s\n%s\n' "${HIGHEST}" "${MAX_GLIBC}" | sort -V | tail -1)" != "${MAX_GLIBC}" ]]; then
  echo "ERROR: ${LIB} requires GLIBC_${HIGHEST}, above the ${MAX_GLIBC} floor." >&2
  echo "       Required versions: ${VERSIONS}" >&2
  echo "" >&2
  echo "       This library would fail to load for users on older distros." >&2
  echo "       Offending symbols:" >&2
  # Show what actually forced the uplift so the fix is obvious.
  if command -v readelf >/dev/null 2>&1; then
    readelf --dyn-syms --wide "${LIB}" 2>/dev/null \
      | grep -F "GLIBC_${HIGHEST}" | awk '{print "         " $8}' | sort -u >&2 || true
  fi
  echo "" >&2
  echo "       Fix: build on an older base (the workflow pins debian:bullseye)," >&2
  echo "       do NOT raise the floor to make this pass." >&2
  exit 1
fi

echo "==> ${LIB}: max GLIBC_${HIGHEST} <= floor GLIBC_${MAX_GLIBC} (found: ${VERSIONS})"
