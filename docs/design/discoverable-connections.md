# Discoverable connections and owner requests

Status: proposed design, not a shipped capability. This document does not
authorize or implement API, SDK, schema, or deployment changes. The new
`visibility` value and any request storage need explicit confirmation before
implementation.

Evidence checked on 2026-10-11 against `origin/main` at
[`3ed105a5062713a7de86d3f8bf7b80e69cb5441f`](https://github.com/lobu-ai/lobu/tree/3ed105a5062713a7de86d3f8bf7b80e69cb5441f).
Revalidate this baseline before implementation.

## Problem

An agent working for one member often needs information that only lives in
another member's private connection, such as a colleague's work email. Current
connection visibility offers private owner access or `org` visibility, still
subject to resource ACLs and connector policy. It has no metadata-only option
for discovering a private connection. Personal OAuth connections cannot be
`org`-visible at all.

The missing piece is a way to ask the connection's owner for help without
gaining read access to the connection.

## Decision

Being **discoverable**, **contactable**, **readable**, and **shareable** are four
different permissions. Express them through existing mechanisms instead of
adding a separate system for each:

```text
discoverable connection → protected request → owner-controlled Automation → authorized reply
```

Agents decide what to ask, how to research, and what answer to propose. The
server enforces who can read the request, the research, and the answer.

## What already exists

| Building block | Where |
| --- | --- |
| `connections.visibility` is `'private'` or `'org'`. The connection-level gate admits a connection when it is `org`, or when the principal created it. A `null` principal sees only `org` connections. Resource ACLs still apply to its content. | [`packages/server/src/authz/connection-visibility.ts`](../../packages/server/src/authz/connection-visibility.ts), [`resource-visibility.ts`](../../packages/server/src/authz/resource-visibility.ts) |
| Personal-credential (`oauth_account`) connections can never be `org`-visible; a trigger rejects it. | [`db/migrations/20260703200000_connection_personal_cred_private_guard.sql`](../../db/migrations/20260703200000_connection_personal_cred_private_guard.sql) |
| Headless Automation operation discovery and execution use the Automation creator for connection visibility while retaining the autonomous policy principal. Source-window reads likewise fall back to `automation.created_by` when there is no caller identity. | [`automation-connection-visibility.ts`](../../packages/server/src/authz/automation-connection-visibility.ts), [`automation-mode.ts`](../../packages/server/src/tools/get_content/automation-mode.ts) |
| Organization connector policy (Auto / Ask / Block) is the single approval evaluator for connector operations. | `evaluateConnectorPolicy` in [`connector-policy.ts`](../../packages/server/src/authz/connector-policy.ts) |
| Durable events, Automation triggers and runs, notifications, and the delivery queue. | [`docs/AUTOMATIONS.md`](../AUTOMATIONS.md) |

Because the visibility compiler treats every value other than `org` as
owner-only, a new non-`org` value is denied to other members by construction on
every read seam that uses it. Any code that compares `visibility = 'private'`
directly must be audited before adding the value.

These building blocks do not yet enforce the proposed audiences for derived
content. [`notification_targets`](../../packages/server/src/notifications/service.ts)
scopes inbox recipients and read state, not event-body confidentiality. The
[resource gate](../../packages/server/src/authz/resource-visibility.ts) admits
server-authored interaction events for organization members, subject to the
separate connection gate. Protected request, research, and approval bodies
therefore need audience enforcement before enabling this flow.

## Proposed flow

### 1. Discover

Add `discoverable` to the existing field: `private | discoverable | org`.

| Visibility | What other workspace members can do |
| --- | --- |
| `private` | Nothing. The connection does not appear in ordinary agent listings. |
| `discoverable` | See the owner, connector type, an owner-approved description, and a request action. |
| `org` | Discover and use the connection under existing org permissions. |

Every data read treats `discoverable` exactly like `private`. Personal
connections default to `private`; owners opt into `discoverable`. A personal
OAuth connection may be `private` or `discoverable`, never `org`.

### 2. Request

The requesting agent supplies the question, a justification, the requested
source, and a proposed reply destination. The server resolves the requester and
owner identities; neither comes from client text.

In one transaction, persist one protected request event and enqueue two
independent jobs:

- notify the owner through their inbox or a configured channel with an authorized audience;
- activate the Automation the owner selected to handle these requests.

A matching event subscription alone must never authorize another Automation to
receive the request.

### 3. Research

The owner's selected Automation runs in the workspace that holds the
connection, reusing creator-derived access for private connections. The run is
narrowed to explicitly selected sources and tools, starts with fresh context,
and routes any outbound communication through the reply step below.

Changing the Automation's instructions, tools, or sharing rules invalidates the
owner's earlier authorization.

### 4. Keep research private

| Content | Audience |
| --- | --- |
| Request and its status | Requester and owner |
| Research, tool results, transcript, draft answer | Owner |
| Released answer | Explicitly authorized recipients |

This covers notifications, approvals, attachments, search, and direct reads.
New owner-private runs must not inherit the owner/admin oversight of the
existing [Automation transcript route](../../packages/server/src/gateway/routes/public/agent-history.ts):
workspace administrators govern the feature without automatically reading the
connection owner's email.

### 5. Release

By default, the owner approves the exact answer and destination. The owner may
instead create a standing rule for automatic replies, for example: "this
Automation may answer Maya from this source, in our direct conversation, until
Friday."

Organization connector policy still applies to each connector operation. Block
denies the operation; Ask requires an authorized human; Auto permits unattended
execution of that operation. None of these grants permission to disclose data.

An instruction such as "only share work-related information" is agent judgment,
not a privacy guarantee. The enforceable boundaries are selected sources,
recipients, tools, destination, expiry, and revocation. Owners who need control
over the wording should use approval.

### 6. Reply

Immediately before dispatch, recheck authority, expiry, destination, audience,
and the approved payload. Publish an authorized copy for the recipient; the
draft and evidence stay owner-only. If delivery is uncertain, reconcile before
retrying. Revocation stops future work and sends; it cannot retract an answer
already delivered.

## Request lifecycle

```text
received → running → awaiting approval → sending → replied
                         ↑
             a standing auto-reply rule skips this

terminal exceptions: blocked, declined, cancelled, expired, failed
```

Delivery receipts, inbox read state, and Automation execution stay separate.
Reading a notification neither approves nor completes a request.

## Alternatives considered

| Approach | Assessment |
| --- | --- |
| Targeted notifications only | Useful plumbing, but inbox targeting does not protect the request content or the research. |
| Require personal workspaces for private connections | Works for personal accounts, but breaks private connections that already live inside team workspaces. |
| Research beside the connection, with explicit audiences and controlled replies | Recommended. Works for both workspace types and builds on existing authorization. |

The design borrows one idea from trusted-contact assistants: a shared or group
agent never touches a member's personal accounts directly, and it asks that
member's own agent, which applies the member's sharing rules. An audience change,
such as someone joining a group, pauses pending shares until sharing with the
larger audience is authorized.

## Implementation slices

1. **Protected content.** Consistent audience checks for requests, private runs,
   and approval and notification bodies.
2. **Discovery and distribution.** Minimal discoverable metadata, addressed
   request events, and authorized Automation activation.
3. **Bounded owner execution.** Selected sources, consistent owner access,
   protected outputs, and authorization invalidated by material configuration
   changes.
4. **Controlled replies.** Exact-answer approval, scoped automatic sharing,
   revocation, and reliable delivery.

## First release scope

- Same workspace, one requester to one owner.
- One owner-selected Automation per discoverable connection.
- Manual approval and explicitly authorized automatic replies.
- Reuse existing events and runs for request state before introducing a table.

Groups and cross-workspace delivery come later, through a narrow request and
reply relay.

## Open questions

- Where the owner-approved description is stored, and whether it needs its own
  review step before it becomes visible.
- How an owner selects the handling Automation, and what happens to pending
  requests if that Automation is deleted or edited.
- Whether `discoverable` should ever extend beyond workspace members.
