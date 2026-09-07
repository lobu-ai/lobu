# ===========================================
# Lobu Worker (connector-worker daemon)
# ===========================================
# Self-hosted worker for Lobu connectors and embedding generation.

# Keep container builds on the same Bun version as the workflow lanes instead
# of resolving a different `latest` release when a layer must be rebuilt. Bun
# is a build tool here (workspace install + tsc); the runtime stage is Node
# only, because the connector isolate lane's `isolated-vm` is a V8 native
# addon Bun cannot dlopen.
ARG BUN_VERSION=1.3.5

FROM node:22-bookworm AS builder
ARG BUN_VERSION

WORKDIR /app

# python3 + build-essential: isolated-vm (the connector isolate lane's V8
# addon) falls back to a node-gyp build when no prebuild matches this Node
# line/arch. Mirrors docker/app/Dockerfile.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
      python3 build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}" \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

# Root workspace files
COPY bun.lock package.json tsconfig.json ./
COPY patches/ ./patches/

# Manifests for the worker and its workspace deps. core is a real
# build-time dep (connector-sdk imports @lobu/core), so its package.json
# must be the real one — not a stub.
COPY packages/connector-worker/package.json packages/connector-worker/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/connectors/package.json packages/connectors/
COPY packages/embeddings/package.json packages/embeddings/
COPY packages/core/package.json packages/core/
# The agent guest bundled into connector-worker's dist imports these; they are
# build-time only (devDependencies) and never run in the image.
COPY packages/plugin-api/package.json packages/plugin-api/
COPY packages/plugin-host/package.json packages/plugin-host/
COPY packages/plugin-toolkit/package.json packages/plugin-toolkit/
COPY packages/plugin-memory/package.json packages/plugin-memory/
COPY packages/plugin-conversations/package.json packages/plugin-conversations/
COPY packages/plugin-media/package.json packages/plugin-media/

# Stub workspaces not needed at build time
RUN mkdir -p packages/cli \
               packages/server packages/lobu-cli \
               packages/owletto packages/agent-worker packages/mcpsandbox \
    && for p in cli server \
                owletto agent-worker mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"@lobu/worker","version":"0.0.0","private":true}' > packages/agent-worker/package.json \
    && echo '{"name":"lobu","version":"0.0.0","private":true}' > packages/lobu-cli/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache bun install

# Source code (core needed because connector-sdk imports @lobu/core)
COPY packages/core/ packages/core/
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/connectors/ packages/connectors/
COPY packages/embeddings/ packages/embeddings/
COPY packages/plugin-api/ packages/plugin-api/
COPY packages/plugin-host/ packages/plugin-host/
COPY packages/plugin-toolkit/ packages/plugin-toolkit/
COPY packages/plugin-memory/ packages/plugin-memory/
COPY packages/plugin-conversations/ packages/plugin-conversations/
COPY packages/plugin-media/ packages/plugin-media/
COPY packages/connector-worker/ packages/connector-worker/

# Build workspace dists required by runtime imports.
# connector-sdk imports @lobu/core; connector-worker/src/embeddings.ts imports
# @lobu/embeddings, whose package exports point at dist/. The plugin packages
# are what the agent guest imports; they build before connector-worker, whose
# `bun run build` (tsc + guest bundle) then writes dist/agent-turn/guest.bundle.js
# — the file the daemon loads, so the plugins are not needed at runtime.
# connector-worker itself builds last: the runtime runs its dist under Node
# (`bin.js` plus the fork()ed `executor/child-runner.js`), never TypeScript source.
RUN cd packages/core && bunx tsc \
    && cd ../plugin-api && bunx tsc \
    && cd ../plugin-host && bunx tsc \
    && cd ../plugin-toolkit && bunx tsc \
    && cd ../plugin-memory && bunx tsc \
    && cd ../plugin-conversations && bunx tsc \
    && cd ../plugin-media && bunx tsc \
    && cd ../connector-sdk && bunx tsc \
    && cd ../embeddings && bunx tsc \
    && cd ../connector-worker && bun run build

# ===========================================
# Runtime
# ===========================================
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# No Bun in this stage: everything runs under the image's Node. curl stays for
# the chart's wait-for-app initContainer, which runs this image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      libimage-exiftool-perl \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libxshmfence1 libxfixes3 libglib2.0-0 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. Pinned UID and numeric final USER so the kubelet can
# verify runAsNonRoot — a named USER fails CreateContainerConfigError
# ("non-numeric user, cannot verify user is non-root"). Keep in sync
# with worker.containerSecurityContext.runAsUser in charts/lobu.
RUN useradd -m -u 1001 -s /bin/bash worker && \
    mkdir -p /app/.cache/transformers /ms-playwright && \
    chown -R worker:worker /app /ms-playwright

COPY --from=builder --chown=worker:worker /app/node_modules ./node_modules
COPY --from=builder --chown=worker:worker /app/package.json ./
COPY --from=builder --chown=worker:worker /app/tsconfig.json ./
# connector-sdk imports @lobu/core (logger/retry); the bun workspace symlink
# points at packages/core, so the runtime stage must include it or the symlink
# dangles -> "ENOENT reading .../connector-sdk/node_modules/@lobu/core" at feed
# sync. Mirrors docker/app/Dockerfile, which already copies core.
COPY --from=builder --chown=worker:worker /app/packages/core ./packages/core
COPY --from=builder --chown=worker:worker /app/packages/connector-sdk ./packages/connector-sdk
COPY --from=builder --chown=worker:worker /app/packages/connectors ./packages/connectors
COPY --from=builder --chown=worker:worker /app/packages/embeddings ./packages/embeddings
COPY --from=builder --chown=worker:worker /app/packages/connector-worker ./packages/connector-worker

# Install patchright's Chromium for browser-based connectors.
# The runtime resolves `require('playwright')` to patchright (the
# `npm:patchright` alias in package.json), so the installed Chromium revision
# MUST be patchright's, not vanilla playwright's. `bunx --bun playwright install`
# resolved to the vanilla `playwright` bin (node_modules/.bin/playwright ->
# playwright-vanilla/cli.js won the bin-name conflict) and installed a DIFFERENT
# revision (chromium-1223) than runtime patchright expects (chromium-1217) ->
# `Executable doesn't exist`. Invoke patchright's own cli (node_modules/playwright
# == patchright) so install revision == runtime revision by construction.
# PLAYWRIGHT_BROWSERS_PATH pins BOTH install target and runtime lookup to an
# absolute, HOME-independent path (default $HOME/.cache/ms-playwright differs by
# USER and breaks the connector child forked in another cwd). /ms-playwright is
# created + chowned to worker above; subprocess.ts forwards the var to the child.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER 1001
WORKDIR /app/packages/connector-worker
RUN node node_modules/playwright/cli.js install chromium
WORKDIR /app

ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

WORKDIR /app/packages/connector-worker

# Node, not Bun: the isolate lane loads the isolated-vm addon (built by
# node-gyp in the builder when no prebuild matches), which Bun cannot dlopen.
# CI runs `node dist/bin.js self-check --json` in this image and asserts
# `isolate_lane.available`. The chart's liveness probe greps "daemon" from
# PID 1's cmdline, so keep that argument.
CMD ["node", "dist/bin.js", "daemon"]
