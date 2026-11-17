# Lobu Final Architecture — Annotated for Implementation

> **Status (2026-07-15): ARCHIVED SNAPSHOT.** The annotations were verified against `main` at
> authoring time (2026-07-14); treat every `file:line` citation and every "does not exist today"
> claim as historical, not current. Known items that have **shipped since**: WI-0.1
> automation-definition approval queue (`queueAutomationWriteForApproval`, #1903); WI-0.3 Slack-decidable
> config approvals (#1918/#1924/#1926/#1928); §16.2's run-backed configuration link — `run_id`
> prefill and the guarded pending-proposal endpoints now exist (#1918/#1924). Re-verify against
> `main` before acting on any remaining item.

> **How to read this document.** This is the original architecture plan with inline review annotations
> under each affected section. Every annotation is one of:
>
> - **FIX** — the plan assumes something untrue about existing code, or under-specifies a
>   security/correctness-critical piece. Must be resolved before that section is implemented.
> - **CUT** — remove from launch scope. Cheap to re-add later; each CUT says how.
> - **KEEP** — load-bearing existing machinery the plan must reuse, not rebuild. Do not cut.
> - **GAP** — a missing piece the plan never states but the demo or public launch needs.
> - **NOTE** — a correction or precision that changes an estimate but not the direction.
>
> Every annotation carries `file:line` evidence, verified against `main` (working tree clean).
> Severity: **critical** = launch-blocking or a security hole; **high** = bites within weeks of
> going public; **medium** = real but schedulable.
>
> **Four global directives decided by the owner, applied throughout:**
> 1. **Vercel-only for launch.** Tighten the provider CHECK to `vercel`; exclude `device` from the
>    RuntimeConnection/Sandbox model (keep `device_workers` as a peer concept); `builtin` is
>    ephemeral-only or self-host-only. `cloudflare`/`e2b`/`daytona`/`device` deferred.
> 2. **Extend the shipped write-gate — do NOT build the §14 ActionDefinition registry.** New config
>    actions become new `WriteResourceClass` values + `WRITE_ACTION_MANIFEST` entries + one generic
>    `action_key`-keyed internal-run dispatcher. Reuse per-field stale-skip; drop surface-parity CI.
> 3. **The Slack launch demo is the priority.** Scope is inverted relative to it (see §26). A new
>    **Phase 0** carries the demo blockers ahead of all sandbox/GitHub work.
> 4. **No auto-resume for launch.** Parent/child blocked-run continuation is greenfield and trap-laden;
>    the demo has a human in the loop by definition. Use `user_action_required` + configureUrl +
>    a "Connected — ask me again" notification. Defer the dispatcher-resume machine.

---

## Phase 0 — Demo-viable cut (NEW — implement first, before Phase 1)

> **GAP (critical/scope).** The plan has no phase for the four things the Slack launch demo actually
> depends on. Three of them appear in **no** section at all; the fourth is scheduled behind four
> phases of sandbox work the demo never touches. Build these first.
>
> **WI-0.1 — Automation-definition approval queue (critical): SHIPPED.**
> `gateAutomationWrite` now sends `require_approval` decisions to
> `queueAutomationWriteForApproval`, which persists a pending internal run and approval event.
> The implementation lives in `packages/server/src/tools/admin/manage_automations.ts`; the
> `agent_config` class defaults live in `packages/server/src/authz/write-action-manifest.ts`.
> This landed in #1903; do not re-implement it.
>
> **WI-0.2 — Slack identity → member mapping on the message-enqueue path (critical/security).**
> For Slack, the enqueued `userId` is the raw platform author id (`U…`), so the member join never
> matches and the worker falls back to direct-auth, running the **entire turn as the builder's
> provisioning owner with `memberRole=admin` + `mcp:admin` and no `adminTools` cap.**
> Files: `packages/server/src/gateway/orchestration/message-consumer.ts:88-115` +
> `packages/server/src/gateway/connections/message-handler-bridge.ts:471` (raw id enqueued);
> `packages/server/src/workspace/multi-tenant.ts:296-346` +
> `packages/server/src/tools/execute.ts:138-151` (direct-auth = owner+admin, no cap);
> `packages/server/src/preview/slack.ts:723-734` (a `chat_user_identities` mapping exists but is used
> only for slash commands / approval buttons, not enqueue). Fix: resolve the Slack author to a member
> via `chat_user_identities` on the enqueue path; attribute the turn to that member (or to an
> explicit low-privilege "unmapped chat user" principal), never to the provisioning owner.
>
> **WI-0.3 — Slack-decidable approvals for non-entity runs (critical).**
> The demo's human-in-the-loop lives in Slack, but config/agent approvals can only be decided in the
> web UI. The interactive Approve/Reject card is dropped for Slack, the admin notification is a text
> link with no buttons, and the Slack action handler answers non-entity runs with "This approval
> can't be completed from Slack yet." Meanwhile `manage_agents` tells the model NOT to restate the
> change because "a confirmation card is now shown in the chat" — false on Slack.
> Files: `packages/server/src/gateway/api/platform.ts:99-121` (card dropped unless `platform==='api'`);
> `packages/server/src/notifications/triggers.ts:291-336` (no buttons);
> `packages/server/src/gateway/connections/interaction-bridge.ts:752-786` (entity-only handler);
> `packages/server/src/tools/admin/manage_agents.ts:512-517` (false "card shown" claim). Fix: render
> an approval card with Approve/Reject buttons in Slack for config/agent-family runs and wire the
> action handler to resolve them.
>
> **WI-0.4 — Pull inference-provider setup + cold-start fix forward (critical).**
> `NOTE`: the plan *does* cover chat-driven inference setup via the run-backed link (§16.2/§21) — but
> it is scheduled in Phases 5+7, after the sandbox work. The demo needs it in Phase 0. Also fix the
> confirmed cold-start dead-end: on a deployment with no system model keys, `ensureBuilderAgent`'s
> model repair is a no-op, so every builder DM turn fails with "no model" until a human configures a
> provider in the web UI first — the exact step the demo is meant to eliminate.
> Files: `packages/server/src/auth/builder-provisioning.ts:175-189` +
> `packages/server/src/auth/system-provider-resolution.ts:55-105` (repair no-op);
> current link+form path to reuse: `buildProviderConnectUrl` in
> `packages/server/src/utils/url-builder.ts` +
> `ProviderConnectorBody` in
> `packages/owletto/src/app/$owner/connectors/$connectorKey.index.tsx`. Fix: when the builder has no
> usable model, have the bot post the run-backed configure link (§16.2) instead of erroring; deliver
> the §16.2/§21 flow in Phase 0.
>
> **WI-0.5 — Correct event-supersede contract (high).** See §7 FIX — the pending/terminal card
> linkage the demo relies on does not work as written. Fix belongs in Phase 0 because every approval
> card in the demo depends on it.

---

## Purpose

This document defines the target architecture for Lobu's execution and inference system.

It covers: runtime providers; inference providers; reusable provider connections; explicit sandboxes; agent conversations; direct MCP execution; Lobu-hosted agent execution; configuration links; approvals; secure credential entry; append-only events; generic runs; GitHub code publication; API, SDK, UI, CLI, and `lobu apply` consistency; migration from the current environment-based model.

The design should be reviewed as a clean end state. Manual database and API migrations are acceptable. Do not preserve confusing concepts only for backward compatibility.

> **NOTE.** The resource model (RuntimeProvider → RuntimeConnection → Sandbox; InferenceProvider ≠
> RuntimeProvider; runs + events + run-backed links) is sound and should be kept. The two structural
> problems are (a) scope is aimed at sandbox/GitHub, which the demo does not use, and (b) several
> "reuse existing X" claims are false — the estimates under them collapse. Annotations below fix both.

# 1. Design principles

## 1.1 Reuse existing Lobu infrastructure

The implementation must reuse: existing embedded Bash execution; existing remote runtime-provider execution; existing Vercel Sandbox integration; existing persistent filesystem semantics; existing secret store; existing auth-profile flows; existing OAuth and device-code flows; existing generic `runs` infrastructure; existing approval cards and operation approval logic; existing append-only events; existing run permalinks; existing environment and inference-provider forms; existing GitHub connector.

Do not create parallel implementations for the same concern.

> **KEEP (verified).** These exist and are near-1:1 with the plan's targets: the `environments`
> table maps almost directly onto `runtime_connections`
> (`db/migrations/20260629000050_environments.sql:15-37`); the Vercel lifecycle is **not** duplicated
> between gateway and worker — the worker side is a 21-line HTTP delegate, so §13's "one lifecycle"
> requirement is already met (`packages/agent-worker/src/embedded/runtime/providers/vercel.ts:9-21`
> vs `packages/server/src/gateway/runtime/providers/vercel.ts`); credential resolution already runs
> gateway-side in the exact §22 order and never leaks to workers
> (`packages/server/src/gateway/runtime/credentials.ts:17-47`).
>
> **FIX (high/overengineering).** §1.1 says "do not create parallel implementations," but §14 (and
> parts of §19) do exactly that against the shipped write-gate. Global directive #2 applies: extend
> the write-gate, do not build a second approval subsystem. See §14 and §19 annotations.

## 1.2 One domain layer, multiple adapters

REST, ClientSDK, UI, CLI, `lobu apply`, agent tools, automations, and external MCP clients must call the same application-level services and actions.

REST must not call ClientSDK internally. ClientSDK must not call REST internally. Both call the same domain service.

> **GAP (high).** Today the surfaces are **not** unified: `inference_providers` and agent create/
> update each have divergent implementations across the REST route and the `manage_*` tool. See §15.8
> FIX (agent CRUD forks into two semantically different creates). The Phase 2 "extract services"
> work is real and required, but note it must cover **agent identity**, not just agent settings.

## 1.3 No credentials in model context

Plaintext secrets must never appear in: prompts; generated TypeScript passed to `run_sdk`; MCP tool arguments; run proposals; append-only events; approval cards; notifications; query parameters; URL fragments; logs; traces; Sentry breadcrumbs; SDK output; sandbox metadata.

Secrets are entered only through: authenticated Lobu UI; secure OAuth or device-code flow; hidden CLI prompt; environment-variable indirection; external secret references; privileged non-LLM server APIs.

> **FIX (high/security).** This principle has **no structural enforcement today** and four channels
> already violate it — the plan must close them, not "preserve" them:
> 1. `client.authProfiles.create/update` accept `credentials: Record<string,string>` and
>    `manage_connections` install accepts `auth_values`, both callable from `run_sdk` — so API keys
>    transit model context today. §15.7's "preserve and consolidate" hides a required breaking removal.
>    (`packages/server/src/sandbox/namespaces/auth-profiles.ts:24-46,77`;
>    `packages/server/src/tools/admin/manage_connections/handlers/connector-management.ts:73,208`)
> 2. `runs.action_input` is persisted **verbatim** into runs → events `interaction_input` →
>    `list_runs/get_run` output. §15.3's exec `env` map written into `action_input` would put plaintext
>    into append-only events. Fix: gateway-resolved secret references or key-only redaction **before
>    insert**. (`packages/server/src/runs/queue-service.ts:594-609`;
>    `packages/server/src/tools/admin/manage_operations.ts:1150-1199`)
> 3. `run_sdk` script text is persisted into append-only events with regex-key-name redaction only, so
>    an inline token (`GITHUB_TOKEN=ghp_… git push`) survives **forever** (events are append-only,
>    cannot be deleted). `run_sdk` also caps scripts at 60/180s — long execs need a first-class async
>    run, not `run_sdk`. (`packages/server/src/sandbox/run-script.ts:88-114,164-178`;
>    `packages/server/src/tools/audit.ts:7-31,60-80`)
> 4. `requireSessionOrAdminPat` treats any `mcp:admin` PAT — including one an agent holds for org
>    setup — as human-equivalent for the plaintext-`apiKey` `POST /inference-providers` and rotation
>    routes. `secretInputFields` routes should require an interactive session, as OAuth start already
>    does. (`packages/server/src/lobu/agent-routes.ts:209-232,886-924` vs `:682-692`)
>
> There is **no declarative redaction layer** anywhere (`grep secretInputFields` → not found). Build
> one: a per-action `secretInputFields` list resolved gateway-side that strips/refs secrets before any
> persistence. This is the structural backbone that makes §1.3 real.

## 1.4 External models should not require a second Lobu model

ChatGPT, Claude, Slackbot, or another external MCP client may already provide reasoning. They must be able to create or reuse a sandbox, execute Bash, read results, modify files, run tests, and publish code — without invoking a Lobu inference provider. A Lobu inference provider is required only when Lobu itself is running an agent model.

> **KEEP.** Sound principle. But note the external exec path is exactly where the trust anchor is
> missing today — see §5 FIX and §12 FIX.

# 2. Final domain model

```text
RuntimeProvider · RuntimeConnection · Sandbox · Run · InferenceProvider · AuthProfile · Agent · Conversation · Event
```

> **KEEP.** Model shape is correct and worth keeping. Corrections are in the resource sections below,
> not in the shape.

# 3. RuntimeProvider

A `RuntimeProvider` is a read-only implementation of an execution backend. Examples: builtin, vercel, e2b, daytona, cloudflare, device. It defines credential fields, capabilities, sandbox create/lookup, persistent-filesystem semantics, command execution, resource config, network-policy translation, stop/resume/delete, and diagnostics. Users do not create runtime providers.

## Required consistency

A runtime provider must not be accepted in the database or API unless it is actually registered and executable. Do not declare support for Cloudflare, E2B, or Daytona merely because a database constraint accepts those strings. The runtime-provider registry must be the source of truth.

> **CUT (high) — global directive #1.** Only **vercel** is registered and executable on both sides
> (`packages/server/src/gateway/runtime/index.ts:9`;
> `packages/agent-worker/src/embedded/runtime/index.ts:9`). `builtin` is the *absence* of a provider
> (local just-bash fallback), and `device` is a separate pull-model subsystem, not a runtime provider.
> `e2b`/`daytona`/`cloudflare` have zero code. Yet the CHECK constraint accepts
> `('vercel','cloudflare','e2b','daytona')` — the exact anti-pattern this section forbids, live today
> (`db/migrations/20260629000050_environments.sql:31-32`). **Fix in the rename migration: tighten the
> CHECK to `vercel` only.** Re-add a provider string only when its registry entry ships. Cost to
> re-add later: one migration + one registry registration.
>
> **FIX (high) — see §23 for `builtin` and `device`, which do not fit this interface.**

# 4. RuntimeConnection

A `RuntimeConnection` is a named, reusable configuration for a runtime provider. It replaces the `Environment` concept. It owns name, runtime-provider ID, private/org scope, owner for private, provider account identifiers, encrypted gateway-held credentials, provider-specific config, and a default policy for new sandboxes.

## Ownership invariant

scope = org → ownerUserId must be null. scope = private → ownerUserId must be set. Private runtime connections may be accessed only by their owner or authorised org admins. Every list, get, update, delete, test, credential, and execution path must enforce this.

> **FIX (critical/security).** Private scope is **entirely unenforced today** — worse than "not yet
> enforced":
> - `POST /environments` accepts `scope='private'` but never passes `ownerUserId`, so **every private
>   row has `owner_user_id` NULL** and is unattributable
>   (`packages/server/src/lobu/environment-routes.ts:183`;
>   `packages/server/src/lobu/stores/environment-store.ts:41-53,70`).
> - List returns **all** rows to any org caller (mcpAuth only, no admin gate) decorated with
>   credential-adjacent details (Vercel `teamId`/`projectId`)
>   (`environment-routes.ts:103-123`).
> - Rotate/delete and the exec credential path check **org only**
>   (`environment-routes.ts:204-246`; `packages/server/src/gateway/runtime/credentials.ts:27-33`).
> - The agent editor offers **every** environment to **every** editor — any member can point an agent
>   at another member's "private" Vercel account and spend it
>   (`packages/owletto/src/components/agents/agent-editor-form.tsx:357-366`).
>
> The invariant is a **real fix**, not a preservation. And the §25 migration must add rules the plan
> omits: NULL-owner private rows violate the new constraint on day one — backfill owner from audit,
> or demote to org scope. See §25 FIX.

# 5. Sandbox

A `Sandbox` is the actual execution workspace created through a runtime connection. It owns runtime connection, provider sandbox identifier, persistent filesystem, lifecycle state, resource settings, network policy, ownership, optional conversation/agent binding, and timestamps. One connection may back many sandboxes; a sandbox may be reused by ChatGPT/Claude via MCP, a Lobu agent/conversation, CLI, UI, jobs, automations.

## Stable public identity

External clients use `sandboxId`; they must not need to know conversation IDs, provider sandbox names, or workspace paths.

## Execution belongs to Sandbox

Do not expose `runtimeConnections.exec(...)`. Use `sandboxes.exec(...)`.

> **FIX (critical/security) — the security seam of the whole external path, one sentence in the plan.**
> The current exec path derives provider id, agent, conversation, workspace fencing, **and** the egress
> `allowedDomains` exclusively from a gateway-minted **signed worker token**; the request body is
> explicitly untrusted so the executor cannot widen its own network policy
> (`packages/server/src/gateway/routes/internal/runtime.ts:12-21,98-101`;
> `packages/server/src/gateway/runtime/workspace.ts:28-53`). §5/§12/§15.3 make
> `sandboxes.exec(sandboxId, command)` the public centerpiece for PAT/session-authenticated MCP
> clients, **where no such signed per-conversation claim exists.** The plan never specifies:
> 1. **Who may exec which sandbox.** An external token exec-ing an agent- or conversation-owned sandbox
>    hijacks that workspace mid-conversation. Define: external tokens may exec only user-owned sandboxes
>    they own; agent/conversation-owned sandboxes are gateway-internal.
> 2. **Who may set or widen `network.allowedDomains`.** `'*'` = allow-all. §27's "cannot be widened by
>    command input" is cosmetic if the same principal can `update` the sandbox — widening at
>    create/update is the untested hole. Gate network-policy widening behind an approval/admin path.
> 3. **Token scopes.** There is none today. Define exec scopes distinct from admin PATs.
>
> Also: the write-gate classifies an MCP user session with no bound agent as principal `user` in
> `attended` mode, so a host that auto-invokes tools applies config writes **instantly, no Lobu-side
> approval** — §19's "host confirmation may count as human confirmation" has no signal to hang on
> (`packages/server/src/authz/entity-policy.ts:328-338,87-99,63-70`). Decide (plan Q2) which hosts,
> and add the seam.
>
> **CUT (high) — sandbox ownership variants and policy modes.** `organization` and `agent` ownership,
> and `shared`/`on_demand` policy modes, are not demo-needed and have no concurrency story: the worker
> serialization lock is keyed on `conversationId` **only**, so two conversations sharing one sandbox
> would interleave in one filesystem with no per-sandbox lock
> (`packages/server/src/gateway/orchestration/deployment-manager.ts:260-262,1992-2025`;
> `packages/server/src/gateway/runtime/providers/vercel.ts:243-263`). `on_demand` is just lazy
> `per_conversation`. The demo's DM and channel are **distinct conversations** anyway
> (`packages/server/src/gateway/connections/message-handler-bridge.ts:484-489`), so cross-surface
> shared state is not even demonstrable. Ship `user` + `conversation` ownership and `none` +
> `per_conversation` modes only. Cost to re-add: a per-sandbox advisory lock + the extra enum values.

# 6. Run

A `Run` is one durable Lobu action or execution attempt. Reuse the existing generic `runs` infrastructure. Do not create `runtime_runs`, `sandbox_runs`, `setup_runs`, `configuration_runs`. A run stores action key, actor, org, proposal, safe input, approval state, execution state, parent run, blocking reason, result, error, timestamps, optimistic-concurrency info.

## Parent and child runs

Blocked task → parent run `status: blocked`, `blocked_reason`; child config run `status: waiting_for_user`. On success: child → completed, parent → queued, dispatcher resumes parent. Automatic continuation optional for external MCP, supported for Lobu-native agents/jobs/automations.

> **FIX (high/plan-vs-reality) — this is greenfield, not "add explicit fields," and it has
> multi-replica + sweeper traps.** Verified across 7 of 11 readers:
> - `runs` has **no** parent linkage; the status CHECK **forbids** `blocked`/`waiting_for_user`
>   (`db/migrations/00000000000000_baseline.sql:1868-1911`).
> - **No** completion hook requeues a parent on child completion.
> - Approve paths are bespoke per-`action_key` fall-through; **`client.operations.cancel` does not
>   exist** (§15.10 lists it as reusable — it isn't)
>   (`packages/server/src/tools/admin/manage_operations.ts:1649-1671`;
>   `packages/server/src/sandbox/namespaces/operations.ts:27-64`).
> - **Trap:** a parent parked as `pending` is claimable by dispatchers
>   (`runs_lobu_claim_idx` is partial on `status='pending'`) and **DELETEd** by `sweepCompletedRuns`
>   once `expires_at` passes. A new `blocked` status must be excluded from the claim index, the
>   stale-claim sweeper, **and** the retention sweep
>   (`baseline.sql:4559`;
>   `packages/server/src/gateway/infrastructure/queue/runs-queue.ts:588-606,872-933`).
> - "Same agent conversation resumes" contradicts turn-liveness: every dispatched turn owes exactly
>   one terminal event on a deadline and worker sessions are in-process, so "resume" must mean
>   **enqueue a NEW run** for the same `conversation_id` with context from
>   `agent_transcript_snapshot`, driven by a Postgres status transition (multi-replica invariant). The
>   only wait-on-child today is a synchronous in-process HTTP-scoped poll
>   (`packages/server/src/gateway/orchestration/turn-liveness.ts:1-41`;
>   `packages/server/src/worker-api/dispatch-chrome-action.ts:249-291`).
>
> **CUT/DEFER (global directive #4).** For launch, do **not** build the dispatcher-resume machine.
> Use the plan's own half-blessed alternative: a universal `user_action_required + configureUrl`
> response plus a notification on config-run completion ("Connected — ask me again"). The demo has a
> human in the loop, so a manual re-ask is fine. **Do** add `parent_run_id` + `blocked_reason` columns
> now (cheap, forward-compatible) but leave auto-resume unbuilt. Cost to add later: the requeue hook +
> the three sweeper/index exclusions + the transcript-snapshot re-enqueue.
>
> **NOTE (weight of per-command runs).** §15.3/§27 create an ordinary run row per `sandbox.exec` Bash
> command. That is acceptable but size the retention sweep and indexes for it — this is a
> high-cardinality write path, unlike today's connector-operation runs.

# 7. Event

An `Event` is the append-only, user-visible representation of a meaningful run transition. The server creates pending events; agents must not create approval events directly. A pending event (`origin_id: run_123_pending`) is superseded by a terminal event (`origin_id: run_123_completed`). The run permalink is the stable lifecycle URL. Do not emit events for page loads, polling, validation failures, OAuth polling, output chunks, file reads, or status checks.

> **FIX (high) — the supersede contract is wrong as written; approval cards would never resolve.**
> The store has **no** run_id- or origin-based auto-supersede. Linkage is **exclusively** the explicit
> `supersedes_event_id` set at insert. The origin-keyed upsert path requires the **same** `origin_id`
> **plus** non-null `connection_id` — and internal-run approval events have `connection_id` NULL, so it
> can never engage. Implemented literally (pending and terminal with **different** origin_ids), **both
> cards stay live in `current_event_records` forever.**
> (`packages/server/src/utils/insert-event.ts:121-169,427-434`). Fix: implementations must go through
> `supersedeActionEvent` or pass `supersedesEventId` explicitly
> (`packages/server/src/tools/admin/manage_operations.ts:1114-1183` is the working mechanism). State
> this in the plan. **This is WI-0.5 — belongs in Phase 0, since every demo approval card depends on
> it.**
>
> **FIX (medium/security).** `save_content` exposes `supersedes_event_id` to agents with only
> org + not-already-superseded checks, letting an agent **hide a pending approval card**
> (`packages/server/src/tools/save_content.ts:305-331`). Restrict supersede of approval-type events to
> server-side paths.
>
> **KEEP.** `semantic_type='operation'`, `interaction_type='approval'`, `interaction_status`
> pending/completed, and run permalinks all exist and are server-written today.

# 8. InferenceProvider

An `InferenceProvider` owns slug, kind, displayName, per-modality capabilities (text/image/stt/tts/embedding), an auth reference union, isDefault, and status.

> **FIX (high/plan-vs-reality) — the credential story models one AuthProfile over what is actually two
> disjoint stores, and omits a shipped fail-closed invariant. Verified CONFIRMED.**
> 1. **Two stores.** Inference-provider credentials resolve against the gateway `user_auth_profiles`
>    table (per-user/per-agent rows, each a **jsonb ARRAY** of profiles; org-bucket rows use synthetic
>    `agent_id '__org_oauth__:<org>'`), while connector credentials live in the org `auth_profiles`
>    table that `client.authProfiles` fronts. §8's `auth: { type:'auth_profile'; authProfileId:number }`
>    can only reference `auth_profiles.id` — the jsonb array elements have **no per-profile DB identity**
>    (they carry internal string ids for dedup only). So inference OAuth
>    (`packages/server/src/lobu/agent-routes.ts:824-842`, which writes to the org bucket) is
>    **unreachable** by the plan's model. §15.7's "preserve and consolidate" is actually a schema
>    migration merging two stores with different keying, ownership, and kind vocabularies — plan it
>    explicitly or inference OAuth forks a third representation.
>    (`packages/server/src/gateway/auth/settings/user-auth-profile-store.ts:59-93,153-160`;
>    `packages/server/src/utils/auth-profiles.ts:26-55`)
> 2. **Missing `base_url` fail-closed invariant.** When an org row has a custom `base_url`, the shipped
>    resolver **refuses** to send a per-user subscription token or deployment env key to that
>    tenant-defined URL — it uses the row's own key or fails closed, reading `base_url` + key in one row
>    read so they can't diverge. §8's interface omits `base_url` entirely and §22 states the bare
>    chain. A faithful clean-slate rebuild of the plan's stated chain would **send a user's Anthropic
>    subscription token to any https URL an org admin configures** — a credential-exfiltration
>    regression in a product about to go public and multi-tenant. Carry `inference-invariant.ts` into
>    the design explicitly. (`packages/server/src/gateway/auth/inference-invariant.ts:6-48`;
>    `packages/server/src/gateway/auth/base-provider-module.ts:289-306` — "fail CLOSED, do not fall
>    through")
>
> **KEEP.** `is_default` already exists (`20260704000000_inference_providers_is_default.sql`), and
> delete+recreate already mints a fresh `<slug>-<id>` `api_key_ref` so old ciphertext can't be
> inherited (§22 property already holds).

# 9. AuthProfile

An `AuthProfile` is a reusable authenticated identity: oauth_account, oauth_app, device_code, api_key, env, interactive, browser_session. Separate from inference providers, runtime connections, connectors. No API response may expose tokens, keys, cookies, secrets, or encrypted values.

> **NOTE.** The connector `auth_profiles` kind vocabulary today is
> env/oauth_app/oauth_account/browser_session/interactive — it does **not** include `device_code`/
> `api_key` as first-class kinds. Reconcile the vocabulary as part of the §8 store-merge, not
> separately. **FIX cross-ref:** the "no response exposes credentials" rule is violated on the *input*
> side today — see §1.3 FIX item 1.

# 10. Agent

Identity: name, description, identity/soul/user instructions, template. Settings: default inference model, provider prefs, auth-profile refs, default runtime connection, sandbox policy, network policy, tool policy, skills, MCP servers, plugins, packages, logging. Do not expose only a reduced SDK settings model; all surfaces operate on the same canonical settings object.

> **NOTE.** No single reduced-vs-full settings fork exists to collapse — settings are already fairly
> canonical. The real duplication is in **agent identity CRUD**, not settings. See §15.8 FIX. Phase 2
> must extract an **agent-identity** service too, not only agent-settings.

# 11. Conversation

A `Conversation` is the durable interaction context for a Lobu agent, optionally bound to a sandbox. Resolution: load conversation → agent settings → check `conversation.sandboxId` → verify usable → reuse or apply policy → create when permitted → persist binding → execute. Policies: per_conversation, shared, on_demand, none. Deletion must not auto-delete every persistent sandbox — only when ownership is `conversation` and marked disposable and confirmed.

> **GAP (medium) — where does `sandboxId` hang? (plan Q6).** There is no single canonical conversation
> table; agent sessions are keyed by org+agent+channel/thread identity. DM and channel are distinct
> conversation keys (`message-handler-bridge.ts:484-489`). Decide: a dedicated
> `conversation_sandboxes(conversation_key, sandbox_id)` binding table is cleaner than a column,
> because there is no one row to add a column to. Keep it to **one active sandbox per conversation
> key** for launch.
>
> **CUT.** With §5's `shared`/`on_demand` cut, this section reduces to `none` + `per_conversation`.
> The deletion rules still apply to `conversation`-owned sandboxes.

# 12. External MCP execution path

ChatGPT performs reasoning → discovers runtime providers/connections → creates or reuses sandbox → executes commands → reads results → modifies files → runs tests → publishes patch via GitHub connector. No Lobu inference provider required.

> **FIX (critical/security).** This is the path with no trust anchor — see §5 FIX. Before this path is
> public, resolve: which token scopes may exec; which sandboxes an external token may reach; and how
> network-policy widening is gated. **GAP (critical/public):** this path also exposes **free code
> execution on Lobu's infra and account** — see §22 FIX (quotas/rate-limits/GC).
>
> **NOTE (how external clients reach Lobu today).** Via named `manage_*` tools **and** `run_sdk`
> executing generated TypeScript against the ClientSDK. If `sandboxes.exec` is reached through
> `run_sdk`-generated code, §1.3 applies to the generated script text (persisted to append-only
> events) — reinforcing the §1.3 redaction-layer FIX.

# 13. Lobu agent execution path

Message → resolve agent settings → resolve inference provider/model → reason → resolve/create conversation sandbox → execute → persist runs/events → respond. The Lobu worker and external ClientSDK must use the same sandbox services; do not maintain a separate sandbox lifecycle for agent workers.

> **KEEP (verified).** The single-lifecycle requirement is **already satisfied**: the worker is a thin
> HTTP delegate to the gateway's one Vercel lifecycle (see §1.1 KEEP). Unifying to explicit sandbox
> rows is near-zero on the worker side — the change is making the **gateway** resolve an explicit
> sandbox row instead of recomputing the deterministic name
> (`packages/server/src/gateway/runtime/providers/vercel.ts:92-121`).

# 14. Canonical application actions

Every public action has one `ActionDefinition` (input/output schemas, access tier, resourceClass, approval mode, secretInputFields, surfaces, apply()). Source of truth for validation, authz, approval policy, redaction, action key, SDK metadata, OpenAPI, tool schema, surface availability, audit. Surface-parity CI enforces exposure.

> **FIX (high/overengineering) — global directive #2: do NOT build this registry. Extend the shipped
> write-gate.** §14 as written is a **parallel approval/authorization subsystem** duplicating the
> shipped write-gate (#1827: `write_approval_policies` + `write_policy_action_effects` +
> `WRITE_ACTION_MANIFEST` with a mirroring DB CHECK + per-agent envelope UI + `action_modes`), which
> already implements per-principal, per-mode approval with fail-closed resolution, max-restrictive
> folding, and approve-time policy rechecks. Building §14 violates §1.1/§28.21 and **bypasses hardened
> properties** (fail-closed unknown effects, anti-self-escalation, human-only approval).
> (`packages/server/src/authz/write-action-manifest.ts:1-89`;
> `packages/server/src/authz/entity-policy.ts:596-627,911`;
> `packages/server/src/operations/action-modes.ts:49-55`)
>
> **Directive to implementer:**
> - **KEEP** `WRITE_ACTION_MANIFEST`, `action_modes`, per-agent envelope UI, per-field stale-skip.
> - **GAP/DO:** add new `WriteResourceClass` values (`runtime_connection`, `sandbox`,
>   `inference_provider`) + manifest entries for each new action key. Build **one generic
>   `action_key`-keyed internal-run claim/apply dispatcher** so each new family does **not** need a
>   bespoke creator/claim/apply/fall-through slot (~15 branches for the plan's action list today —
>   `manage_operations.ts:1223-1263,1352-1388,1649-1671`).
> - **CUT** the surface-parity CI: dedicated Hono routes parse bodies with inline `typeof` checks, so
>   there is **no schema object to diff** — the prerequisite is a ~20-route migration the plan doesn't
>   schedule (`packages/server/src/lobu/agent-routes.ts:892-926`). If `ActionDefinition` is built at
>   all, make it a **thin descriptor** delegating to the write-gate seams, not an approval engine.
>
> Three §19 semantic mismatches to decide (not a new framework):
> - (a) "destructive actions ALWAYS require confirmation" is **inexpressible** — class defaults are
>   starting points; any explicit policy row replaces them and `action_modes` can flip destructive ops
>   to `auto`. An unloosenable **floor** is a new manifest concept — add it as `min_effect` per action.
> - (b) §19's "fail with conflict when the resource changed" **contradicts** shipped per-field
>   stale-skip (which skips stale fields, applies the rest — already never overwrites newer edits)
>   (`packages/server/src/tools/admin/entity-field-approval.ts:598-637`). Keep stale-skip; drop the
>   whole-row conflict model.

# 15. Final ClientSDK surface

> **NOTE.** Sub-sections annotated individually below. Read §15.3/§15.6/§15.7/§15.8/§15.10 FIXes —
> they contain the load-bearing corrections.

## 15.1 Runtime providers — list / get (read-only, no credentials)
> **OK as specified.**

## 15.2 Runtime connections — list / get / create / update / delete / test
> **KEEP.** Do not expose plaintext credential args through the LLM-facing SDK (§1.3). Creation returns
> a configureUrl when credentials are required (see §16.2). Enforce the §4 ownership invariant on every
> verb.

## 15.3 Sandboxes — list / get / create / exec / stop / resume / delete
> **FIX (critical/security):** `exec` and `network` widening — see §5 FIX (trust anchor, who-execs-what,
> allowlist widening).
> **FIX (high/security):** the `env` map on `exec` is a secret channel — it lands in `action_input` →
> events. Resolve via gateway secret-refs, not plaintext (§1.3 item 2).
> **CUT:** `stop`/`resume` verbs — Vercel has no real resume primitive; `getOrCreate` reconnects
> (`packages/server/src/gateway/runtime/providers/vercel.ts:243-263`). Ship `create`/`exec`/`delete`
> only; model `stopped` as a status, not a verb, for launch.
> **KEEP:** "long command → `{runId, status:'running'}` + existing run lookup; do not create a
> `runtimeRuns` namespace" — correct, reuse §6 runs.

## 15.4 Long-running processes — startProcess / getProcess / readProcessLogs / stopProcess
> **CUT (high).** A new stateful subsystem whose process + log-cursor state must be Postgres-mediated
> per the multi-replica invariant (in-process handles are not cross-pod visible). Not demo-needed.
> `exec` + `timeoutMs` covers launch. Cost to re-add: the process table + log-cursor store + a
> provider process API.

## 15.5 Optional file methods — listFiles / readFile / writeFile / applyPatch
> **CUT.** The plan itself concedes Bash suffices. Do not duplicate filesystem logic for launch.

## 15.6 Inference providers — catalog / list / get / create / update / setDefault / delete / test
> **FIX (critical/demo → sequencing).** This is the surface the demo's "Slackbot maps inference
> providers" needs, but there is **no MCP tool, no `run_sdk`/ClientSDK namespace** for it today —
> creation is REST-only with a plaintext `apiKey`, and agents can't even **list** providers to propose
> one (`packages/server/src/sandbox/client-sdk.ts:57-79`;
> `packages/server/src/lobu/agent-routes.ts:886-965`). Pull this surface into **Phase 0** (WI-0.4), not
> Phase 7. The LLM-facing SDK must not accept an API key — creation returns a configureUrl (§16.2).

## 15.7 Auth profiles — list / get / test / delete / beginSetup
> **FIX (high).** "Preserve and consolidate" hides (a) the required **breaking removal** of the
> plaintext `credentials` arg (§1.3 item 1) and (b) the **two-store merge** (§8 FIX). This is not a
> preserve — it's a migration + an API break. Say so.

## 15.8 Agent settings — getSettings / updateSettings
> **FIX (high/security) — two live create-agent implementations disagree, and full-settings exposure
> enables self-escalation.**
> - REST create → `owner_platform='lobu'`, `pre_approved_tools` injection, **no `agent_users` row**
>   (agent is **unreachable via chat** per `manage_agents`' own comment); REST PATCH/DELETE **bypass**
>   the write-gate and pre-image concurrency, and REST delete is **unconditional** even though
>   `agent_config` delete defaults to **deny** in the manifest.
> - `manage_agents` create → `owner_platform='external'` + the `agent_users` row + write-gated with
>   pre-image.
>
> Since the demo is "Slackbot creates agents," which path runs determines whether the agent is even
> chat-reachable. And §15.8's `updateSettings` exposes the **full** settings (toolsConfig,
> `preApprovedTools`, guardrails, environmentId) to LLM-facing callers — an agent editing its own
> `preApprovedTools` (documented as "bypass the approval card") or disabling guardrails **sidesteps the
> entire write-gate**. The gate today covers only name/description/identity_md.
> (`packages/server/src/lobu/agent-routes.ts:504-587,1287-1306,1420-1613` vs
> `packages/server/src/tools/admin/manage_agents.ts:115-166,585-633`;
> `packages/core/src/agent-store.ts:91-96`)
> **Directive:** unify agent create/delete into one gated path (Phase 2 must extract an agent-identity
> service); mark security-relevant settings fields (`preApprovedTools`, guardrails, `environmentId`,
> `toolsConfig`) as **same-or-stricter gated** — no LLM-facing self-escalation.

## 15.9 Conversations — send / get / messages
> **CUT (low).** The existing chat pipeline already covers Lobu-hosted reasoning; a separate
> conversations SDK is not launch-critical. Defer.

## 15.10 Runs and approvals — listRuns / getRun / approve / reject / cancel
> **FIX (high).** `cancel` **does not exist** today (§6 FIX). Either build a generic cancel primitive
> (needed to unstick abandoned parents) or drop `cancel` from the launch surface. `approve`/`reject`
> exist only as bespoke per-family fall-through — the generic dispatcher (§14 directive) replaces this.

# 16. Configuration links

## 16.1 Stateless prefill link
> **CUT (low).** Query-param prefill without a run. Run-backed links (§16.2) cover the demo; this is a
> nice-to-have. Inference-provider CTAs already use stateless `model`/`reason`/`agentId` prefill on
> `/$owner/connectors/inference-provider:<slug>`. The former `/$owner/environments` route was only a
> redirect by the time this branch started and is now deleted; any remaining runtime prefill work must
> target the current sandbox-provider connector flow. Defer the remaining runtime prefill.

## 16.2 Run-backed configuration link
> **KEEP + GAP (high) — this is the demo's config mechanism; build it in Phase 0/1.** Correct design,
> but "reuse existing forms" (§18) **materially understates** the work: today **no** owletto route
> reads a `run_id`; **no** endpoint serves safe proposal fields from a run (this needs
> org + action-key + pending checks or it's an **IDOR on proposals**); **no** form submit completes a
> source run; **no** runtime-connections "new" route exists; and **neither** OAuth stack carries a
> `sourceRunId` (the only `source_run_id` in the codebase is scheduled-job provenance —
> `packages/server/src/tools/admin/manage_schedules.ts:128`). Build: the `run_id`-reading form route,
> the guarded proposal-serve endpoint, the run-completing submit, and `sourceRunId` threading through
> OAuth state.
> **Update (2026-07-15): largely SHIPPED** — agent/automation `run_id` prefill and the guarded pending
> endpoints landed in #1918/#1924; the still-missing piece is the inference/runtime-connection flow
> (`sourceRunId` through OAuth state).

# 17. Secret entry

Form opens blank; browser submits secrets directly to the authenticated gateway, which authenticates, validates membership + authority, verifies the source run matches/pending, validates safe fields against the proposal, validates credential fields against the registry, encrypts, creates, tests, completes the run, appends the terminal event, resumes the parent. Button: "Create and continue" — submission is both approval and secret entry.

> **KEEP.** Sound flow. **FIX cross-refs:** step 13 (append terminal event) depends on the §7
> supersede FIX; step 14 (resume parent) is CUT for launch per §6/global-directive-4 — replace with the
> "Connected — ask me again" notification. Step 4-7 (verify source run) is the IDOR guard from §16.2.

# 18. OAuth and device-code flow

Reuse existing flows; preserve `sourceRunId` inside signed server-controlled OAuth state. Do not trust an unsigned run ID from the browser/provider.

> **FIX (high).** "Reuse existing flows" understates it — **no** OAuth stack threads `sourceRunId`
> today (§16.2). The signing requirement is right; the threading is new work across both the connector
> connect-token stack and the inference-provider state stack
> (`packages/server/src/lobu/agent-routes.ts:694-885`).

# 19. Approval policy

Direct human admin action applies immediately (host tool-confirmation may count as human confirmation where policy allows — avoid double approval). Agent/automation/unattended changes create pending run + pending event + configureUrl. Destructive actions always require confirmation. Every pending mutation carries `expectedUpdatedAt` or a pre-image; approval fails with conflict on change.

> **FIX (high) — reconcile with the shipped write-gate, don't restate it (see §14 directive).**
> - "Destructive always confirms" → implement as an **unloosenable floor** (`min_effect`) in the
>   manifest; it is inexpressible in the current model where policy rows replace class defaults.
> - "Fail with conflict on change" → **replace** with the shipped **per-field stale-skip** (never
>   overwrites newer edits, applies non-stale fields). Do not build whole-row conflict.
> - "Host confirmation may count as human" → there is **no seam** for this today; MCP user sessions
>   resolve to `user`/`attended` and apply writes instantly (§5 FIX). Decide the host allowlist
>   (plan Q2) and add the signal, or treat all external-MCP config writes as agent-initiated
>   (→ pending run). **Recommended for launch: treat as agent-initiated** (always pending) — simplest,
>   safest, and matches the demo's HITL.
> - **GAP:** org-settings-change HITL exists on main (owner added it) — reuse that exact path for the
>   config-approval flow rather than inventing a second one.

# 20. Missing-runtime flow

External MCP: `user_action_required` + configureUrl; host retries. Lobu-native: parent blocked, child `waiting_for_user`, pending event; after setup child completes, parent requeues, conversation resumes.

> **FIX.** The external-MCP branch (return configureUrl, host retries) is the **lean, correct** pattern
> and is what launch should use for **both** branches (global directive #4). The Lobu-native
> auto-resume branch is the greenfield machine CUT in §6. Replace "parent resumes" with "notify user to
> re-ask."

# 21. Missing-inference flow

External MCP may create the first inference provider (external client supplies reasoning); a Lobu-native agent cannot bootstrap with no provider. Initial setup from external MCP, UI, CLI, deployment provider, or preconfigured org provider; return configureUrl when credentials required.

> **FIX (critical/demo) — the cold-start dead-end (WI-0.4).** Confirmed on main: with no system model
> keys, `ensureBuilderAgent`'s repair is a no-op, so the builder DM fails with "no model" until a human
> configures a provider in the web UI — the step the demo eliminates
> (`packages/server/src/auth/builder-provisioning.ts:175-189`;
> `packages/server/src/auth/system-provider-resolution.ts:55-105`). Fix in Phase 0: when the builder
> has no usable model, post the configureUrl instead of erroring.

# 22. Secret storage

Runtime prefix `runtime-connection:<id>:<field>`; on deletion, delete/expire every secret under the prefix. Inference providers keep row-unique secret identities. Resolution — runtime: connection cred → deployment fallback → provider self-auth; inference: user auth profile → org secret → deployment fallback.

> **FIX (critical/security) — deletion orphans live credentials today.** `deleteEnvironment`
> **intentionally leaves** the `environment:<id>:*` vault rows in place ("credential lifecycle is
> independent of the row"), so decryptable tokens for deleted resources persist indefinitely
> (`packages/server/src/lobu/stores/environment-store.ts:86-120`). The plan's "delete or expire under
> the prefix" is a **real fix**. The §25 migration must also **sweep already-orphaned prefixes** from
> past deletions.
>
> **FIX (critical/public) — the "deployment fallback" makes public exec free-to-abuse.** Keeping
> deployment-fallback creds + builtin exec on Lobu's own pods in the resolution chain means any
> authenticated external MCP user who reaches them runs arbitrary code **Lobu pays for and is liable
> for** (mining, outbound attacks from Lobu IPs). See §12/§26 GAP. **Directive:** external tokens may
> use **only** RuntimeConnections holding the **org's own** credentials — **no deployment fallback, no
> builtin, on the public surface.**
>
> **FIX (high) — inference resolution omits the `base_url` fail-closed rule** (§8 FIX). The stated
> chain would exfiltrate user tokens to org-configured URLs. Carry `inference-invariant.ts`.

# 23. Runtime implementation

Reuse existing embedded and remote implementations. Provider interface converges to create/get/exec/stop/resume/delete. Store the concrete provider sandbox ID on the Sandbox resource; do not make org+agent+conversation the only identity. Conversation-based auto-creation remains but resolves an explicit sandbox resource.

> **KEEP.** Storing the provider sandbox ID and resolving an explicit row (instead of recomputing the
> deterministic name) is the right change and is small (§13 KEEP).
> **FIX (high/plan-vs-reality) — `builtin` and `device` do not fit this interface (global directive #1):**
> - **builtin:** the workspace is `path.resolve('workspaces/<agent>/<conversation>')` on whichever pod
>   runs the worker, **with no volume in the worker chart** — ephemeral and per-replica. A builtin
>   sandbox row with `persistence:'persistent'` + `status:'ready'` is **required cross-pod state whose
>   filesystem exists on one pod's disk** — the multi-replica invariant AGENTS.md forbids. Sandboxes
>   would "resume" onto pods where their files don't exist.
>   (`packages/server/src/gateway/runtime/workspace.ts:36`;
>   `charts/lobu/templates/worker-deployment.yaml:133-161`). **Directive:** builtin is
>   **ephemeral-only** (never `persistent`) or **self-host/single-replica only** (the UI already hints
>   `availableInCloud: !isCloudMode()` — `environment-routes.ts:114-118`).
> - **device:** pull-model hardware (device polls and claims runs pinned to it, spawning a local CLI
>   executor). The gateway **cannot** exec into, stop, resume, or delete anything on user hardware; the
>   OS sandbox is applied by the device's own process and trivially disabled by the machine owner; and
>   external-MCP-driven exec on a personal device is a categorically different consent decision with
>   zero design here (`packages/server/src/worker-api/poll.ts:207-218,634-640`;
>   `packages/agent-worker/src/embedded/exec-sandbox.ts:17-23`). **Directive:** **exclude device from
>   the Sandbox model** — keep `device_workers` as the existing peer concept. Defer any device-as-
>   sandbox story with a consent model to post-launch.

# 24. GitHub coding flow

Connect GitHub → RuntimeConnection → Sandbox → clone → edit → test → generate patch → `publish_patch` via connector → PR → read checks/reviews → merge after approval. Do not put a long-lived GitHub App credential in the sandbox. Add reads for PR/diff/checks/reviews/mergeability/branch-protection; merge verifies checks/reviews/protection/base-sha/mergeability.

> **CUT (high) — defer the entire GitHub coding flow; it is not in the launch demo and has two
> security-critical blanks.** `publish_patch` does not exist
> (`packages/connectors/src/github.ts:769-770`). Blanks:
> 1. **Repo-clone credential inside the sandbox** vs the workers-never-get-real-credentials invariant —
>    the plan says "don't put the App credential in the sandbox" but then requires clone/push from
>    inside it. No resolution offered. (Correct answer is a gateway-fetched tarball + gateway-side
>    push, but that's unbuilt.)
> 2. **Patch bytes → gateway without transiting model output** — `run_sdk` caps output at 1MB
>    (`packages/server/src/sandbox/run-script.ts:1-8`) and tool inputs are model-generated
>    token-by-token, so there is no clean channel for a real patch.
> Plus a **TOCTOU-racy 6-condition merge preflight** duplicating what GitHub enforces atomically —
> pass the expected-head SHA to the merge call instead (`github.ts:1940-1956`). **Also name the known
> open seam:** the connector-worker sync path still ships **minted GitHub tokens to fleet workers**
> (`packages/server/src/utils/execution-context.ts:391-397`) — the plan should acknowledge it.
> **Lean launch coding story:** existing `create_pull_request` + **human merges** in GitHub. Cost to
> re-add the full flow: it's a whole workstream — schedule post-launch.

# 25. Database migration

`runtime_connections` and `sandboxes` tables (with a single-owner CHECK); add a nullable conversation→sandbox reference or binding table; add `parent_run_id`, `blocked_reason`, `expected_updated_at`. Mapping: environments → runtime_connections; `agents.environment_id` → `agents.default_runtime_connection_id`; `environment:<id>:*` → `runtime-connection:<id>:*`. Legacy Vercel sandboxes: choose Import or Recreate, don't mix.

> **KEEP (verified).** The `environments` → `runtime_connections` mapping is near-1:1
> (only `credential_name` vs `credential_prefix` differs), and `agents.environment_id` already exists
> and is read on the dispatch path (`environment-store.ts:140-171`).
> **FIX (critical) — the migration must add two things the plan omits (from §4/§22 FIXes):**
> 1. **NULL-owner private rows** violate the new ownership constraint on day one. Add a rule:
>    backfill `owner_user_id` from audit/creator, or demote unattributable private rows to org scope.
> 2. **Sweep already-orphaned secret prefixes** from past `deleteEnvironment` calls that left live
>    tokens behind.
> **DIRECTIVE (Q1 — Import vs Recreate):** **Recreate.** Legacy sandbox identity is a recomputed
> deterministic name with no persisted provider id (§23), so there is nothing clean to import; treat
> legacy conversation-derived sandboxes as legacy and create fresh explicit rows on next use. Simpler
> and avoids mixing identity systems.
> **DIRECTIVE (provider CHECK):** tighten to `vercel` only in this migration (§3 CUT).

# 26. Implementation phases

> **FIX (critical/scope) — the phase order is inverted relative to the demo. Reordered:**
>
> **Phase 0 — Demo-viable cut (NEW, first).** WI-0.1 automation-approval queue; WI-0.2 Slack identity
> mapping; WI-0.3 Slack-decidable approvals; WI-0.4 chat/MCP inference setup + cold-start fix; WI-0.5
> event-supersede fix; the §16.2 run-backed configure-link flow. **This is the launch demo.**
>
> **Phase 1 — Security + rename.** environments → runtime_connections **with** the §4 ownership
> enforcement + §22 credential-deletion sweep + NULL-owner backfill (§25); tighten provider CHECK to
> vercel; the §1.3 declarative redaction layer; unify agent create/delete under the write-gate (§15.8).
>
> **Phase 2 — Canonical services + write-gate extension.** Extract runtime-connection, inference-
> provider, agent-identity, and agent-settings services; make REST/SDK thin adapters; extend
> `WRITE_ACTION_MANIFEST` with new `WriteResourceClass` values + one generic action_key dispatcher
> (§14). **No ActionDefinition registry, no surface-parity CI.**
>
> **Phase 3 — Explicit sandbox resources (vercel-only).** `sandboxes` table; create/get/exec/delete
> (no stop/resume, no process/file APIs); gateway resolves explicit rows; per-command runs; the §5
> exec trust-anchor + network-widening gate.
>
> **Phase 4 — Conversation integration + public-exec safety.** conversation→sandbox binding table;
> `none`/`per_conversation` only; **quotas/rate-limits/idle-GC/reconciliation** (§26 GAP below) before
> the external path is public.
>
> **Post-launch — GitHub coding flow (§24), device/builtin-persistent sandboxes (§23), process/file
> APIs (§15.4/5), shared/org sandbox modes, auto-resume dispatcher (§6), stateless prefill links.**
>
> **GAP (critical/public) — the plan has no public-exec safety section. Add to Phase 4:** who pays for
> sandbox minutes; per-org caps (max sandboxes, concurrent execs, exec-seconds); rate limits on
> `sandbox.create/exec` (a multi-replica-safe Postgres rate limiter already exists —
> `packages/server/src/utils/rate-limiter.ts` — reuse it, it's used for OAuth/webhook ingest); idle-stop
> GC (the model has `lastUsedAt` but no sweeper); and row-vs-provider **reconciliation** (Vercel
> sandboxes auto-timeout and evict snapshots, leaving rows claiming `ready` for dead sandboxes —
> `packages/server/src/gateway/runtime/providers/vercel.ts:163-205`). External surface: **no builtin,
> no deployment-fallback creds** (§22).

# 27. Required tests

> **KEEP** every **security-invariant** test: private-connection isolation, credentials-never-returned,
> credentials-removed-on-deletion, cross-org rejection, provider-credential-absent-from-command-env,
> network-allowlist-not-widenable (**strengthen** to cover widening at create/update, not just command
> input — §5 FIX), delete+recreate-no-ciphertext-inheritance, secrets-absent-from-events/runs/logs/SDK
> (**add** an assertion on `action_input` and `run_sdk` script persistence — §1.3), stale-proposal
> conflict (**per-field stale-skip**, not whole-row — §19), agent-action-creates-pending, destructive-
> always-confirms (**against the `min_effect` floor** — §14).
> **CUT** the matrix rows for cut features: process APIs, file methods, stop/resume, shared/on_demand,
> org/agent ownership, GitHub merge, the REST-vs-SDK schema-drift CI.
> **ADD (demo/public):** Slack-identity-maps-to-correct-member (not owner); Slack approval card
> resolves a non-entity run; automation-create-by-agent queues (not 403); builder-with-no-model posts
> configureUrl (not error); pending+terminal approval events supersede correctly; base_url row refuses
> user/deployment token; per-org exec cap + rate limit enforced; idle sandbox swept.

# 28. Definition of done

> **NOTE.** The 22 DoD items are correct as end-state goals. Adjust for launch scope: items about
> sandboxes are **vercel-only**; item 20 (GitHub merge) is **post-launch**; item 21 (no parallel
> approval subsystem) is satisfied by **extending the write-gate** (§14), which the original §14 would
> have violated. Add three launch DoD items: **Slack turns attributed to the correct member; approvals
> decidable in Slack; the builder guides project/agent/provider/automation setup end-to-end without a
> human touching the web UI first.**

# 29. Final architecture

```text
RuntimeProvider → RuntimeConnection → Sandbox → Run
InferenceProvider → AuthProfile / Secret Reference
Agent → Conversation
Event = append-only human-visible lifecycle record
```

> **KEEP.** Diagram and both typical flows are correct. In the "Typical Lobu-agent flow," replace
> "parent resumes → Sandbox is created and bound" with "user re-asks after the Connected notification"
> for launch (§6/§20). All trust boundaries stand.

# 30. Review questions — answered

1. **Legacy Vercel sandboxes: import or recreate?** → **Recreate** (§25 directive; no persisted
   identity to import).
2. **Which MCP hosts may treat host confirmation as human approval?** → **None for launch.** Treat all
   external-MCP config writes as agent-initiated → pending run (§19). Revisit per-host later.
3. **Org-owned sandboxes initially?** → **No.** `user` + `conversation` ownership only (§5 CUT).
4. **File methods in v1?** → **No** (§15.5 CUT); Bash suffices.
5. **Which providers beyond Vercel are executable today?** → **None.** Vercel only; tighten the CHECK
   (§3/§23).
6. **Conversation `sandbox_id` column or binding table?** → **Binding table** — no single conversation
   row exists (§11 GAP).
7. **Ship process support with sandbox CRUD?** → **No, defer** (§15.4 CUT).
8. **Which sandbox ops need approval by default?** → `create`/`delete` and any `network` widening;
   `exec` gated by sandbox ownership + token scope (§5).
9. **Can the run schema represent parent blocking cleanly?** → **No — greenfield with sweeper traps**
   (§6 FIX). Add columns now; defer auto-resume.
10. **Legacy secret prefix retention policy?** → Sweep orphaned prefixes in the migration; delete under
    prefix on future deletions (§22/§25).

> **NOTE — the resource model and trust boundaries are unchanged, as the plan intended.** What changed
> is scope (demo-first, vercel-only, GitHub/process/file deferred), the write-gate directive (extend,
> don't duplicate), and roughly a dozen "reuse existing X" claims that were false and are now corrected
> with the real work each implies.
