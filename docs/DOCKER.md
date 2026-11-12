# Docker / Self-hosting

Lobu publishes a single Docker image — `ghcr.io/lobu-ai/lobu-app` — that ships the API gateway, embedded worker runtime, and admin SPA in one process. The same artifact powers Lobu Cloud's k8s deployment; nothing is k8s-specific at the image layer.

For most users we recommend running Lobu via the [`lobu run`](../README.md) CLI (no Docker needed). Self-hosting in Docker is for operators who want a long-lived deployment without orchestrator overhead.

## Quick start (Docker Compose)

```bash
# 1. Copy the example compose file
cp docker-compose.example.yml docker-compose.yml

# 2. Generate two secrets
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
# Paste both into docker-compose.yml (and rotate the postgres password)

# 3. Boot
docker compose up -d

# 4. Open
open http://localhost:8787
```

That's it. Sign up via the admin UI, add provider API keys from the settings page, create your first agent.

Running `lobu run` inside your own container instead of this image? It provisions a local operator on first boot, so you can sign in and mint tokens without a browser; see "Sign in without a browser" in the [CLI README](../packages/cli/README.md).

## What's actually required to boot

| Env var | Required? | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Postgres with `pgvector` extension. Server refuses to start without it. |
| `ENCRYPTION_KEY` | **Yes** | 32-byte base64. Encrypts secrets stored in Postgres (provider keys, OAuth tokens). Loses every encrypted secret if you change it after first boot. |
| `BETTER_AUTH_SECRET` | **Yes** | 32-byte base64. Signs admin session cookies. Auto-generated ephemerally in local dev; required in production. |
| `PUBLIC_GATEWAY_URL` | Recommended | Public gateway base URL (origin or origin + `/lobu`). Affects OAuth callbacks, webhooks, public-page links, and cookie domain. Defaults to `http://localhost:8787/lobu`. |
| `ANTHROPIC_API_KEY` | No | Only needed if you run Anthropic-backed agents. Add it from the admin UI after boot instead. It does **not** serve the LLM egress judge — see the row below. |
| `OPENAI_API_KEY` / `GROQ_API_KEY` / etc. | No | Same as Anthropic — set only the providers you want available, or add them via the admin UI at runtime. Admin-UI keys are **org-scoped and serve agent runs only**; the LLM egress judge reads system keys from this environment and nothing else, so a provider you want a judge model to use must be keyed **here**. |
| `WORKER_ALLOWED_DOMAINS` | Optional | Default empty = workers have no internet. Comma-separated allowlist, or `*` for unrestricted (not recommended in prod). See `.env.example` for the full pattern. |
| `LOBU_HTTP_EGRESS_ALLOW_HOSTS` | Optional | Default empty. Comma-separated **exact** hostnames or IP literals (no wildcards, CIDRs, ports, paths, or IPv6 brackets) that connector code may `fetch` even though they resolve to a private address, e.g. another container on your Docker network (`inventory-api,10.0.0.9`). Covers every connector run (feed sync, source reads, `query_sql` pushdown, operations, listeners, webhook registration); set it on the server and on any standalone connector-worker. Cloud metadata addresses stay refused, plaintext credentials go only to a named private IP literal or `localhost` (a named service must use HTTPS for them), and an invalid entry fails the run rather than widening anything. Ignored under `LOBU_CLOUD_MODE`. Database sockets use `LOBU_DB_EGRESS_ALLOW_HOSTS` instead (see `docs/database-connectors.md`). |

## Apple Silicon (M1/M2/M3) note

The published image is currently amd64-only. Docker on Apple Silicon refuses to pull mismatched-architecture images unless you opt into emulation. Uncomment the `platform: linux/amd64` line in `docker-compose.example.yml` to run it via Rosetta — slightly slower but functional. A multi-arch image is planned; once published, drop the override.

## Boot errors and how to read them

A failing boot now prints the actual error (type, message, stack, and Zod-validation issues). If you see:

- `DATABASE_URL is required` — set it.
- Postgres connection rejected — check the `?sslmode=disable` suffix on local clusters that don't have TLS.
- `ENCRYPTION_KEY is not set` — generate one with `openssl rand -base64 32`.
- `Migration X.Y.Z not applied` — your image expects a newer schema than the database has; pull the matching DB or set `SKIP_SCHEMA_VERSION_CHECK=1` for emergency forward-flight.

If the error still isn't actionable, open an issue with the full output.

## LLM provider support

Lobu is provider-agnostic. The bundled `config/providers.json` ships 17 providers including:

- Anthropic Claude
- OpenAI (GPT-4, GPT-4o, etc.)
- OpenAI-compatible: Groq, Together AI, Fireworks, OpenRouter, Cerebras, NVIDIA, xAI, DeepSeek, Mistral, Cohere, Perplexity, Gemini
- Specialized: OpenCode Zen

Add API keys via the admin UI (Settings → Providers) at runtime. No env-var required. Per-agent model selection picks among configured providers.

**Agent runtime**: Lobu's worker runs its native Pi-based agent loop per task. An Automation can still select a CLI agent kind where an Automation explicitly drives one. Runtime choice is independent from the LLM provider serving the agent.

## What's in the image

The Dockerfile lives at `docker/app/Dockerfile`. Three notable details:

1. **Single process.** Gateway, embedded worker runtime, admin SPA, and embeddings all run in one Node process. Workers spawn as `child_process.spawn` subprocesses on the same host. There's no separate worker container.
2. **Built artifact**, not a workspace install at runtime. The image bundles `dist/server.bundle.mjs` produced by esbuild — fast cold-start, no `bun install` at boot.
3. **No SPA bundled in the public image by default.** The admin SPA sources live in a private submodule (`packages/owletto`); the public image stubs them out so external contributors can build the backend without owletto access. To run the SPA, build from a checkout that has the submodule initialized, or use Lobu Cloud.

## Fleet worker image

Lobu Cloud's Helm chart (`charts/lobu`) runs connector workers as a separate Deployment built from `docker/worker/Dockerfile`; the self-hosting image above does not need it. Its runtime stage is Node only: the builder compiles `packages/connector-worker` with `tsc`, and the container's `CMD` is `node dist/bin.js daemon`. The worker runs under Node rather than Bun because the connector isolate lane loads `isolated-vm`, a V8 native addon Bun cannot `dlopen`. CI runs `node dist/bin.js self-check --json` inside the built image with `--network=none` and asserts `isolate_lane.available`, so a broken native build fails the image job instead of surfacing as failed isolate runs in prod.

## Bumping versions

Main-branch builds publish timestamp tags but no longer move `:latest`. Publishing a stable [GitHub Release](https://github.com/lobu-ai/lobu/releases) named `lobu-vX.Y.Z` publishes image tag `:X.Y.Z` and moves `:latest`; prereleases publish only their version tag. For reproducible deploys, pin a published version. Releases from before versioned image publishing was enabled are not backfilled automatically.

Migrations are applied at boot. If you roll back to an older image whose migrations dir is a strict prefix of what's already applied, set `SKIP_SCHEMA_VERSION_CHECK=1` once to get past the version assertion.

## Running behind a reverse proxy / public URL

`PUBLIC_GATEWAY_URL` is the canonical public gateway URL. Set it to your real public URL (e.g. `https://lobu.example.com` or `https://lobu.example.com/lobu`) so OAuth callbacks, webhook URLs, public-page bootstrap links, and cookie domain attribute match. Behind nginx/Caddy/Cloudflare — proxy `:8787` and terminate TLS at the proxy.

`FRAME_ANCESTORS` lets you embed the admin UI inside another origin if needed (Content-Security-Policy frame-ancestors directive). Set as a comma-separated list of allowed origins; leave unset to deny all framing.

### Path-based orgs (default) vs per-org subdomains

By default each organization lives on a path — `https://lobu.example.com/your-org`. This needs nothing beyond `PUBLIC_GATEWAY_URL` and works behind a single reverse proxy with one hostname and one certificate.

Set `AUTH_COOKIE_DOMAIN` only if you want each org on its own hostname (`your-org.lobu.example.com`). The value is the shared parent zone, with or without the leading dot:

```yaml
AUTH_COOKIE_DOMAIN: .lobu.example.com
```

That mode additionally requires wildcard DNS (`*.lobu.example.com`), a wildcard-capable certificate, and a proxy that forwards those hosts to the container. If any of the three is missing, leave `AUTH_COOKIE_DOMAIN` unset — the app stays on path-based URLs.

The server tells the frontend which mode is active at runtime, so this is a plain env change: no image rebuild, and nothing is inferred from the hostname you happen to serve on.

## Anonymous usage telemetry

A production server sends one anonymous ping a day to `https://telemetry.lobu.ai/v1/install`, so we can tell how many installs run which version. One ping goes out per installation, however many replicas you run. It contains:

- a random install id, generated on first use and stored in your database (`instance_identity`)
- the Lobu version and git SHA, how it was deployed (`docker`, `helm`, `cli` or `mac`), OS and CPU architecture, and process uptime as a range
- how many server replicas are connected to the database right now. This counts distinct client addresses, so replicas behind PgBouncer or another pooler show up as one.
- counts of workspaces, users, agents, connections, active Automations and Automation runs in the last 7 days, each sent only as a range (`0`, `1-5`, `6-20`, `21+`)

It never includes hostnames, URLs, emails, names, workspace or connector identifiers, or any content. The ping itself carries nothing that identifies you and we store no IP address with it, but like any HTTPS request it passes through our CDN, whose standard edge logs record request IPs for their usual retention.

The ping is a single best-effort request with a 5 second timeout. A failure is ignored until the next day and never affects the server.

To turn it off, set `LOBU_TELEMETRY=0` or `DO_NOT_TRACK=1`. It is already off when `NODE_ENV` is `development` or `test` and when `CI` is set. The server logs one line at startup while it is on. `LOBU_TELEMETRY_URL` sends the ping to a different endpoint instead.

## Production checklist

- [ ] Real `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` (NOT the example placeholders).
- [ ] Real postgres password.
- [ ] `PUBLIC_GATEWAY_URL` set to the real URL.
- [ ] TLS termination via reverse proxy or platform load balancer.
- [ ] Database backups configured (Lobu writes encrypted secrets there — losing the DB means losing every connected integration).
- [ ] `WORKER_ALLOWED_DOMAINS` reviewed for your use case.
- [ ] Provider API keys added through the admin UI (or env vars) for whichever providers you intend to use.


### Isolated view validation

`views.set` keeps its existing input and validates the exact candidate in a
credential-free browser runner before storing it. Set `VIEW_VALIDATOR_URL` to
its internal HTTP address. Browser failures return 422; missing, overloaded or
unavailable runners return 503. Both preserve the saved view. The API image
continues to exclude browser tooling.

The sample Compose file builds the runner separately on an internal network
with no published ports. Its pinned Chromium seccomp profile is vendored from
[Playwright v1.60.0](https://github.com/microsoft/playwright/blob/v1.60.0/utils/docker/seccomp_profile.json),
with one change: `chroot` is allowed without the outer `CAP_SYS_CHROOT`, so
Chromium's user-namespace sandbox starts after all capabilities are dropped.
The runner uses a non-root user with Chromium's sandbox enabled. Do not expose
its endpoint to public ingress or attach application credentials. The new GHCR
package must be made public through its package settings for anonymous pulls,
or the deployment must supply `imagePullSecrets`. Repository linkage grants
workflow access but does not inherit public visibility ([GitHub package access](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)).

For Kubernetes, install that profile as `profiles/lobu-view-validator.json`
beneath the kubelet seccomp directory on eligible nodes, verify the node permits
unprivileged user namespaces, then enable `viewValidator.enabled` in the chart.
The chart supplies an internal Service, API-only ingress, deny-all egress
(including UDP/WebRTC), temporary storage, resource limits, and the API URL.
It deliberately defaults off until the node profile is installed; saves remain
unavailable until a runner is configured. `viewValidator.runtimeClassName` can
select an operator-provisioned isolated runtime. Run the container smoke against
the actual runtime before enabling registration.

Validation covers bounded empty/error/loading fixtures, both themes and display
modes, and up to eight distinct attached scopes, each validated as its own
bounded runner request of twelve scenarios. More scopes are rejected with 422
before any runner work. It does not prove every business
rule or successful-data interaction. Authors must also exercise the actual
workspace view, pagination, actions and peek interactions before claiming acceptance.

For a local `lobu run` or Mac-app project, start only the validator from this
checkout, with a loopback-only published port:

```bash
docker compose -f docker-compose.example.yml --profile local-validator \
  up -d --build view-validator-local
curl -fsS --retry 15 --retry-delay 1 --retry-all-errors --retry-connrefused \
  --retry-max-time 30 --max-time 2 http://127.0.0.1:8090/health
VIEW_VALIDATOR_URL=http://127.0.0.1:8090 lobu run
```

This starts the isolated runner and a small trusted HTTP relay. The relay
publishes only loopback and forwards only `/health` and `/validate`; Chromium
stays on its internal-only network. Publishing a port directly on the runner's
internal-only network does not work. Stop the local runner services with
`docker compose -f docker-compose.example.yml --profile local-validator stop
view-validator-local view-validator`.

The CLI already passes environment variables and project `.env` settings to
the embedded server. For a Mac-app launch, set the same `VIEW_VALIDATOR_URL`
in the project's `.env`. Local and embedded installs deliberately return 503
for view creates and updates until this runner is configured and ready; they
have no validation bypass. Existing views remain readable. Stale compiler
bundles are rebuilt in the background after a read; rejected rebuilds remain
suppressed for that source/compiler, and unavailable runners back off for five
minutes. A later read receives a successful validated rebuild.
