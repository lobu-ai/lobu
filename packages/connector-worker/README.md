# @lobu/connector-worker

Self-hosted Lobu memory worker. Polls the backend for sync jobs, executes connectors locally, generates embeddings, and streams results back. Private workspace package — not published to npm.

## Usage

```bash
connector-worker daemon --api-url https://api.example.com
```

The lean macOS device artifact is built on an arm64 Mac with
`bun run build:mac-device-daemon`. It is a standalone `lobu-device-daemon`
Mach-O; `--no-poll` validates the packaged executable without server access.
The artifact advertises its supervised native connector capabilities and runs
the canonical device Automation arm. Native bridge runs are framed over the
bounded little-endian stdio protocol; Automation runs remain on the daemon's
separate local execution arm.

Device daemons (the macOS daemon and every `lobu daemon` with a platform,
including headless and interactive-session devices) admit **half the host's
threads, clamped to 2-8, active runs by default**, shared across shell actions,
native connector work, and local agent runs. Set `--max-concurrent-jobs <n>`
(macOS daemon) or `WORKER_MAX_CONCURRENT_JOBS` to override it; the CLI flag
takes precedence. Fleet workers without a platform keep two budgets: agent
turns (`WORKER_MAX_CONCURRENT_AGENT_TURNS`, default 4) and connector work
(`WORKER_MAX_CONCURRENT_JOBS`, default 1: syncs, actions, auth and embedding
backfills), so a long sync never holds up a chat reply. An embedding backfill
can arrive while only turn slots are free and then borrows one.
This is a per-device limit, not a setting for each connection, and does not
change device pinning. A busy device still polls with
zero available capacity; being online is not a promise that a slot is free.
Long coding sessions should use the device Automation/session lifecycle rather
than hold a short-deadline shell action open. Concurrency is not isolation:
use separate worktrees for independent coding jobs, and coordinate agents
that share a desktop or browser session.

## Development

```bash
cd packages/connector-worker
API_URL=http://localhost:8787 bun run daemon
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `API_URL` | Backend API URL | Yes |
| `WORKER_ID` | Worker identifier (auto-generated if unset) | No |
| `WORKER_API_TOKEN` | Bearer token for backend auth | No |
| `WORKER_MAX_CONCURRENT_JOBS` | Maximum active runs on a device (default: half the host threads, 2-8), or active connector runs on a fleet worker (default: 1); overridden by `--max-concurrent-jobs` | No |
| `WORKER_MAX_CONCURRENT_AGENT_TURNS` | Active agent turns on a fleet worker (default: 4); ignored by devices, which never run agent turns | No |
| `WORKER_SHUTDOWN_GRACE_SECONDS` | Seconds until the supervisor force-kills after SIGTERM (the Helm chart sets it from `worker.terminationGracePeriodSeconds`); in-flight runs drain for this minus 15s. Unset: 30s drain | No |
| `EMBEDDINGS_MODEL` | Override local embedding model | No |
| `EMBEDDINGS_SERVICE_URL` | Use a remote embedding service instead of local | No |
| `GITHUB_TOKEN` | GitHub API token | No |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT` | Reddit API credentials | No |
| `GOOGLE_MAPS_API_KEY` | Google Maps API key | No |

## Embeddings

Generated locally via `@xenova/transformers` with `bge-base-en-v1.5` (768 dimensions). Runs on CPU, no external API calls. Set `EMBEDDINGS_SERVICE_URL` to offload to a remote service.

## License

BUSL-1.1. See the repository [LICENSE](../../LICENSE).
