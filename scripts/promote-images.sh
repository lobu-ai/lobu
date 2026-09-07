#!/usr/bin/env bash
# Publish the exact candidate digests after their required image checks pass.
# Flux watches only the app timestamp tag, so publish its siblings first.
set -euo pipefail

: "${APP_IMAGE:?APP_IMAGE must be an immutable image reference}"
: "${WORKER_IMAGE:?WORKER_IMAGE must be an immutable image reference}"
: "${EMBEDDINGS_IMAGE:?EMBEDDINGS_IMAGE must be an immutable image reference}"
: "${DEPLOY_TAG:?DEPLOY_TAG is required}"
: "${IS_STABLE:?IS_STABLE is required}"

# Require digest-pinned refs and valid tag controls before publishing any tag.
# A missing build-job output must never fall through to a mutable tag.
for image in "$WORKER_IMAGE" "$EMBEDDINGS_IMAGE" "$APP_IMAGE"; do
  if [[ ! "$image" =~ ^[^@[:space:]]+@sha256:[a-f0-9]{64}$ ]]; then
    echo "ERROR: promotion requires an image pinned by sha256" >&2
    exit 1
  fi
done
if [[ ! "$DEPLOY_TAG" =~ ^[0-9]{8}-[0-9]{6}-[0-9]{6}$ ]]; then
  echo "ERROR: invalid deployment tag" >&2
  exit 1
fi
case "$IS_STABLE" in
  true) : "${SEMVER:?a stable release requires SEMVER}" ;;
  false) ;;
  *) echo "ERROR: IS_STABLE must be true or false" >&2; exit 1 ;;
esac

# docker/metadata-action, which previously published these tags, replaces the
# `+` in SemVer build metadata because it is not valid in a Docker tag.
semver_tag=${SEMVER:-}
semver_tag=${semver_tag//+/-}
if [[ -n "$semver_tag" && ! "$semver_tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "ERROR: invalid semver image tag" >&2
  exit 1
fi

for image in "$WORKER_IMAGE" "$EMBEDDINGS_IMAGE" "$APP_IMAGE"; do
  repository=${image%@*}
  tags=(--tag "$repository:$DEPLOY_TAG")
  if [[ -n "$semver_tag" ]]; then
    tags+=(--tag "$repository:$semver_tag")
  fi
  if [[ "$IS_STABLE" == true ]]; then
    tags+=(--tag "$repository:latest")
  fi
  # A single source is copied, including its multi-platform index. For a
  # single manifest, avoid wrapping it in a new index and changing its digest.
  docker buildx imagetools create --prefer-index=false "${tags[@]}" "$image"
done
