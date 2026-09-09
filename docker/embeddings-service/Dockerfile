# ===========================================
# Embeddings Service (embeddings)
# ===========================================

# Keep container builds on the same Bun version as the workflow lanes instead
# of resolving a different `latest` release when a layer must be rebuilt.
ARG BUN_VERSION=1.3.5

FROM node:22-slim AS builder
ARG BUN_VERSION

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}" \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

COPY bun.lock package.json tsconfig.json ./
COPY patches/ ./patches/
COPY packages/embeddings/package.json packages/embeddings/

# Stub workspaces not needed at build time
RUN mkdir -p packages/cli packages/core \
               packages/server packages/lobu-cli packages/connectors \
               packages/browser-extension packages/plugin-api packages/plugin-host packages/connector-sdk \
               packages/owletto packages/connector-worker packages/mcpsandbox \
    && for p in cli core server connectors \
                browser-extension plugin-api plugin-host connector-sdk owletto connector-worker mcpsandbox; do \
        echo "{\"name\":\"@lobu/$p\",\"version\":\"0.0.0\",\"private\":true}" > "packages/$p/package.json"; \
      done \
    && echo '{"name":"lobu","version":"0.0.0","private":true}' > packages/lobu-cli/package.json

RUN --mount=type=cache,target=/root/.bun/install/cache bun install

COPY packages/embeddings/ packages/embeddings/

RUN cd packages/embeddings && bunx tsc --noEmit

# ===========================================
# Runtime
# ===========================================
FROM node:22-slim AS runtime
ARG BUN_VERSION

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s -- "bun-v${BUN_VERSION}" \
    && chmod +x /usr/local/bin/bun

ENV PATH="/usr/local/bin:${PATH}"

# Pinned UID and numeric final USER so the kubelet can verify
# runAsNonRoot (a named USER fails CreateContainerConfigError
# "non-numeric user"). Keep in sync with
# embeddings.containerSecurityContext.runAsUser in charts/lobu.
RUN useradd -m -u 1001 -s /bin/bash embeddings && \
    mkdir -p /app/.cache/transformers && \
    chown -R embeddings:embeddings /app

COPY --from=builder --chown=embeddings:embeddings /app/node_modules ./node_modules
COPY --from=builder --chown=embeddings:embeddings /app/package.json ./
COPY --from=builder --chown=embeddings:embeddings /app/packages/embeddings ./packages/embeddings

ENV NODE_ENV=production
ENV TRANSFORMERS_CACHE=/app/.cache/transformers

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER 1001
WORKDIR /app/packages/embeddings

CMD ["bun", "src/server.ts"]
