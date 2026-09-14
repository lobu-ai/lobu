# Connected apps — generic installations surface

> **Status (2026-07-15):** **Partial** — `app_installations` + the chat install/DM binding shipped; the generic installation-list endpoint and connected-app UI phases are absent.

Status: PLAN. Supersedes the Slack-specific framing in
`slack-agent-onboarding.md`. Core insight (user): `app_installations` is
**provider-agnostic**; "load the user's installations and let them act on one"
is a generic feature, not a Slack panel. Slack is the first `deliveryKind:'chat'`
specialization.

## Framing

- One row per `(org, provider, provider_app_id, external_tenant_id)` in
  `app_installations` (provider ∈ github | slack | jira | …). Bot token / app
  creds live in the secret store via `auth_profile_id`.
- The **list** is generic. The **action** on an install specializes by the
  connector's declared `deliveryKind`:
  - `chat` (slack/telegram) → bind a channel/DM to an agent.
  - `data` (github/jira) → a connection that feeds org memory (already exists).
- The **install handshake** is already generic: `createInstallRoutes` mounts
  `/{provider}/install` + `/{provider}/oauth_callback` per bundled connector from
  its `authSchema` (no provider branch). So "+ Add an app" reuses declared paths.

## Current state (verified)

- Store speaks generically: `AppInstallationStore.listByOrg(org)` and
  `listByProviderAndOrg(provider, org)` (`lobu/stores/app-installation-store.ts:106,127`).
  Slack projection over it: `listSlackInstalls(org)` (`slack-installations.ts:272`).
- `slack_installations` table is **dropped** (`db/migrations/20260623000000_*`);
  everything is `app_installations` now.
- **No API endpoint** exposes the install list to the UI. Two split surfaces:
  - `$owner/sources/*` — data connectors (deliveryKind:data) as connections.
  - `components/agents/agent-channel-platform-detail.tsx` — chat reach; hardcodes
    a static "Add to Slack" (`managedInstallPath`) + a `/lobu link` code minter.
    It never lists existing installs → always nags "Add to Slack" even when the
    workspace is already connected.
- `deliveryKind` is on the connector decl (`connectors/src/slack.ts:90` = 'chat').
- `/lobu link` code is **not needed** for an installed workspace: with the bot
  token we open the DM (`conversations.open`) and list/join channels directly.
  Link survives only as the install-less hosted-preview / no-Slack-identity
  fallback.

## Generic model to build

1. **Generic list endpoint** — `GET /api/{org}/installations?provider=&deliveryKind=`
   → `listByOrg(org)` joined with connector metadata (provider, deliveryKind,
   display name, install path). Returns `[{ provider, tenantId, tenantName,
   status, deliveryKind }]`. Token-free (listing only).
2. **Action dispatch by deliveryKind** (consumed per surface):
   - chat → "pick a connected workspace → bind a DM/channel to this agent"
     (resolve bot token from the install → `conversations.open` / `conversations.list`
     + `conversations.join` → `POST <agent-api-base>/api/v1/agents/{id}/channels`,
     where the Agent API base is `<origin>/lobu` on the embedded server).
   - data → link to the existing Sources connection (no new action).
3. **"+ Add an app"** — when no install for the wanted provider, link to the
   declared `/{provider}/install` path (generic, already mounted).
4. **Identity match** — since the user signed in with Slack, match their Slack
   team (from their `account` row) to an install → "Your workspace *Acme* is
   connected", auto-select it.

## First slice (web-first chat onboarding)

Replace the "always Add to Slack" reach UI with: load installs → show connected
workspaces → pick → bind a DM (auto) or channel (picker). Add-to-Slack demoted to
"+ Add another workspace", primary only when the list is empty. Built on the
generic endpoint; Slack is just the first deliveryKind:chat consumer.

## Event-sourcing the connect (from prior discussion)

- At bind time: (a) **inline** "Connected ✓ — try asking me X" DM (immediate;
  do NOT route through a cron automation), and (b) append a `slack_connected` /
  `app_connected` lifecycle **event** to the user's `$member` entity
  (semantic_type `event`).
- Automations are `scheduled`/`manual` only (no event push trigger), but can DM via
  the `notify` tool (supports bot-connection delivery + rich cards + automation
  attribution). So **deferred** onboarding (drip, re-engagement, "you connected
  but set no goal") = a scheduled automation reading those events. Editable, not
  hardcoded.

## Phasing

1. **P1** — generic list endpoint + reach-UI flip (load installs, pick, bind DM)
   + identity match. Slack first; the endpoint is provider-generic.
2. **P2** — `conversations.list/join` channel picker (bind shared channels) +
   inline welcome DM + the `app_connected` lifecycle event.
3. **P3** — starter onboarding automation (scheduled) reading the events → `notify`.
4. **P4** (optional) — unify Sources (data) on the same generic list primitive;
   org-level "Connected apps" page spanning all providers.

## Open decisions

- **Surface**: build an org-level "Connected apps" page now (all providers), or
  just consume the generic endpoint inside the existing per-surface UIs
  (agent-channels for chat, Sources for data) for now? (Lean: endpoint now,
  consume in agent-channels first; org-level page = P4.)
- **v1 action scope**: chat-bind only (slack/telegram), data installs shown
  read-only linking to Sources?
- **Bind granularity v1**: DM-only auto-bind (one click) vs DM + channel picker.
- **Stacking**: build on #1562 (Sign-in-with-Slack) before it merges, or wait for
  merge to avoid a stacked branch?
