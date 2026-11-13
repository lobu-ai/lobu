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

- **Who starts it:** the workspace owner, from Settings → Delete. There is no
  platform-admin command (decided 2026-10-15): an abandoned or abusive
  workspace is removed by an operator directly in the production database.
- **Where it runs:** on the server, as one background task.

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
   3. Settle the OAuth registrations homed in the workspace, so the organization delete cannot cascade into other workspaces. See "OAuth registrations" under "Implementation notes".
   4. `DELETE FROM organization`. Only the workspace's own remaining rows cascade, which is small by now and fits easily inside the statement timeout.
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
  /organization/delete` (the `memberRolePlugin` mechanism) and the
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
  adapter, so one plugin before hook guards every `/organization/*` endpoint
  (delete checks its own target), before it runs. The target is every
  organization the request could resolve to: each organization id or slug,
  invitation and member it names, plus the session's active organization that
  Better Auth falls back to. The only place the fallback does not apply is
  Better Auth's own: set-active given an explicit target or
  `organizationId: null`. The request also clears every session's active
  organization that points at the workspace, in the same transaction, so only
  a session that raced it still holds one and must switch away first.
  The two endpoints that list rows across workspaces, `/organization/list`
  and `/organization/list-user-invitations`, are filtered in an after hook,
  and the public invitation preview no longer resolves a deleting workspace.
  The request also sets `visibility = 'private'`: every anonymous read (public
  REST, public pages, sitemap, cross-workspace schema and search reads)
  filters on `visibility = 'public'`, so that one write hides the workspace
  from all of them. Deletion is terminal, so nothing restores it.
  The embedded gateway's default-workspace lookup lost its per-replica cache,
  so the next request after the deletion (or after a member is removed)
  already resolves elsewhere on every replica. The member-role
  endpoint is a user hook that runs before any plugin hook, so
  `lockMemberRoleChanges` refuses a deleting workspace for every membership
  role write. Create and update reject client metadata carrying either
  deletion key, leaving `requestWorkspaceDeletion` its only writer. A test
  enumerates every registered organization endpoint off the live auth
  instance. Residual: a request that passed the check just before the
  deletion committed can still land after it.
- **Purge order.** Events, then runs (both unbounded per workspace), then
  identity associations are retired through the governed unlink path (a live
  one blocks both entity and organization deletes), then entities leaf-first
  (`parent_id` is `ON DELETE RESTRICT`; authorization edges need the ACL
  switch), then the OAuth registrations homed in the workspace, then
  `organization`, then the explicit no-FK tables.
  `device_workers` must follow the organization delete because
  `automations.device_worker_id` references it.
- **OAuth registrations.** `oauth_clients.organization_id` is only the first
  workspace that authorized a registration (`touchClientActivity` sets it
  once). One registration, such as a CLI login, then holds grants for many
  workspaces through `granted_organization_ids`. Its foreign key to
  `organization` cascades, `oauth_tokens`, both code tables and `mcp_sessions`
  cascade from the registration, and `events.client_id` is set to NULL. So
  "the remaining cascade is small" was false. On 2026-11-13 a purge failed all
  20 attempts: the workspace was the home of two registrations that other
  workspaces used. Each attempt spent its 60 seconds on the organization
  delete, rewriting about 760,000 of those workspaces' events in one
  statement, and was cancelled. Had it finished, it would also have deleted
  both registrations and every token issued through them.

  The purge now settles each registration homed in the workspace before the
  organization row, one per lease-fenced transaction
  (`releaseClientHomedInOrganization` in `auth/oauth/clients.ts`):
  1. It revokes the workspace's own grants with the connected-app revoke
     (`revokeClientForOrganization`). Tokens bound to the workspace are
     revoked. Its entry is removed from multi-workspace tokens and codes, and
     one left with no workspace is revoked or deleted. Its codes and MCP
     sessions are deleted.
  2. If a live token, an unexpired code, a live MCP session or any event still
     names the registration, it clears `organization_id`. Other workspaces'
     tokens keep working, their events keep `client_id`, and the next workspace
     to use the registration adopts it.
  3. Otherwise it deletes the registration. No event names it, so the
     `events.client_id` action has nothing to rewrite.

  No statement scales with a registration's event history. The event check is
  a first-row probe of `idx_events_client_id`, run with sequential scans
  disabled so its cost does not depend on planner statistics. The transaction
  holds the registration's row lock, which token issuance and event writes for
  that registration wait on, so it has to stay this short.

  A detached registration keeps its tokens, codes and sessions for other
  workspaces. It also keeps the revoked token rows that were bound to the
  deleted workspace: the organization delete sets their `organization_id` to
  NULL, and every read that honours a token requires `revoked_at IS NULL`.
  Nothing live names the deleted workspace.

  Registrations homed elsewhere are not visited. Their rows for the deleted
  workspace follow the existing foreign keys: `organization_id` is set to NULL
  on tokens and codes, and sessions cascade. An entry left in
  `granted_organization_ids` names an organization id that no longer exists,
  and workspace access is resolved by joining `organization` and `member`, so
  it grants nothing.
- **Explicit list.** Re-derived from the schema: the list above plus
  `agent_users`, `grants`, `automation_reactions` and `sandboxes`.
- **Durable record.** The task's `runs` row carries no `organization_id`
  (`runs` cascades from `organization`), so it survives the purge and holds
  cumulative removed-row counts across retries in `action_output`.
- **`scheduled_jobs.source_event_id` has no index.** Each deleted event's
  `ON DELETE SET NULL` check scans `scheduled_jobs`: a 2,000-event batch took
  26 ms with an empty table, 1.4 s with 20k rows and 6.9 s with 100k rows
  (local, embedded Postgres). Production had 9 scheduled jobs on 2026-10-15,
  none with a source event, so no index is added. Revisit if the table grows.
