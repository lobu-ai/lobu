# Chrome reliability

Design approved 2026-09-08. One Lobu PR with an Owletto source companion because the extension is a separate repository.

## Target model

A browser flow has one server-derived ownership identity throughout its actions. Titles are display data and never grant ownership. Keep the existing operation queue, run metadata, tab groups, leases, scheduler, and bootstrap route.

- Each bare `run_sdk` invocation gets a server-generated nonce. At the operation boundary, derive its owner from the selected organization, authenticated user, and nonce. Actions within that invocation share an owner; separate invocations do not. Existing Automation, conversation, and MCP attribution retains priority and identity.
- Persist ownership in the existing `runs.run_metadata.browser_context`. An SDK fallback is used only on fresh insertion. Keyed replay returns its original result without comparing, hydrating, or transferring the fallback owner. Attributed replay compares identity without its display title, in both TypeScript and the atomic SQL hydration guard.
- Reuse `run_sdk.title`, normalized and bounded by code points, for `Lobu · <subject> · <diagnostic suffix>`. New tabs and targeted actions update titles through the existing group mutation path. An existing-tab title update requires the owning flow and preserves group identity and handoff metadata.
- Propagate failed ownership-storage reads. A successful missing key may initialize an empty store; a rejected read must not erase leases. Delete title-based group adoption. If Chrome identity no longer resolves, do not adopt or clean up the old group.
- Seed the existing integer document epoch per document, then increment it on snapshots. This prevents an old ref becoming valid on a new page merely because both snapshots used epoch 1. Uniqueness is probabilistic within the existing safe-integer field. Keep stale-ref and protected-URL checks; never retry click/type/submit after an ambiguous outcome.
- Catch failures around the whole poll iteration and reuse its generation check and backoff. Bound polling and OAuth refresh requests, including response bodies. Record a healthy poll only after its body parses. Credential loss and explicit stop remain terminal; transient refresh failures retain credentials through the existing reconnect path.
- Give bootstrap exchange a 15-second deadline with its existing Retry controls. Cancel the previous attempt and ignore late results. Preserve token-fragment stripping, session scoping, deep links, and pairing identity.

## Scope and migration

Server: `tools/sdk_run.ts`, `tools/registry.ts`, operation execution and queue creation, browser-action context derivation, and `auth/routes.ts` bootstrap. Extension: tab groups, targeted-action dispatch, polling/refresh, accessibility epochs, and generated cleanup guidance. Add focused regressions and a disposable-browser smoke script.

Delete the rejection-to-empty-store path, title-only group recovery, duplicate startup credential precheck, rejection-leaking polling, and unbounded bootstrap waits. Scratch cleanup guidance must match the existing 5-minute idle lease; handoffs retain their separate 30-minute budget.

No new database tables/columns, migrations, public arguments, endpoints, permission grants, aliases, credential paths, or server coordination service. New runs use existing metadata; old runs retain their ownership. User-owned and released tabs stay protected. Interactive drafts remain page-activated and never auto-submit.

Slack/provider routing, the organization-wide Automation audit, a public resumable handle across bare CLI requests, and seamless full-browser restoration are out of scope. This is generic platform work, with no tenant, connector-slug, or entity-key special cases.

The approved estimate was net-positive shipping code (+135 to +320 lines across repositories), with most growth expected in tests. Report actual shipping/test/document line counts at the PR checkpoint.

## Acceptance and evidence

- Shared SDK ownership is exercised through the actual sandbox and persisted PostgreSQL runs. Separate invocations, users and selected organizations derive distinct owners; forged ownership inputs remain stripped.
- Keyed replay covers legacy absent metadata, existing owners, changed input/principal rejection, concurrent inserts, and title-only versus conflicting-identity hydration races. Existing parent connector-run attribution and token exchange remain covered.
- Storage failures preserve leases; title writes report failures and reconcile on the next successful attempt. Same-title user groups are never adopted or disposed after stored identity disappears.
- The installed-extension smoke asserts exact click counts and typed values, stale refs after navigation, same-title flow isolation, existing-tab title updates, closed/released/user-tab guards, and subsequent independent success.
- Actual background dispatch is exercised against a synthetic local gateway: action failure, gateway 503, worker eviction, recovery, completion, and cleanup without duplicate completion. Missing-tab cleanup still reaches the tools' persisted-ownership checks.
- Full Chromium process restart changed all synthetic tab/group/window IDs. The old flow could close neither restored scratch nor same-title user tab; fresh work created a new group and left the user tab untouched. Unverifiable restored scratch tabs remain for manual cleanup.
- Actual bootstrap HTML in Chromium passed success, rejected-token/Retry, and stalled-request/Retry with fragment stripping and device deep links preserved. Unit tests cover obsolete late success and double retry.

Reproduced failures and their red/green outputs, exact commands, final counts, and review verdicts belong in the PRs. Fable reviewed the design and the settled pre-commit change. A review verdict alone does not establish E2E health.

## PR checkpoint and live checks

Run focused regressions, the installed-extension smoke, `make pre-pr`, canonical GitHub CI, `make review`, and `make ui-review`. Open the paired PRs as one delivery, report their diffstats and unmet gates, then stop at the PR checkpoint. Release requires merging Owletto first and updating the parent to its squash commit before landing Lobu.

After rollout, verify deployed squash ancestry and the installed extension build separately. Live checks still owed: the exact SDK-to-production-extension journey after reload, the paired sidebar's sync-status deep link, and recovery over a real idle/sleep interval. The original hidden-window first-click no-op remains unproven; no forced-focus or click-retry patch was added. Coincidental reuse of old numeric Chrome IDs is untested. Do not claim every extension path, connector, or Automation is healthy from these isolated checks.
