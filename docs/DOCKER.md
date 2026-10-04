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

## Production checklist

- [ ] Real `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` (NOT the example placeholders).
- [ ] Real postgres password.
- [ ] `PUBLIC_GATEWAY_URL` set to the real URL.
- [ ] TLS termination via reverse proxy or platform load balancer.
- [ ] Database backups configured (Lobu writes encrypted secrets there — losing the DB means losing every connected integration).
- [ ] `WORKER_ALLOWED_DOMAINS` reviewed for your use case.
- [ ] Provider API keys added through the admin UI (or env vars) for whichever providers you intend to use.
