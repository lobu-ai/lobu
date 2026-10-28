import type { ConfigActorSource } from '../utils/apply-context';
import { ToolUserError } from '../utils/errors';
import { APIError, type BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { type DbClient, getDb } from '../db/client';
import { insertWorkspaceChangeEventInTransaction, recordLifecycleEvent } from '../utils/insert-event';
import { updateMemberEntityAccess } from '../utils/member-entity';
import { withEntityWriteTransaction } from '../utils/entity-management';

import type { RequestSession } from './organization-delete';
import { assertWorkspaceRetainsOwner, authorizeMemberRemoval, authorizeMemberRole, lockMemberRoleChanges, parseMemberRole, type MemberRole } from './member-role-policy';

export async function changeMemberRoleInTransaction(
  sql: DbClient,
  params: { organizationId: string; actorId: string | null; memberId: string; role: MemberRole; actorSource: ConfigActorSource },
) {
  const [member] = await sql`SELECT id, "userId", "organizationId", role, "createdAt" FROM member WHERE id = ${params.memberId} AND "organizationId" = ${params.organizationId}`;
  if (!member) throw new ToolUserError('Workspace member not found', 404);
  await authorizeMemberRole(sql, params.organizationId, params.actorId, params.role, member.role as string);
  if (member.role === params.role) return member;
  if (member.role === 'owner') await assertWorkspaceRetainsOwner(sql, params.organizationId);
  await sql`UPDATE member SET role = ${params.role} WHERE id = ${member.id} AND "organizationId" = ${params.organizationId}`;
  await insertWorkspaceChangeEventInTransaction({
    organizationId: params.organizationId,
    resourceKind: 'member', resourceId: member.id as string, op: 'updated',
    summary: `Member role set to ${params.role}`,
    state: { id: member.id, user_id: member.userId, role: params.role },
    changedFields: ['role'], actorSource: params.actorSource, createdBy: params.actorId,
  }, sql);
  return { ...member, role: params.role };
}

/**
 * Delete the Better Auth membership in the caller's transaction, so the
 * `$member` record and the access it represents go away together. Every
 * request resolves its role from the `member` table (`getMembershipRole`), so
 * the removed user loses access on their next request, on every replica.
 */
export async function removeMemberInTransaction(
  sql: DbClient,
  params: { organizationId: string; actorId: string | null; memberId: string; actorSource: ConfigActorSource },
) {
  const [member] = await sql`
    SELECT m.id, m."userId", m.role, u.name FROM member m JOIN "user" u ON u.id = m."userId"
    WHERE m.id = ${params.memberId} AND m."organizationId" = ${params.organizationId}
    FOR UPDATE OF m
  `;
  if (!member) throw new ToolUserError('Workspace member not found', 404);
  await authorizeMemberRemoval(sql, params.organizationId, params.actorId, member.role as string);
  await sql`DELETE FROM member WHERE id = ${member.id} AND "organizationId" = ${params.organizationId}`;
  const summary = `Member "${(member.name as string | null) || 'a member'}" removed`;
  await insertWorkspaceChangeEventInTransaction({
    organizationId: params.organizationId,
    resourceKind: 'member', resourceId: member.id as string, op: 'deleted',
    summary, state: null, actorSource: params.actorSource, createdBy: params.actorId,
  }, sql);
  await recordLifecycleEvent({
    organizationId: params.organizationId, entityType: 'member', op: 'deleted',
    entityId: member.userId as string, summary, createdBy: params.actorId,
  }, sql);
}

const UPDATE_MEMBER_ROLE_PATH = '/organization/update-member-role';

// Preserve Better Auth's existing endpoint and session checks, while routing
// the write through the same transactional operation as entity hooks. Origin /
// CSRF validation already ran: Better Auth registers `originCheckMiddleware` as
// a router middleware on `/**`, which better-call runs before the endpoint this
// hook short-circuits.
const memberRoleHook = (resolveRequestSession: (headers: Headers) => Promise<RequestSession | null>) => createAuthMiddleware(async (ctx) => {
  const session = ctx.headers ? await resolveRequestSession(ctx.headers) : null;
  if (!session) throw new APIError('UNAUTHORIZED', { message: 'Sign in to change member roles' });
  const body = ctx.body;
  const organizationId = body?.organizationId ?? session.session.activeOrganizationId;
  if (typeof organizationId !== 'string' || typeof body?.memberId !== 'string') {
    throw new APIError('BAD_REQUEST', { message: 'organizationId and memberId are required' });
  }
  try {
    const role = parseMemberRole(body.role);
    const result = await withEntityWriteTransaction(getDb(), async (sql) => {
      await lockMemberRoleChanges(sql, organizationId);
      const member = await changeMemberRoleInTransaction(sql, { organizationId, actorId: session.user.id, memberId: body.memberId, role, actorSource: 'ui' });
      // Target by the authentication claim, never by email: the displayed role
      // must follow the identity whose permission actually changed.
      await updateMemberEntityAccess(organizationId, member.userId as string, { role, status: 'active' }, sql);
      return member;
    });
    return ctx.json(result);
  } catch (error) {
    if (error instanceof ToolUserError) {
      const status = error.httpStatus === 403 ? 'FORBIDDEN' : error.httpStatus === 404 ? 'NOT_FOUND' : 'BAD_REQUEST';
      throw new APIError(status, { message: error.message });
    }
    throw error;
  }
});

// Sibling before hooks cannot see the bearer plugin's header rewrite, so
// resolve through the full getSession API even though bearer() runs first.
// A plugin rather than a top-level hook lets the deletion guard run first.
export function memberRolePlugin(resolveRequestSession: (headers: Headers) => Promise<RequestSession | null>) {
  return {
    id: 'member-roles',
    hooks: {
      before: [{ matcher: (ctx) => ctx.path === UPDATE_MEMBER_ROLE_PATH, handler: memberRoleHook(resolveRequestSession) }],
    },
  } satisfies BetterAuthPlugin;
}
