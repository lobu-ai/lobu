# ChatGPT MCP Events: integration boundary and plan

Status: proposed integration, not a shipped capability. This document does not
authorize or implement API, SDK, schema, or deployment changes.

Evidence checked on 2026-10-08 against `origin/main` at
[`a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab`](https://github.com/lobu-ai/lobu/tree/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab).
The source checkout was refreshed before inspection. Production operation,
unmerged branches, and a live ChatGPT subscription were not tested. Revalidate
this baseline before implementation.

## Decision

Lobu already has durable events, Automation activation and processing windows,
notification delivery, cross-replica invalidations, and MCP Apps communication.
Do not build another event engine to support ChatGPT. The missing exposure at
the inspected MCP endpoint is the ChatGPT Events subscription/delivery contract.

Implement that boundary by composing existing producer, authorization, and task
lifecycles. Preserve the distinction between delivering a notification and
completing an Automation window. A subscription that only forwards an event
should not require an agent turn or extraction contract.

## Four different meanings of events

| Surface | Purpose | Existing Lobu boundary |
| --- | --- | --- |
| Domain events and Automations | Record facts and execute governed work. | Event persistence, declared triggers, durable runs, claim/complete. |
| Workspace invalidations | Tell a connected view to reread current state. | Postgres LISTEN/NOTIFY, SSE, reconnect resynchronization. |
| MCP Apps messages | Connect an embedded UI to its host. | JSON-RPC over `window.postMessage`; UI notifications, tool calls, messages, model-context updates. |
| ChatGPT MCP Events | Let an authorized external subscription receive matching events. | Not exposed by the inspected MCP endpoint; proposed adapter below. |

The first three are not substitutes for the fourth. Conversely, adding the
fourth does not replace any of them. Generic MCP resource notifications and
`subscriptions/listen` are also not the ChatGPT webhook contract.

## Verified source map

Paths below refer to the baseline revision above, not a production assertion.

| Evidence | Finding |
| --- | --- |
| [Core constants][constants] | `MCP_PROTOCOL_VERSION` is `2025-11-25`. |
| [MCP handler][handler] | Advertises `tools` and `resources`; its `server/discover` probe deliberately returns method-not-found for legacy fallback. |
| [MCP resource integration test][mcp-test] | Asserts discovery error `-32601`, then a successful initialized legacy session. This is positive evidence of the boundary, not only an empty search result. |
| [Views bridge][bridge] | Implements MCP Apps UI messages and the custom `lobu/notifications/data-changed` notification. The custom notification is explicitly Lobu-host-specific. |
| [Invalidation emitter][emitter] | Cross-replica LISTEN/NOTIFY; event-write invalidations share the writer transaction; reconnect sends `resync`. Lost invalidations are repaired by rereading durable state, not replaying NOTIFY. |
| [Automation contract][automations] | Describes arrival marks, leased claims, fenced completion, paging, and durable execution. These are existing mechanisms, not work introduced by this proposal. |
| [Platform event catalog][catalog] and [event write funnel][insert-event] | Platform lifecycle events have a catalog and activation path, including `queueWorkspaceEventActivationInTransaction`. Workspace activation is not limited to declared Automation outputs. |
| [Notification service][notifications] and [delivery records][delivery] | Existing durable notification tasks, per-destination attempts, idempotency identities, and provider-acceptance projection. |

One documentation caveat matters: the output-only description in parts of
`AUTOMATIONS.md` is narrower than the platform-event implementation. Do not
turn that prose into a claim that platform lifecycle subscriptions are absent.
Trace the actual producer and authorization path for each event selected for
external exposure. Ordinary content writes are not thereby promised to activate
every subscription.

## External contract to target

The [OpenAI MCP Events guide][openai-events], checked on 2026-10-08, requires
protocol `2026-07-28`, an `events` capability from `server/discover`, and
`events/list`, `events/subscribe`, and `events/unsubscribe` on the authenticated
MCP endpoint. ChatGPT uses verified HTTPS callbacks with Standard Webhooks
signatures, not polling or streaming. Subscriptions persist, refresh, expire,
and can be stopped. Deliver one event per request, at most 256 KiB, preserving
its event ID across retries. A `2xx` means receipt, not completed execution;
`410` and `413` are not retryable. Supported testing surfaces include Work
cloud chats and dots. The guide is authoritative for exact schemas, callback
verification, TTL/rotation, headers, replay cursors, and supported features; do
not copy an evolving draft into a second local protocol specification.

## Proposed implementation slices

### 1. Add protocol support without breaking existing clients

Implement a genuine modern request path and discovery response alongside the
existing compatibility path. Do not simply change the shared version constant:
the current handler, session recovery, CLI/proxy clients, and tests encode
legacy semantics. Keep their working tool and resource flows intact. The Apps UI
bridge version is a separate negotiation surface.

Use the same tool execution and authorization funnels on both protocol paths.
Before advertising Events, prove the new discovery and methods reach the real
authenticated endpoint, with the same workspace grants and no alternate bypass.
Protocol compatibility can ship separately, but must not advertise an event
whose registration and delivery are not implemented.

### 2. Project a small, governed event catalog

Start with a user-targeted notification event, provisionally named
`notification.created`. That name is a proposal, not an existing public method
or approved event contract. Reuse notification creation, targeting, and run
provenance rather than waking an extra model merely to forward a notification.

For later connector, platform, and Automation-output events, derive definitions
from their existing catalogs while retaining their provenance boundaries. Do
not merge platform audit types into user-savable content kinds. Select an
explicit supported subset; never publish all internal audit rows by default.

Keep event discovery separate from permission to receive a particular event.
For the first slice, the subscribing principal must be an actual recipient of
the notification and remain entitled to its underlying data. Workspace
administration or connection visibility alone must not imply source access.
Filter before queuing and recheck before sending. Payloads should contain a
bounded summary and governed read references, not raw credentials, internal
request metadata, or full private transcripts.

### 3. Persist external registration state, not a second workflow

A callback registration and an Automation trigger have different lifetimes and
owners. Compose existing storage/secret facilities first. If they cannot
represent the contract safely, propose the smallest persistence change in a
separate approved design; this document does not mandate a new table.

Conceptually bind each registration to a verified principal, OAuth client/grant,
explicit workspace, event/filter identity, callback, protected signing material,
and lifecycle state. Do not infer the workspace later from a mutable selected
organization or trust a caller-supplied owner. Canonicalize identity through one
shared helper so equivalent requests meet the same registration.

Keep signing material out of events, logs, tool results, and worker-visible
credentials. Account disconnect, access loss, expiration, and unsubscribe must
fence future attempts, including already-queued work. Decide and test the race
boundary for an HTTP request already in flight; do not promise its retraction.

### 4. Add a destination adapter to the durable task lifecycle

```text
Existing producer commits a governed event
    -> establish durable pending delivery for matching registrations
    -> existing task infrastructure claims a delivery attempt
    -> recheck registration generation and authorization
    -> callback adapter sends the event
    -> record delivery outcome

Subsequent ChatGPT tool calls
    -> existing governed reads/actions
    -> claimNextWindow / completeWindow only when processing an Automation
```

Use the existing task infrastructure and attempt/receipt concepts, but give
external subscriptions an explicit destination identity. A callback is not a
chat `channelKey`, and the existing chat fan-out must not widen its audience.

Make event-to-pending-delivery creation transactional or independently
recoverable. A crash after the event commits and before an in-memory send must
not lose the work. The invalidation emitter is only a latency hint here: its
reconnect resync cannot recreate a durable delivery obligation by itself.

Keep one immutable delivery envelope per event occurrence and registration.
Retries must reuse that identity and payload rather than rebuilding a different
record under an old ID. `events.id` identifies a stored version; connector
`origin_id` is source identity within its connection. Decide whether a producer
emits versions or logical occurrences, then key deduplication accordingly. A
connector resync must not accidentally create a second logical notification.

Use separate outcomes for provider acceptance and application processing. Never
advance `automations.next_window_start` because a callback was accepted. A
ChatGPT run that takes an Automation claim still follows the existing completion
contract, including a legitimate empty result.

Harden callback egress at the connection boundary: validate and pin public
addresses for the actual connection, preserve TLS hostname checks, and reject
redirects. Apply the same policy during verification. Bound bytes, time, retry
count, queue age, and concurrency; keep typed, redacted failure receipts.

### 5. State replay guarantees honestly

The first slice can omit historical protocol replay while still durably
retrying deliveries accepted into its active registration lifetime. These are
different guarantees. State that distinction explicitly; do not imply that
Lobu's retained event log automatically gives every subscription a replay API.

Any later replay cursor belongs to a subscription/filter scope, not an
Automation processing mark. It must reflect contiguous safe progress despite
out-of-order completion and concurrent commits. A maximum event ID or wall-clock
time alone is not proof that no earlier delivery remains outstanding. Retention
and source-backed data availability must be part of that later contract.

## Acceptance criteria for implementation

These are future tests, not results claimed by this documentation PR.

| Boundary | Required proof |
| --- | --- |
| Protocol | Real modern discovery and event calls succeed; existing legacy tools, resources, Apps, and session recovery remain supported. |
| Ownership | Cross-workspace, wrong-recipient, wrong-client, and revoked-source cases fail closed through real authenticated routes. |
| Lifecycle | Equivalent registrations are idempotent; refresh, key rotation, expiration, unsubscribe, and access loss affect queued attempts correctly. |
| Callback security | Invalid secrets/challenges, DNS rebinding, non-public addresses, redirects, oversized bodies, and slow receivers are refused without data leakage. |
| Crash recovery | Commit-to-enqueue failure, worker restart, ambiguous HTTP success, and duplicate dispatch retain one logical delivery identity with observable attempts. |
| Multiple replicas | Three replicas can create, refresh, claim, and stop a registration without session affinity or duplicate ownership. |
| Source coverage | Every advertised producer has a real trigger-to-delivery test; excluded content/audit writes stay excluded. No notification loop is caused by delivery audit writes. |
| Processing | Provider acceptance does not complete an Automation; explicit claim/completion still fences stale workers and advances only covered windows. |
| Host end to end | Rescan the plugin, subscribe in a supported ChatGPT host, deliver a matching event, and observe the requested response. Prove nonmatching events and unsubscribed events are not delivered. |

## Rollout and non-goals

Review the public event shape and any persistence/SDK changes before coding.
Then land protocol compatibility, registration/delivery, and one fully tested
producer in reviewable slices. Preserve the existing notification channels and
Apps UI. Advertise only the portion whose end-to-end operation has been proven.
Record the deployed squash revision and host acceptance evidence before calling
the feature shipped.

This plan does not introduce another event store, broker, scheduler, fact engine,
worker claim API, or universal subscription taxonomy. It does not promise
exactly-once external effects, arbitrary history replay, or live UI refresh in
a host that does not implement Lobu's custom invalidation message.

[openai-events]: https://developers.openai.com/plugins/build/mcp-events
[constants]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/core/src/constants.ts
[handler]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/server/src/mcp-handler.ts
[mcp-test]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/server/src/__tests__/integration/mcp/mcp-app-resources.test.ts
[bridge]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/views/src/bridge.ts
[emitter]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/server/src/events/emitter.ts
[automations]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/docs/AUTOMATIONS.md
[catalog]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/server/src/automations/platform-event-catalog.ts
[insert-event]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/server/src/utils/insert-event.ts
[notifications]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/server/src/notifications/service.ts
[delivery]: https://github.com/lobu-ai/lobu/blob/a6c4752b783bf6c9fd9b821be10c15c3f5ecfeab/packages/server/src/notifications/delivery.ts
