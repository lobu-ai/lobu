# Browser tooling is confined to this credential-free runner, never the API image.
FROM oven/bun:1.4.4-debian
LABEL org.opencontainers.image.source="https://github.com/lobu-ai/lobu"
WORKDIR /app
COPY docker/view-validator/package.json docker/view-validator/bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts \
    && bun node_modules/playwright-vanilla/cli.js install --with-deps chromium
COPY docker/view-validator/service.ts docker/view-validator/validate.ts docker/view-validator/smoke.ts docker/view-validator/
COPY packages/server/src/views/validation-contract.ts packages/server/src/views/
RUN mkdir -p /tmp/validator && chown bun:bun /tmp/validator
ENV HOME=/tmp/validator
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
# Browser installation must be readable by the non-root runner.
RUN mv /root/.cache/ms-playwright /opt/browsers && chmod -R a+rX /opt/browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
USER bun
EXPOSE 8090
CMD ["bun", "docker/view-validator/service.ts"]
