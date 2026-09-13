# Install-operator bootstrap

> **Status (2026-07-15):** **Shipped** — `ensureInstallOperator` (`packages/server/src/auth/install-operator.ts`) + the `principal_kind` migration are live.

## Problem

A fresh `lobu run` boots with an empty `user` table. The CLI (and the macOS
menu bar) start by calling `POST /api/local-init`, which today returns
`no_user_yet` and tells the caller to point a browser at `/sign-up`. That
works on a developer laptop with a browser; it does not work in CI, in
containers, or in a `/tmp` scaffold where no SPA is reachable. The first
non-desktop install can't authenticate, can't `lobu apply`, can't do
anything — a chicken-and-egg.

Closing #917 removed an over-engineered fix (pairing URL file, single-use
PAT column, `POST /auth/pair-token`, `/auth/enrol-credential` SPA page,
custom OTP table). The actual gap is much smaller.

## Design

At first `lobu run` boot, `start-local.ts` calls `ensureInstallOperator()`
before `httpServer.listen(...)`. The function:

1. Checks for a `user` row with `principal_kind = 'install_operator'`.
   If present → no-op (idempotent).
2. If absent, inserts:
   - One `user` row, `principal_kind = 'install_operator'`,
     `email = install@<hostname>` (deterministic, no PII collected),
     `name = "Local Install"`.
   - One `account` row with `providerId = 'credential'`,
     `password = await hashPassword(ENCRYPTION_KEY)` — re-using the
     `hashPassword` re-export from `better-auth/crypto` (the same hasher
     better-auth's email-password adapter uses for every credential).
   - A personal organization for the operator (re-use
     `ensurePersonalOrganization` from `auth/personal-org-provisioning.ts`).
     Default-agent provisioning is handled by the existing pass in
     `start-local.ts` that runs `ensureDefaultAgent` against the first
     personal org; we don't call it again from `ensureInstallOperator`.

The provisioning is convergent: every boot ensures each piece exists. If
a transient failure on first boot leaves the operator without a personal
org, the next boot patches it (the user/account fast path runs, then
`ensurePersonalOrganization` — itself idempotent — re-runs and creates
the missing org).

`ENCRYPTION_KEY` is the random secret already generated in `.env` for
at-rest encryption. Making it serve double duty as the install operator's
sign-in credential removes the need for a separate install secret and
matches what's already in operator muscle memory.

`principal_kind` is a new `text NOT NULL DEFAULT 'human'` column on
`user`. The discriminator lets surfaces that gate on "is there a real
human?" exclude the install operator with a single predicate:
`WHERE principal_kind <> 'install_operator'`.

Carve-outs land at: signup count (`databaseHooks.user.create.before`),
`getAuthConfig().hasUser`, password reset (`sendResetPassword`), magic
link (`sendMagicLink`), OAuth account-linking (`databaseHooks.account.create.before`),
and `/api/local-init`'s user-selection query. Member-list and admin
user-list filtering are explicitly **not** carved out in this PR; the
install operator does get a personal org + member row, but discovery
surfaces are scoped to that org's owner so the operator only ever shows
up to itself (single-tenant case) or alongside humans on a team install
(where the operator is intentionally still visible to the org owner).

A centralised helper `isInstallOperator(user)` keeps the carve-out
discriminator check in one place so we can extend it without grep'ing
for the predicate string.

## Client flows

| Client | Path | New code? |
| --- | --- | --- |
| CLI on install host (`lobu apply`, `lobu chat`) | Existing `POST /api/local-init` (loopback-only) — install_operator exists, route mints a session cookie + worker-scoped PAT in one round-trip. The CLI doesn't go through `/api/auth/sign-in/email` because that path mints a session but not the PAT the worker poll loop needs. | No |
| Loopback menubar / web first sign-in | Same `POST /api/local-init` — short-circuits to a session immediately | No |
| Cross-machine first sign-in (SPA via browser) | SPA login screen → operator pastes `ENCRYPTION_KEY` once into the password field at `/auth/login?intent=sign-in` → `POST /api/auth/sign-in/email` returns a session → operator enrols a passkey from the existing settings page so the next sign-in is biometric | Tiny copy hint (deferred to a follow-up owletto PR) |
| Second device | Browser-native WebAuthn cross-device verification (caBLE / hybrid) — already wired via `@better-auth/passkey` | No |
| Multi-tenant install (team org) | Standard `/sign-up` flow; install_operator coexists silently with humans | No |

## Chrome extension via Mac bridge (macOS)

The Chrome extension story on macOS is already solved by existing
infrastructure — no new auth surface needed in this PR. The Mac app
installs itself as a Chrome native-messaging host (`ai.lobu.bridge`)
at first launch into every Chromium-family browser's
`NativeMessagingHosts/` directory (see
`packages/owletto/apps/mac/Owletto/ChromeBridgeHost.swift`). The flow:

1. Extension calls `chrome.runtime.connectNative("ai.lobu.bridge")`
   with `{op: "pair", platform: "chrome-extension"}`.
2. Chrome spawns the Mac app as a short-lived stdio child, which routes
   to `NativeMessagingLoop.run()`.
3. Mac app loads its stored Keychain credentials, calls
   `POST /api/me/devices/mint-child-token` on the gateway, gets a child
   token (separate `personal_access_tokens` row, distinct `worker_id`,
   scoped to the extension).
4. Returns to extension over stdout; extension persists in
   `chrome.storage.local`.

After install-operator lands, the Mac app's stored credential is the
install_operator's PAT (minted via `/api/local-init` after a paste-once
or `.env`-read sign-in). The extension inherits a child of that PAT
through the existing bridge with zero new code.

Reference: `packages/server/src/index.ts:781` (the `mint-child-token`
route), `packages/server/src/worker-api.ts:184,2247` (implementation +
child-token semantics).

## Cross-platform extension fallback (Linux / Windows / Mac-app-not-installed)

Without the Mac bridge (Linux, Windows, or a macOS user who never
installs the menubar app), the Chrome extension's options page shows the
same paste-once UX as a fresh Mac webview install: user pastes the
install secret (`ENCRYPTION_KEY`) once, the extension signs in via
`/api/auth/sign-in/email`, receives a PAT, stores in
`chrome.storage.local`. Future: a Linux tray / Windows tray app with the
same `pair` op as `ChromeBridgeHost` would extend the inheritance flow
to those platforms.

## Out of scope

The following machinery from PR #917 is **deliberately not in this design**.
Codex review showed each is redundant with existing infrastructure:

- **Pairing URL file** — superseded by SPA login + WebAuthn cross-device.
- **`single_use = true` PAT column** — superseded by better-auth sign-in.
- **`POST /auth/pair-token`** — superseded by `POST /api/auth/sign-in/email`.
- **`/auth/enrol-credential` SPA page** — superseded by the existing
  passkey enrolment in the settings page.
- **Custom `pairing_otps` table** — never needed; the SPA paste-once flow
  uses the operator's existing `ENCRYPTION_KEY`.
- **v2 "vault-wrapping" layer** — `ENCRYPTION_KEY` already does both jobs
  (at-rest encryption *and* the install secret), so v1 ≡ v2.

## Security considerations

`ENCRYPTION_KEY` today is a server-side at-rest key — possession of `.env`
is already total compromise (read every encrypted secret in Postgres).
Making it *also* the install operator's auth credential means it may now
touch surfaces it didn't before:

- It can enter a browser address bar / DOM during the SPA paste-once flow.
- Browsers may offer `navigator.credentials.store` for it.
- It can appear in password-manager autofill, in screenshots, in shoulder
  surfing.

Trade-offs:

- Browser password-manager mitigations on the SPA login page
  (`autocomplete="off"` on the install-secret field, or an explicit
  copy hint pointing operators at a passkey enrolment as the long-term
  credential) are deferred to a follow-up owletto PR + submodule bump.
  This PR is backend-only. The risk window between this PR landing and
  the owletto follow-up is bounded: only operators who proactively use
  cross-machine sign-in (web SPA on a non-install machine) before
  enrolling a passkey are exposed, and they would have pasted the same
  secret without these mitigations anyway.
- The synthetic `email = install@<hostname>` is not a real address. No
  password reset / magic link can be sent to it, which is fine because
  the carve-outs below reject those flows anyway.

Carve-outs (one predicate, applied at each surface):

- `databaseHooks.user.create.before` — install_operator excluded from
  the "deployment already has a user" count, so the first human signup
  can still proceed in single-user mode.
- `getAuthConfig().hasUser` — same predicate, so the SPA gateway knows
  "the install has a *human*" not "the install has the operator row".
- `sendResetPassword` / `sendMagicLink` — reject when the target user has
  `principal_kind = 'install_operator'` (DB-checked at send-time, since
  better-auth's hook payload doesn't carry custom user columns).
- OAuth account-linking (`databaseHooks.account.create.before`) — reject
  any non-`credential` provider attempting to write an account row for
  the install operator. `credential` is allowed so `ensureInstallOperator`
  can write the password-hash row at boot.
- `/api/local-init` user-selection — orders the operator last, so the
  route mints credentials for a real human when one exists.

Not carved out in this PR (intentional — see "Design" section):
member listing / org member UI / admin user lists. The install operator
gets a real personal-org member row; the admin surfaces are already
scoped to the requesting user's orgs, so the operator only ever appears
in its own org's member list (which the operator itself owns).

## Migration of existing installs

On next boot, every existing install auto-provisions its install_operator.
Existing human users with normal email + password accounts keep working —
their auth is independent of the operator row. No user-visible disruption.
The `principal_kind` column defaults to `'human'` for every pre-existing
row, so the "is there a real human?" gate is the single predicate
`WHERE principal_kind <> 'install_operator'`.

## Stage 2 implementation files

- `db/migrations/<next-version>_principal_kind.sql` —
  `ALTER TABLE "user" ADD COLUMN principal_kind text NOT NULL DEFAULT 'human'` +
  `CREATE INDEX idx_user_principal_kind ON "user" (principal_kind)`.
- `packages/server/src/auth/install-operator.ts` (new) —
  `ensureInstallOperator()`, `isInstallOperator(user)`,
  `INSTALL_OPERATOR_KIND` constant.
- `packages/server/src/start-local.ts` — call `ensureInstallOperator()`
  before `httpServer.listen(...)`.
- `packages/server/src/auth/index.tsx` — magic-link / password-reset
  guard, signup-blocking hook predicate update.
- `packages/server/src/auth/config.ts` — `hasUser` predicate update.
- `packages/server/src/auth/routes.ts` — `/api/local-init` no longer
  returns `no_user_yet` for the operator-only state (defensive 500 if
  it ever does).
- `packages/owletto/src/app/auth/login.tsx` — copy hint on the login
  page pointing at `ENCRYPTION_KEY` (deferred to a follow-up owletto PR
  + submodule bump; the backend lands first).
- Tests in `packages/server/src/auth/__tests__/install-operator.test.ts`
  and `packages/server/src/__tests__/integration/auth/install-operator.test.ts`.
