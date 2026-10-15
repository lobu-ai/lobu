# Workspace deletion as a background purge

Status: implemented (`auth/organization-delete.ts`, `workspace/deletion.ts`,
`workspace/purge.ts`). No new table and no new public route. The existing
delete endpoint changes from synchronous to "deleting". See "Implementation
notes" at the end for where the build differs from the plan below.

Evidence checked on 2026-10-15 against `origin/main` at
[`9ac7d26500227d09ec0c52fa5468ba7e2ca78472`](https://github.com/lobu-ai/lobu/tree/9ac7d26500227d09ec0c52fa5468ba7e2ca78472).
Revalidate this baseline before implementation.

## Problem

Deleting a large workspace from Settings fails.

On 2026-10-15, deleting a workspace with about 896k events and 199k event
embeddings returned a bare HTTP 500 from `POST /api/auth/organization/delete`.
The cause:

- The whole foreign-key cascade runs inside one better-auth transaction (`auth/index.tsx`, `database.transaction: true`).
- That transaction hits prod's 60-second `statement_timeout` while cascading `events` → `event_embeddings`.
- Even a successful cascade leaves orphaned rows. These org-scoped tables have no foreign key to `organization`:
  - `agent_secrets`
  - `authz_source_acl_state`
  - `channel_messages`
  - `connect_tokens`
  - `connector_versions`
  - `inference_providers`
  - `user_auth_profiles`
  - `views`
  - `device_workers`
  - `classify_facet`
  - `deployment_pause`

That workspace was removed by hand instead. The steps were:

1. Delete events in 2,000-row batches. Each batch ran in its own transaction with `SET LOCAL lobu.allow_event_delete = 'on'`, the sanctioned path of `events_block_direct_delete`. It took about 30 minutes, with no long locks.
2. Delete the rows in the tables listed above.
3. Delete the `organization` row.

This design turns those steps into the product's delete.

## Decision

**Who starts a delete, and where it runs, are separate.**

- **Who starts it:**
  - The workspace owner, from Settings → Delete.
  - A platform admin, through an admin command, for abandoned or abusive workspaces.

  Both create the same deletion request.
- **Where it runs:** always on the server, as one background task. No local
  script carries delete logic. An operator entry point only enqueues the same
  task, so there is exactly one implementation.

### Flow

1. **Request.**
   - The delete endpoint, still owner-only and still refusing personal workspaces (`isPersonalOrgDeletionBlocked`), records the request on `organization.metadata` (`deletion_requested_at`, `deletion_requested_by`). That is an existing text column storing JSON, so there is no schema change.
   - It writes the audit row and enqueues one `workspace-purge` task on the existing runs queue.
   - It returns at once. The UI shows the workspace as deleting.
2. **Hidden immediately.** A workspace with `deletion_requested_at` set is excluded from:
   - workspace listings;
   - membership and access checks;
   - scheduled Automations and feed syncs;
   - chat routing.

   From the user's point of view it is gone. The purge only reclaims storage.
3. **`workspace-purge` task.** It is resumable and lease-fenced with a heartbeat, like other queue tasks. Every step is idempotent, so a lost lease just resumes.
   1. Delete `events` in batches. Each batch is its own transaction with `SET LOCAL lobu.allow_event_delete = 'on'`; embeddings, classifications and other event children cascade per batch.
   2. Delete the workspace's rows in every org-scoped table without a cascading foreign key (the list above).
   3. `DELETE FROM organization`. The remaining cascade is small by now and fits easily inside the statement timeout.
4. **Completion.** The audit trail records start, progress (rows removed) and finish.

### Guard against future orphans

A test enumerates every table with an `organization_id` or `organizationId`
column, from the live schema, not a hand-written list. It asserts that each
table either cascades from `organization` or is in the purge task's explicit
list. A new org-scoped table without either fails CI instead of leaking rows
after a delete.

## What does not change

- Who may delete a workspace (owner; personal workspaces still refused).
- `events` stays append-only for every other path. The purge uses the guard's
  existing transaction-scoped maintenance switch, never a global bypass.
- No new table, column or public API.

## Related, shipped separately

Auth endpoint errors are now logged with their database error code, so a
failure like the 2026-10-15 500 is no longer silent.

## Verification plan

- **Integration test.** Seed a workspace with events, embeddings and a row in every no-FK table. Request the delete, run the task, and assert zero rows remain in every org-scoped table and no other workspace's rows are touched.
- **Resume test.** Kill the task mid-batch, re-run it, and assert it completes.
- **Visibility test.** After the request and before the purge finishes, the workspace is absent from listings, refuses access, and runs no schedules.

## Implementation notes

- **Interception.** A Better Auth plugin before hook owns `POST
  /organization/delete` (the `memberRoleAuthHook` mechanism) and the
  organization plugin sets `disableOrganizationDeletion`, so the synchronous
  cascade cannot run. The hook resolves the session through the auth API,
  because sibling before hooks never see the bearer plugin's header rewrite.
- **Hidden.** `workspace/deletion-state.ts` is the one predicate. It filters the
  slug lookup and `getMembershipRole` in `workspace/multi-tenant.ts`, the PAT
  and MCP membership checks, the
  workspace listings (`listOrganizations`, OAuth grants, userinfo, consent,
  chat-claim pickers), the due-Automation, due-feed and `scheduled_jobs`
  materializers, and the chat connection store. The request also cancels the
  workspace's pending runs.
- **Better Auth endpoints.** Its organization endpoints read through its own
  adapter, so the same plugin refuses them in a before hook, before they run,
  when the request targets a deleting workspace: by organization id or slug,
  by invitation or member id, or through the session's active organization,
  which is always checked because an endpoint may ignore the selector it was
  sent. The request also clears every session's active organization that
  points at the workspace, so only a session that raced the request can still
  hold it, and that session can only list, switch away or clear, and handle
  invitations; `/organization/list` is filtered in an after hook. The
  member-role endpoint is a user hook that runs before any plugin hook, so
  `lockMemberRoleChanges` refuses a deleting workspace for every membership
  role write. Create and update reject client metadata carrying either
  deletion key, leaving `requestWorkspaceDeletion` its only writer. Residual:
  a request that passed the check just before the deletion committed can
  still land after it.
- **Purge order.** Events, then runs (both unbounded per workspace), then
  identity associations are retired through the governed unlink path (a live
  one blocks both entity and organization deletes), then entities leaf-first
  (`parent_id` is `ON DELETE RESTRICT`; authorization edges need the ACL
  switch), then `organization`, then the explicit no-FK tables.
  `device_workers` must follow the organization delete because
  `automations.device_worker_id` references it.
- **Explicit list.** Re-derived from the schema: the list above plus
  `agent_users`, `grants`, `automation_reactions` and `sandboxes`.
- **Durable record.** The task's `runs` row carries no `organization_id`
  (`runs` cascades from `organization`), so it survives the purge and holds
  cumulative removed-row counts across retries in `action_output`.
- **`scheduled_jobs.source_event_id` has no index.** Each deleted event's
  `ON DELETE SET NULL` check scans `scheduled_jobs`: a 2,000-event batch took
  26 ms with an empty table, 1.4 s with 20k rows and 6.9 s with 100k rows
  (local, embedded Postgres). An index is a proposed follow-up migration.
- **Platform-admin entry point.** Not built: there is no existing platform
  admin command or route to attach it to (`PLATFORM_ADMIN_USER_IDS` only
  switches the provider-settings view). `requestWorkspaceDeletion` is the
  function such an entry point would call.
