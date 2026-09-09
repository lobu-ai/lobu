# Security

This page covers the self-hosted deployment (`lobu run` or the [Docker image](DOCKER.md)): the gateway, embeddings, and Lobu memory backend share one Node process, and an agent turn runs inside a V8 isolate in that process; Postgres is the only user-provided external. Lobu does not spawn per-agent worker processes or orchestrate per-worker containers. (Lobu Cloud runs the same image with multiple replicas on Kubernetes; the multi-replica correctness rules live in `packages/server/AGENTS.md` and are out of scope here.) This page documents what's isolated, what's policy, and what isn't a security boundary at all.

## Threat model

**Lobu is single-tenant.** Ownership is `(platform, userId)` — one Lobu instance serves your users / your bot, not adversarial third parties. Everything below is calibrated against that model. Do not deploy Lobu as a multi-tenant SaaS where mutually distrusting customers share an instance without first reviewing the gaps in this doc.

What we protect against:
- Prompt injection convincing an agent to misuse its tools.
- A skill or MCP server returning unexpected output.
- A worker process crashing or going OOM without taking the gateway down.
- Credential leaks from worker code or its tools.

What we **do not** claim to fully protect against:
- Sandbox escapes in `just-bash` or `isolated-vm` (both are best-effort, see below).
- A worker process bypassing `HTTP_PROXY` on macOS dev hosts (advisory at the language layer).
- A malicious agent declaring `nixPackages: ["nodejs"]` or other interpreters and using them to run arbitrary code through `just-bash` (the binary allowlist is agent-declared — treat each allowed binary as a capability).

If your threat model includes hostile code execution, run Lobu inside a stronger isolation primitive (per-tenant VM, gVisor, or Firecracker) at the *deployment* layer.

## What `just-bash` actually is

`just-bash` is the shell sandbox the worker uses for every shell command an agent issues (it's a separate dependency from `@mariozechner/pi-coding-agent`, which is the Pi harness). It enforces:

- `maxCommandCount: 50_000`, `maxLoopIterations: 50_000`, `maxCallDepth: 50` — these help against DoS, **not** sandbox escape.
- A binary allowlist scoped to `/nix/store/` plus a known list (`lobu`, etc.). The allowlist is built at worker spawn from the agent's `nixPackages` config.

This is a **policy layer**, not a security boundary. If you allow `nodejs`, `python3`, `bash`, `sh`, `curl`, `git`, `bun`, `nix`, or any package manager into `nixPackages`, the agent has full code-execution capability and the depth caps no longer matter.

## What `isolated-vm` actually is

`isolated-vm` runs the MCP `execute` tool's user JS inside a V8 isolate with hard caps (64 MB / 60 s / 200 SDK calls / 1 MB output). The package is in maintenance mode and has had RCE-class issues historically (CVE-2022-39266 on ≤4.3.6 via untrusted V8 cached data). Upstream itself recommends a multi-process architecture for hostile code. Pin to the latest patched version, but do not lean on V8 isolates as the only boundary.

## Network egress

Workers run with `HTTP_PROXY` pointing at the gateway's authenticated in-process proxy. The gateway binds the proxy to `127.0.0.1` and injects a URL that uses the port from `WORKER_PROXY_PORT` (default `8118`) into each worker. Derive firewall and monitoring rules from `WORKER_PROXY_PORT` rather than the literal 8118. The proxy enforces:
- **Allowlist mode** — only configured domains reachable.
- **Blocklist mode** — allow all except denied domains.
- **LLM egress judge** — risky domains get LLM verdict per request, with a 5 min cache and a circuit breaker.

An agent turn runs in a V8 isolate with no network primitive of its own: the guest is built without `fetch`, and its bash tool's in-memory shell has no `curl` or `wget`. Egress is therefore not advisory at the language layer — there is no socket API to bypass a proxy env var with. Every request an agent makes is a call the host mediates, and the gateway's egress proxy resolves the hostname, rejects private and loopback address literals, and applies the agent's network policy before connecting. This holds identically on Linux and macOS, because it does not depend on a host kernel feature.

## Turn isolation

An agent turn executes as a job in a V8 isolate inside the gateway process, not as an operating-system process, so the relevant boundary is the isolate's, not a cgroup's:

- The guest has no Node bindings — no `fs`, no `net`, no `child_process` — and no `fetch`. It cannot open a socket or read the host filesystem.
- Its file tools act on an in-memory filesystem that is created for the turn and discarded when the turn ends. Nothing written there reaches the host disk or the next turn.
- Its bash tool is either that same in-memory shell (no network, no package manager) or, when the conversation pins one, a remote sandbox that is a separate machine with its own filesystem and its own network policy — never the gateway host's shell.
- Every outbound request is mediated by the host and subject to the agent's network policy; see Egress above.

Because a turn is not a process, per-process controls do not apply to it: there is no cgroup, no `systemd-run` scope, and no exec-context hardening (`NoNewPrivileges`, `PrivateTmp`, and similar) in this path. What bounds a turn is the isolate's own limits — memory and wall-clock caps enforced by the runtime, and a heartbeat the gateway uses to reap a turn that stops reporting. A runaway turn is terminated rather than confined.

## Credentials

- Provider credentials and client secrets live on the gateway.
- The `secret-proxy` swaps `lobu_secret_<uuid>` placeholders for real keys at egress. **Workers never see real provider keys**, regardless of mode.
- MCP credentials are resolved per-user via device-auth and injected by the gateway proxy at call time.
- Third-party API auth (GitHub, Google, etc.) is handled by Lobu — workers call these through Lobu MCP tools and never see OAuth tokens.

A compromised worker session cannot leak global platform tokens or MCP client secrets.

### Device-pinned connectors

A connection can be pinned to a *device worker* (`connections.device_worker_id`) so its
syncs/actions run on a specific user-owned device (Lobu for Mac/iPhone) instead of the cloud
connector-worker pool — mandatory for device-only connectors (`required_capability`, e.g.
Apple Health), optional for any other connector ("run the Reddit connector on my Mac").

Implications, by design:
- **Credentials run on the device.** When a pinned connection has an auth profile, the gateway
  delivers the resolved connection credentials to that device worker over its own user-scoped
  token — the same path the cloud worker uses. The trust boundary is the user: they own both the
  device and the data the connector reads. Capability-matched (unpinned) device connectors are
  no-auth by construction and still receive no credentials.
- **Egress uses the device's network.** Connector traffic from a device worker is not subject to
  the gateway's allowlist/blocklist/egress-judge — those govern locally-spawned workers, not a
  remote device. Treat a device-pinned cloud connector as running on that machine's network.
- **Binding is authorized at bind time.** A connection can only be pinned to a device the requester
  owns, or one explicitly granted to the org by its owner (`device_worker_org_grants`); revoking a
  grant un-pins that org's connections.

## Skills and policy

Skills are executable, security-sensitive input:

- Use curated skill lists by default.
- Packages come from the agent's `nixPackages` (a skill cannot declare any). Review that list: each binary on the allowlist is a capability, treat them as such.
- Network policy is declared on the agent (`network.allowed` / `network.denied` → `settings.networkConfig`), not on skills; gateway egress controls apply on top.
- Destructive MCP tool calls require in-thread approval unless pre-approved via `defineAgent({ tools: { preApproved } })` in `lobu.config.ts`.

## What changed from earlier docs

Earlier versions of this page described Kubernetes pod isolation, NetworkPolicies, gVisor, Kata, and per-pod PVCs, and later ones described local worker subprocesses wrapped in `systemd-run --scope` with cgroup and loopback-only IP rules. Neither is shipped any more: an agent turn runs in a V8 isolate in the gateway process, so the boundary is the isolate's lack of Node bindings and of any network primitive rather than a per-process kernel rule. The earlier models were paying isolation costs for a multi-tenant deployment Lobu doesn't ship, and the subprocess model's kernel rules only ever applied on Linux hosts with a usable systemd user manager.
