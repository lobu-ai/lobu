# Design: Consolidated `app_installation` auth primitive (v2 — codex review incorporated)

Status: draft for review (v2)
Scope: connector-sdk + server (gateway) + owletto; multi-migration path

## Changelog v1 → v2 (codex high-reasoning review)
- **Reversed the core decision:** dedicated `app_installations` table, NOT a new `auth_profiles.profile_kind`.
  `auth_profiles.account_id` has an FK to `account(id)` (baseline.sql:4667) and `auth_profiles_connector_key_required`
  forces a connector_key — both make overloading `auth_profiles` for provider-level tenant installs wrong.
  This is still the consolidation goal: **one `app_installations` table reused for all providers**, replacing
  `slack_installations`; `auth_profiles` stays the *credential* backing (linked via `auth_profile_id`).
- Provider identity widened to `(provider, provider_instance, provider_app_id, external_tenant_id)`.
- Webhook routing/verification → **provider plugins** (verifier + tenant extractor), not a single JSON path.
- Worker-creds invariant made explicit: connectors get a **placeholder**, never the real installation token.
- Slack migration: **dual-write → backfill → dual-read → hardened drop**.
- Added install lifecycle (suspended/removed/revoked, mint failure, unknown-webhook-before-callback) + 3-replica tests.

## 1. Goal

A single reusable **`app_installation`** primitive for *org/workspace-scoped* integrations (GitHub App,
Slack app, Jira site, Google Workspace) — install once per tenant → tenant-scoped token + events flow —
and consolidate the bespoke per-provider install storage onto it (Slack today; GitHub/Jira next).

Non-goal: replacing OAuth *user-token* auth. `oauth_account` stays for **user-scoped** data (Gmail,
calendar, a user's own repos). Connectors pick by resource scope. The two coexist on one connector
(multiple `authSchema.methods`); resolver precedence defined in §4.5.

## 2. Current state (ground truth)
- `auth_profiles` — generic credential table, `profile_kind ∈ {env, oauth_app, oauth_account, browser_session, interactive}`.
  `account_id` is an **FK to `account(id)`** (baseline.sql:4667). `auth_profiles_connector_key_required`:
  connector_key NOT NULL unless browser_session (baseline.sql:535).
- `account` — OAuth user tokens (for oauth_account).
- `connections` — connector connections; link `auth_profile_id` + `app_auth_profile_id`.
- `slack_installations` (20260619120000) — bespoke: `(id, organization_id, team_id, team_name, bot_user_id, config, status)`,
  UNIQUE(org, team_id), index(team_id). Reinstall = upsert + **stop older rows** (slack-installation-store.ts:130) — i.e.
  NOT a hard global unique today.
- `agent_connections` (platform: webhook/slack/...) — chat/ingest; secrets in SecretStore.
- SecretStore — inconsistent prefixes (`installations/`, `webhooks/`, `connections/`).

## 3. Storage: dedicated `app_installations` table (the consolidation point)

```sql
app_installations (
  id                bigint primary key,
  organization_id   text not null references organization(id) on delete cascade,
  provider          text not null,                       -- 'github' | 'slack' | 'jira'
  provider_instance text not null default 'cloud',       -- 'cloud' | GHES host | atlassian site class
  provider_app_id   text not null,                       -- which Lobu App (supports >1 App per provider)
  external_tenant_id text not null,                      -- installation_id / team_id / cloudId
  auth_profile_id   bigint references auth_profiles(id), -- credential backing (token/app-secret refs)
  status            text not null,                        -- active | suspended | revoked | error | pending
  metadata          jsonb not null default '{}',          -- bot_user_id, account login, permissions, events, enterprise_id
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
)
-- Active-ownership invariant (provider-app-aware, not the blunt v1 form):
CREATE UNIQUE INDEX app_installations_active_tenant
  ON app_installations (provider, provider_instance, provider_app_id, external_tenant_id)
  WHERE status = 'active';
-- Routing lookup (shared webhook endpoint, no org context):
CREATE INDEX app_installations_route
  ON app_installations (provider, provider_instance, provider_app_id, external_tenant_id);
```

Separation of concerns: `app_installations` = "external tenant install + routing authority";
`auth_profiles` = "credential profile". `connections.auth_profile_id` still points at the credential row;
the install row references the same `auth_profile_id`. Webhook routing gets a purpose-built index instead
of overloading `auth_profiles`.

**Product rule (DECIDED: reject/transfer — one active owner).** An external tenant (e.g. a GitHub org)
has exactly one active owning Lobu org. Reinstalling under a different org *transfers* ownership: the prior
row goes `status<>'active'` (kept for audit/rollback), the new row becomes active. Enforced by the
`WHERE status='active'` unique index — not a silent `ON CONFLICT`. Fan-out (one tenant → multiple orgs) is
explicitly out of scope.

## 4. Design

### 4.1 connector-sdk contract (additive, non-breaking)
1. New auth method `ConnectorAuthAppInstallation { type:'app_installation'; provider; providerInstance?; appIdKey?; privateKeyKey?; installUrlTemplate?; permissions?; events? }` → add to `ConnectorAuthMethod`.
2. Rich installation context (not a bare id), on **all** execution contexts (`SyncContext`, `QueryContext`,
   `ReflectContext`, `ActionContext`, webhook contexts):
   `installation?: { id; provider; providerInstance; providerAppId?; externalTenantId; metadata? }`.
3. Webhook delivery mode: `delivery?: 'registered' | 'app_installation'` (default 'registered'). In
   `app_installation` mode `registerWebhook`/`unregisterWebhook` are no-ops; routing+verification are handled
   by a **provider plugin** (§4.3), not by `routingKeyPath` alone.
4. **Connection→installation selection:** a connector connection must record *which* install + scope it uses
   (e.g. GitHub org/repo subset). Store on `connections.config` (e.g. `{ installation_ref, repo_scope }`).

### 4.2 Per-provider token provider — preserves "workers never see real creds"
```ts
interface InstallationTokenProvider {
  provider: string;
  mintToken(install: AppInstallationRow): Promise<{ token: string; expiresAt: string }>; // cache+refresh; gateway-only
  // lifecycle hooks: onRevoked / onSuspended / mint-failure handling
}
```
- **GitHub:** App JWT (`GITHUB_APP_ID`+private key) → `POST /app/installations/{id}/access_tokens` (~1h, cache+refresh).
- **Slack:** bot token obtained at OAuth-install; `mintToken` resolves the stored ref (no minting).
- **Worker-creds invariant:** connector code receives a **`lobu_secret_<uuid>` placeholder** and never
  the installation token. As shipped, the token travels to the worker HOST as `credentials.accessToken`
  and the isolate lane's own vault (`connector-worker/src/egress/credentials.ts`) mints the placeholder
  and swaps it back **at egress**, in the same grammar the gateway secret-proxy uses on its own route.
  Private keys + minting stay gateway-side, and the host holds the token for one run only.

### 4.3 Shared-endpoint webhook router (provider plugins)
`POST /api/v1/app-webhooks/:provider` →
1. **Provider verifier** (plugin): GitHub raw-body HMAC; Slack `v0:{ts}:{rawBody}` + timestamp freshness;
   Jira per app type. Not schema-driven (`ConnectorWebhookSchema` is HMAC-only — insufficient here).
2. **Provider tenant extractor** (plugin): pull `(provider_instance, provider_app_id, external_tenant_id)`
   from body/headers/site-URL (GitHub: `installation.id` + headers; Slack: `team_id`/`enterprise_id`, possibly
   form-encoded under `payload`; Jira: cloudId/clientKey).
3. Resolve `app_installations` (active) → `organization_id` → dispatch to the install's feeds that declare
   the delivery's event type (marked due, or recorded through the feed's `normalize`). A delivery no feed
   declares is acked with nothing triggered; nothing is stored raw. Multi-replica safe (stateless; Postgres-mediated).
4. **Unknown tenant before callback:** buffer/ack-and-drop with a log (don't 500); reconcile on install callback.

### 4.4 Install/connect flow
- UI: **"Install on GitHub"** for app_installation connectors. Callback (`installation_id`, `setup_action`)
  → upsert `app_installations` (+ credential `auth_profiles` row for the App secret/token refs) → create/link `connections`.
- Idempotent upsert on the active-tenant invariant; handle `setup_action ∈ {install, update, request}`.

### 4.5 Auth methods + resolver precedence (DECIDED)
For the GitHub/org connector the methods are: **`app_installation` (primary)** → existing **`env`** PAT
(per-connection token via the "API Key/Token" tab; the cloud escape hatch for orgs that can't install the App)
→ existing **`env_keys`** (deployment `GITHUB_TOKEN`; the self-host/single-tenant fallback). All three of the
fallbacks already exist — **no new code**. The per-org **`oauth_app` (OAuth-app-profile) path is DELETED** for
this connector (the "select an app profile first" flow).
Note: this does NOT remove #1427's env-creds fix — that stays for **user-scoped** `oauth_account` connectors
(Gmail, Calendar, a user's own repos). Only GitHub's *org-level* `oauth_app` use is superseded.
Resolver precedence is explicit + tested to avoid ambiguity when more than one method is configured.

### 4.6 Secret naming
Standardize `installs/<appInstallationId>/<credType>` (token, appWebhookSecret, privateKeyRef). Copy (not move)
during Slack retrofit so rollback is possible.

## 5. Cross-cutting constraints (AGENTS.md)
- Multi-replica: token cache per-pod best-effort (re-mint on miss); installs/connections hydrate on demand; no restart fan-out.
- `events` append-only — unchanged.
- Two-phase / squawk: `app_installations` is a new table (CREATE TABLE IF NOT EXISTS — no expand/contract on the
  hot `auth_profiles`, avoiding the connector_key/account_id constraint surgery entirely — a key win of the dedicated table).
  Indexes `CONCURRENTLY` + squawk-ignore; verify locally (gate not in make review).

## 6. Migration & consolidation plan
Phase A — primitive + GitHub (greenfield; zero migration risk):
1. sdk additive types. 2. `app_installations` table + indexes. 3. gateway `InstallationTokenProvider` + GitHub impl
   + placeholder/egress-swap wiring. 4. shared webhook router + GitHub plugin. 5. owletto GitHub install flow;
   github authSchema gains `app_installation` (keep OAuth/PAT as fallback methods).

Phase B — Slack retrofit (proves abstraction; pays down bespoke code), strict order:
6. **Dual-write**: Slack OAuth install writes BOTH `slack_installations` and `app_installations` (+ copy secret refs).
7. **Backfill** existing `slack_installations` → `app_installations`.
8. **Dual-read**: routing/hydration prefer `app_installations`, fall back to `slack_installations`.
9. Map Slack specifics: enterprise installs (`enterprise_id`), stopped→revoked status, reinstall→active-unique transfer.
10. **Drop** `slack_installations` (release N+1) ONLY when: all pods run no-read code, all writes migrated, secrets
    copied, rollback no longer needs it, ownership/duplicate cases reconciled.

Phase C — Jira (third consumer; validates generality), then retire remaining bespoke paths.

## 7. PR breakdown
1. sdk: app_installation method + installation context (all contexts) + delivery mode (types+tests).
2. db: `app_installations` table + indexes (concurrent).
3. gateway: `InstallationTokenProvider` interface + GitHub minting + secret-proxy placeholder/egress swap.
4. gateway: `/app-webhooks/:provider` router + GitHub verifier/extractor plugin.
5. owletto+connector: GitHub App install flow; github authSchema → app_installation; connection→install scope.
6. slack: dual-write + backfill (Phase B.6–7).
7. slack: dual-read + specifics (B.8–9).
8. db: drop `slack_installations` (contract, release N+1).

## 8. Must-fix before implementation (from review) + open decisions
1. Dedicated `app_installations` table (done in v2) — do NOT touch `auth_profiles.account_id`/connector_key.
2. Active-ownership invariant `(provider, provider_instance, provider_app_id, external_tenant_id) WHERE status='active'`.
3. **DECIDED: reject/transfer** (one active owner; reinstall transfers; fan-out out of scope).
4. Provider webhook verifier + tenant-extractor plugin contracts (not single JSON path).
5. Worker-creds: placeholder + egress swap; private key + minting gateway-only.
6. Slack: dual-write → backfill → dual-read → hardened drop.
7. Slack enterprise installs + status mapping explicit.
8. Avoid `auth_profiles` constraint surgery (dedicated table sidesteps it).
9. Install lifecycle: removed/suspended/revoked, token-mint failure, unknown-webhook-before-callback.
10. Tests for 3-replica: concurrent install callbacks, webhook to cold pod, duplicate provider delivery, Slack read precedence.

## 9. Open questions for product/eng
- One Lobu GitHub App for all orgs vs per-tier Apps (`provider_app_id` supports either; pick default).
- Keep PAT/OAuth user-token as first-class fallbacks long-term, or app_installation-only once mature?

## 10. Consolidation ledger (goal: net-fewer moving parts, minimal new code)

This is a *consolidation*, not an additive layer. After Phase B, total surface goes DOWN, and every
future org-scoped provider (Jira, Google Workspace) reuses the primitive instead of getting its own bespoke stack.

**Deleted (bespoke surface removed):**
- `slack_installations` table (Phase B contract drop).
- `packages/server/src/lobu/stores/slack-installation-store.ts` (bespoke store).
- Slack-specific `team_id → install` routing branch in `gateway/routes/public/slack.ts` (uses the generic lookup).
- The per-org **OAuth app-profile requirement** for app_installation connectors — the "select an app profile first" /
  "client secret not configured" path (#1418/#1427 fought this) is *gone* for GitHub once it's app_installation.

**Renamed / generalized (extend in place, no parallel copy):**
- `slack-installation-store.ts` → `app-installation-store.ts` (provider-agnostic; same call sites).
- #1418 webhook bridge (`resolveConnectorWebhookConnection` + `/api/v1/webhooks/:connectionId`) → folded into the shared
  `/app-webhooks/:provider` router. The EL landing (`insertEvent`) + `webhook:<id>` dedupe index are reused unchanged.
- Existing Slack signature verification in `slack.ts` → *moved* into the Slack provider verifier plugin (relocated, not rewritten).

**Reused as-is (zero new code):**
- `auth_profiles` credential rows (App secret/token refs) + existing CRUD/resolver.
- `connections.auth_profile_id` linkage; `connections.config` for install/scope ref.
- SecretStore (only the naming prefix is standardized).
- EL ingest landing + dedupe; the connector `sync()` path + secret-proxy placeholder swap.

**Genuinely new (kept minimal):**
- 1 table `app_installations` (+2 indexes).
- 1 interface `InstallationTokenProvider` + GitHub minting (Slack impl = resolve existing ref → ~no logic).
- GitHub webhook verifier/extractor plugin (Slack = the relocated existing code; Jira later).
- ~3 additive connector-sdk types (no runtime change to existing connectors).
- owletto "Install on GitHub" flow (UI).

Net for the *next* provider after GitHub: a token-provider impl + a verifier/extractor plugin — no new table, no new
storage, no new routing. That's the payoff.
