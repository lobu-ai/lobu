#!/usr/bin/env bash
# E2E verification for chrome tab cleanup (PR1-lite).
# Runs automated tests + gateway health + optional live extension check.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

port=8787
if [[ -f .env.local ]]; then
  p="$(awk -F= '/^PORT=/{print $2; exit}' .env.local | tr -d '[:space:]')"
  [[ -n "$p" ]] && port="$p"
fi
url="http://127.0.0.1:${port}"

echo "==> [1/4] Owletto chrome unit tests"
(cd packages/owletto/apps/chrome && bun test tools.test.js)

echo "==> [2/4] Connector SDK extension-network tests"
bun test packages/connector-sdk/src/__tests__/extension-network.test.ts

echo "==> [3/4] Gateway health (${url})"
curl -sf "${url}/api/health" | head -c 200
echo ""

db_url=""
if [[ -f .env.local ]]; then
  db_url="$(awk -F= '/^DATABASE_URL=/{print $2; exit}' .env.local | tr -d '[:space:]')"
fi
if [[ -z "$db_url" && -f .env ]]; then
  db_url="$(awk -F= '/^DATABASE_URL=/{print $2; exit}' .env | tr -d '[:space:]')"
fi
if [[ -z "$db_url" ]]; then
  # make dev prints DATABASE_URL from dev-db.sh; derive the same name here.
  db_url="$(NAME="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo dev)" \
    PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5418}" PGUSER="${PGUSER:-$USER}" \
    bash -c 'source scripts/lib/db-name.sh 2>/dev/null; echo "postgres://${PGUSER}@${PGHOST}:${PGPORT}/$(lobu_db_name "${NAME:-dev}")"')"
fi

echo "==> [4/4] Extension pairing status"
if [[ -n "$db_url" ]]; then
  online="$(psql "$db_url" -tAc \
    "SELECT COUNT(*) FROM device_workers WHERE platform='chrome-extension' AND last_seen_at > now() - interval '20 minutes'" 2>/dev/null || echo 0)"
  if [[ "${online:-0}" -gt 0 ]]; then
    echo "    extension online (${online} worker(s)) — live chrome ops available"
    echo "    run: lobu memory run run_sdk with operations.execute on chrome connection"
  else
    echo "    no online chrome-extension in this DB"
    echo "    pair: make e2e-browser"
  fi
else
  echo "    DATABASE_URL not found — skip DB pairing check"
fi

echo ""
echo "OK automated e2e checks passed"