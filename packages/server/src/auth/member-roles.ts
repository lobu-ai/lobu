import type { ConfigActorSource } from '../utils/apply-context';
import { ToolUserError } from '../utils/errors';
import { APIError } from 'better-auth';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { type DbClient, getDb } from '../db/client';
import { insertWorkspaceChangeEventInTransaction } from '../utils/insert-event';
import { updateMemberEntityAccess } from '../utils/member-entity';
import { withEntityWriteTransaction } from '../utils/entity-management';

import { authorizeMemberRole, lockMemberRoleChanges, parseMemberRole, type MemberRole } from './member-role-policy';

export async function changeMemberRoleInTransaction(
  sql: DbClient,
  params: { organizationId: string; actorId: string | null; memberId: string; role: MemberRole; actorSource: ConfigActorSource },
) {
  const [member] = await sql`SELECT id, "userId", "organizationId", role, "createdAt" FROM member WHERE id = ${params.memberId} AND "organizationId" = ${params.organizationId}`;
  if (!member) throw new ToolUserError('Workspace member not found', 404);
  await authorizeMemberRole(sql, params.organizationId, params.actorId, params.role, member.role as string);
  if (member.role === params.role) return member;
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

// Preserve Better Auth's existing endpoint and session checks, while routing
// the write through the same transactional operation as entity hooks. Origin /
// CSRF validation already ran: Better Auth registers `originCheckMiddleware` as
// a router middleware on `/**`, which better-call runs before the endpoint this
// hook short-circuits.
export const memberRoleAuthHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path !== '/organization/update-member-role') return;
  const session = await getSessionFromCtx(ctx);
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
      await updateMemberEntityAccess(organizationId, null, { role, status: 'active' }, sql, member.userId as string);
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
