#!/usr/bin/env bash
# Provisions a Daytona ephemeral sandbox with the Lobu CI toolchain.
#
# Runs ONLY inside the sandbox (gate-runner.sh sources this when
# GATE_PROVISION=1). Installs the toolchain ci.yml jobs expect, starts a
# local Postgres + pgvector, and leaves DATABASE_URL exported for the gate
# run. Idempotent: safe to re-run.
#
# Assumes a Debian/Ubuntu-flavored image with apt and (root or passwordless
# sudo). curl/git are expected; everything else is installed here.

set -euo pipefail

gate_provision() {
  local SUDO="sudo"
  # Root containers usually lack sudo; the postgres steps need
  # `sudo -u postgres`, so ensure it exists before anything else.
  if [ "$(id -u)" = "0" ] && ! command -v sudo >/dev/null 2>&1; then
    apt-get update -o Acquire::Retries=3 -qq >/dev/null
    apt-get install -y --no-install-recommends sudo >/dev/null
  fi

  echo ">> [provision] apt update + base tools..."
  $SUDO apt-get update -o Acquire::Retries=3 -qq >/dev/null
  # make/gcc/python: `make build-packages` and native postinstalls need them;
  # the GitHub runner image ships these, the bare ubuntu base does not.
  $SUDO apt-get install -y --no-install-recommends     curl ca-certificates xz-utils unzip git jq make gcc g++ python3 >/dev/null

  echo ">> [provision] bun 1.3.5..."
  if ! command -v bun >/dev/null 2>&1 || ! bun --version 2>/dev/null | grep -q '^1.3.5'; then
    curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.5"
  fi
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  bun --version

  echo ">> [provision] node 22 (apt node is too old)..."
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
    curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.xz
    $SUDO tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
    rm -f /tmp/node.tar.xz
  fi
  node --version

  echo ">> [provision] Postgres 16 + pgvector (DB jobs)..."
  if ! command -v psql >/dev/null 2>&1; then
    $SUDO apt-get install -y --no-install-recommends postgresql postgresql-16-pgvector >/dev/null
  fi
  # Start the cluster (service on systemd images, pg_ctlcluster otherwise).
  $SUDO service postgresql start >/dev/null 2>&1 || $SUDO pg_ctlcluster 16 main start >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    $SUDO -u postgres pg_isready -q && break
    sleep 1
  done
  # Password auth for TCP (Debian default pg_hba is scram on 127.0.0.1).
  $SUDO -u postgres psql -q -c "ALTER USER postgres PASSWORD 'postgres'"
  # Fresh databases per CI job family + vector extension.
  $SUDO -u postgres createdb lobu_test 2>/dev/null || true
  $SUDO -u postgres createdb lobu_ci 2>/dev/null || true
  for db in lobu_test lobu_ci; do
    $SUDO -u postgres psql -q -d "$db" -c "CREATE EXTENSION IF NOT EXISTS vector"
  done
  # The baseline ivfflat index needs ~150MB maintenance_work_mem; default 64MB fails.
  $SUDO -u postgres psql -q -c "ALTER SYSTEM SET maintenance_work_mem='256MB'" -c "SELECT pg_reload_conf()"

  echo ">> [provision] dbmate (migrations ledger verify)..."
  if ! command -v dbmate >/dev/null 2>&1; then
    curl -fsSL --retry 5 --retry-delay 2       -o /tmp/dbmate       https://github.com/amacneil/dbmate/releases/download/v2.21.0/dbmate-linux-amd64
    $SUDO mv /tmp/dbmate /usr/local/bin/dbmate
    $SUDO chmod +x /usr/local/bin/dbmate
  fi

  echo ">> [provision] google-chrome-stable (frontend cold-boot smoke)..."
  if ! command -v google-chrome-stable >/dev/null 2>&1 && [ ! -x /usr/bin/google-chrome-stable ]; then
    # Best-effort: gate_frontend skips the cold-boot smoke when Chrome is
    # missing, so a Chrome install failure must never abort the whole gate.
    curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      && $SUDO apt-get install -y /tmp/chrome.deb >/dev/null 2>&1 \
      || { $SUDO dpkg -i /tmp/chrome.deb >/dev/null 2>&1 || true; $SUDO apt-get -f install -y >/dev/null 2>&1 || true; }
    rm -f /tmp/chrome.deb 2>/dev/null || true
  fi

  # The gate's migrations job applies against this sandbox's postgres — the
  # local-fallback path requires this marker so a dev DB is never mutated.
  export GATE_APPLY_MIGRATIONS=1

  echo ">> [provision] workspace dependencies (bun install)..."
  bun install
  # The package cache is only needed at install time; the sandbox disk cap is
  # 10GB and the workspace alone needs ~3.2GB, so reclaim the cache now.
  rm -rf "${BUN_INSTALL:-$HOME/.bun}/install/cache" 2>/dev/null || true

  export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5432/lobu_test?sslmode=disable"
  echo ">> [provision] done — DATABASE_URL=$DATABASE_URL"
}
