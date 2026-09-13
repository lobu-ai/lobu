# ===========================================
# Lobu API + Frontend (server)
# ===========================================
# Hono server that runs the gateway in-process and serves the web frontend.

# Keep container builds on the same Bun version as the workflow lanes instead
# of resolving a different `latest` release when a layer must be rebuilt.
ARG BUN_VERSION=1.3.5

FROM node:22-slim AS builder
ARG BUN_VERSION
# 1 keeps the embedded-postgres + pgvector runtime (preview envs use
# DATABASE_URL=file://); 0 (default, prod) prunes them after the build.
ARG KEEP_EMBEDDED_PG=0

WORKDIR /app

# Bun for workspace install + tsc. git needed because some deps ship git URLs.
# python3 + build-essential needed for isolated-vm native build (node-gyp).
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

# Workspace package manifests needed to resolve the backend + its deps.
COPY packages/core/package.json packages/core/
COPY packages/plugin-api/package.json packages/plugin-api/
COPY packages/plugin-host/package.json packages/plugin-host/
COPY packages/plugin-toolkit/package.json packages/plugin-toolkit/
COPY packages/plugin-memory/package.json packages/plugin-memory/
COPY packages/plugin-conversations/package.json packages/plugin-conversations/
COPY packages/plugin-media/package.json packages/plugin-media/
COPY packages/plugin-mcp/package.json packages/plugin-mcp/
COPY packages/server/package.json packages/server/
COPY packages/connector-sdk/package.json packages/connector-sdk/
COPY packages/connectors/package.json packages/connectors/
COPY packages/embeddings/package.json packages/embeddings/
COPY packages/connector-worker/package.json packages/connector-worker/
# The CLI ships in this image so self-hosters can run
# `docker exec <container> lobu ...` (#2231). Real manifest, not a stub, so
# bun install resolves its dependencies below.
COPY packages/cli/package.json packages/cli/
# server depends on @lobu/pgvector-embedded (workspace:*); its manifest must be
# present for bun install to resolve the workspace member and for tsc to find
# its types. Prod never loads it at runtime (external Postgres) — it's pruned
# from the runtime node_modules below.
COPY packages/pgvector-embedded/package.json packages/pgvector-embedded/
# packages/owletto is a private git submodule. The glob lets the copy succeed
# when the submodule is not initialized (external contributors / backend-only builds).
COPY packages/owletto/package.jso[n] packages/owletto/

# Stub out workspace packages we don't build in this image so bun install doesn't
# error on missing manifests.
RUN mkdir -p packages/lobu-cli packages/browser-extension packages/mcpsandbox \
    && for p in browser-extension mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"lobu","version":"0.0.0","private":true}' > packages/lobu-cli/package.json

# Hoisted layout (npm-style flat node_modules) is required so the bundled
# server.bundle.mjs (built below) can resolve transitive npm deps via Node's
# resolver. Bun's default isolated linker uses .bun/<pkg>@<ver>/ paths that
# Node doesn't understand.
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --linker=hoisted

# Force rebuild of source layers
ARG CACHEBUST=default
ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown
RUN echo "Build: ${CACHEBUST}" && date > /tmp/.build-time

# Source code
COPY config/ config/
COPY packages/core/ packages/core/
COPY packages/plugin-api/ packages/plugin-api/
COPY packages/plugin-host/ packages/plugin-host/
COPY packages/plugin-toolkit/ packages/plugin-toolkit/
COPY packages/plugin-memory/ packages/plugin-memory/
COPY packages/plugin-conversations/ packages/plugin-conversations/
COPY packages/plugin-media/ packages/plugin-media/
COPY packages/plugin-mcp/ packages/plugin-mcp/
COPY packages/connector-sdk/ packages/connector-sdk/
COPY packages/connectors/ packages/connectors/
COPY packages/embeddings/ packages/embeddings/
COPY packages/connector-worker/ packages/connector-worker/
COPY packages/pgvector-embedded/ packages/pgvector-embedded/
COPY packages/server/ packages/server/
COPY packages/cli/ packages/cli/
COPY scripts/runtime-components.mjs scripts/runtime-components.mjs
# Bundled into the CLI dist by packages/cli/scripts/build.cjs: the starter
# skill and the embedded-DB migrations.
COPY skills/lobu/ skills/lobu/
COPY db/migrations db/migrations
# Copy the private frontend submodule when present.
COPY packages/owletto packages/owletto

# Build dist for shared workspace packages whose `exports` map points at
# dist subpaths. server and worker import these packages from their dist barrels.
RUN cd packages/core && bunx tsc \
    && cd ../plugin-api && bunx tsc \
    && cd ../plugin-host && bunx tsc \
    && cd ../plugin-toolkit && bunx tsc \
    && cd ../plugin-memory && bunx tsc \
    && cd ../plugin-conversations && bunx tsc \
    && cd ../plugin-media && bunx tsc \
    && cd ../plugin-mcp && bunx tsc \
    && cd ../connector-sdk && bunx tsc \
    && cd ../embeddings && bunx tsc \
    `# connector-worker alone needs its full build, not tsc: the script also` \
    `# runs build-guest-bundle, and build:server below copies that bundle out` \
    `# of its dist. .dockerignore keeps dist out of the image, so tsc-only` \
    `# left the copy with no source and failed the image build.` \
    && cd ../connector-worker && bun run build \
    && cd ../pgvector-embedded && bunx tsc

# Type check
RUN cd packages/server && bunx tsc --noEmit

# Bundle the backend so prod runs under Node (so isolated-vm loads). See
# docker/app/start.sh and packages/server/scripts/build-server-bundle.mjs
# for the full rationale.
RUN cd packages/server && bun run build:server

# Build the CLI (#2231). It must build after build:server because
# packages/cli/scripts/build.cjs prepares the separate runtime artifacts. It runs *before* the owletto web build, so the CLI dist
# intentionally carries no second copy of the SPA — the container already
# serves the web UI from packages/owletto/dist, which the bundled server finds
# through its monorepo-relative fallback.
RUN cd packages/cli && bun run build

# Prune the embedded-Postgres runtime (~145MB platform binary) before it reaches
# the runtime image. Prod always uses an external DATABASE_URL (postgres://), so
# server.ts never loads embedded-postgres or the pgvector injector — both are
# reached only via await import() on the file:// path. The builder needs them
# for the type-check + bundle above, so we drop them only afterward. This also
# means the in-image `lobu run` cannot boot an embedded database; it must use
# the container's external DATABASE_URL.
RUN if [ "$KEEP_EMBEDDED_PG" = "1" ]; then \
      mkdir -p packages/server/dist/vendor/pgvector-embedded \
      && cp -r packages/pgvector-embedded/dist packages/pgvector-embedded/prebuilt packages/pgvector-embedded/package.json packages/server/dist/vendor/pgvector-embedded; \
    fi
RUN if [ "$KEEP_EMBEDDED_PG" != "1" ]; then \
      rm -rf node_modules/embedded-postgres node_modules/@embedded-postgres; \
    fi

# Build frontend static assets (production only)
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
# Vite inlines these at build time (import.meta.env). Without VITE_SENTRY_DSN
# baked in here the prod SPA's initSentry() short-circuits and frontend errors
# never reach Sentry. Safe no-op when the build-arg is empty.
ARG VITE_SENTRY_DSN=
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ARG VITE_ENVIRONMENT=production
ENV VITE_ENVIRONMENT=$VITE_ENVIRONMENT
ARG SKIP_WEB_BUILD=false
RUN if [ "$SKIP_WEB_BUILD" = "false" ] && [ -f packages/owletto/package.json ]; then \
      cd packages/owletto && bun run build && bun run build:mcp-apps; \
    else \
      mkdir -p /app/packages/owletto/dist; \
    fi

# Keep browser automation available while building/testing, then remove its
# installed packages by manifest identity before copying the production graph.
COPY scripts/image-browser-tooling.mjs scripts/image-browser-tooling.mjs
RUN node scripts/image-browser-tooling.mjs --prune /app

# ===========================================
# Runtime
# ===========================================
FROM node:22-slim AS runtime
ARG BUN_VERSION

WORKDIR /app

# curl for health checks, git/gh for GitHub connector agent tooling, bun for
# tsx-equivalent and native runtime dependencies.
#
# `gh` stays because the GitHub connector declares it (`nix: { packages: ['gh'] }`)
# and a nix-less host still needs it on PATH. bubblewrap is gone: it existed to
# give the managed worker subprocess an exec sandbox before it would register
# spawned binaries, and nothing probes for one now that turns run in-isolate.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git gh unzip socat \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}" \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

# Copy installed deps + source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/tsconfig.json ./
COPY --from=builder /app/config ./config
COPY --from=builder /app/packages/core ./packages/core
COPY --from=builder /app/packages/plugin-api ./packages/plugin-api
COPY --from=builder /app/packages/plugin-host ./packages/plugin-host
COPY --from=builder /app/packages/plugin-toolkit ./packages/plugin-toolkit
COPY --from=builder /app/packages/plugin-memory ./packages/plugin-memory
COPY --from=builder /app/packages/plugin-conversations ./packages/plugin-conversations
COPY --from=builder /app/packages/plugin-media ./packages/plugin-media
COPY --from=builder /app/packages/plugin-mcp ./packages/plugin-mcp
COPY --from=builder /app/packages/connector-sdk ./packages/connector-sdk
COPY --from=builder /app/packages/connectors ./packages/connectors
COPY --from=builder /app/packages/embeddings ./packages/embeddings
COPY --from=builder /app/packages/connector-worker ./packages/connector-worker
COPY --from=builder /app/packages/server ./packages/server
# The lobu CLI (#2231): self-hosters run `docker exec <container> lobu ...`.
# bin/lobu.js resolves ../dist relative to its realpath and walks up to the
# hoisted /app/node_modules, so a symlink onto PATH is all it needs.
COPY --from=builder /app/packages/cli ./packages/cli
RUN ln -s /app/packages/cli/bin/lobu.js /usr/local/bin/lobu
COPY --from=builder /app/packages/owletto ./packages/owletto
COPY --from=builder /app/scripts/image-browser-tooling.mjs ./scripts/image-browser-tooling.mjs
RUN node scripts/image-browser-tooling.mjs --check /app

# Database migrations (+ statement-at-a-time runner for transaction:false)
COPY db/migrations ./db/migrations
COPY scripts/migrate-up.mjs ./scripts/migrate-up.mjs

# Build metadata + environment defaults
ARG APP_GIT_SHA=unknown
ARG APP_BUILD_TIME=unknown
ENV NODE_ENV=production
ENV APP_GIT_SHA=${APP_GIT_SHA}
ENV APP_BUILD_TIME=${APP_BUILD_TIME}

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8787/health || exit 1

# Startup script
COPY docker/app/start.sh /app/start.sh
RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]
