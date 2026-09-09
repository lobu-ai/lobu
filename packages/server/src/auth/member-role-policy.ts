import { ToolUserError } from '../utils/errors';
import type { DbClient } from '../db/client';

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = typeof MEMBER_ROLES[number];

export function parseMemberRole(value: unknown): MemberRole {
  if (typeof value !== 'string' || !MEMBER_ROLES.includes(value as MemberRole)) {
    throw new ToolUserError(`Role must be one of: ${MEMBER_ROLES.join(', ')}`, 400);
  }
  return value as MemberRole;
}

// Every semantic membership-role write takes this lock BEFORE entity/member
// rows. Serialize owner-count checks across replicas, including the auth API.
export async function lockMemberRoleChanges(sql: DbClient, organizationId: string): Promise<void> {
  const rows = await sql`SELECT id FROM organization WHERE id = ${organizationId} FOR UPDATE`;
  if (!rows.length) throw new ToolUserError('Workspace not found', 404);
}

export async function authorizeMemberRole(
  sql: DbClient,
  organizationId: string,
  actorId: string | null,
  role: MemberRole,
  previousRole?: string,
  checkLastOwner = true,
): Promise<void> {
  const [actor] = await sql`SELECT role FROM member WHERE "organizationId" = ${organizationId} AND "userId" = ${actorId}`;
  if (!actor || (actor.role !== 'owner' && actor.role !== 'admin')) {
    throw new ToolUserError('Only workspace owners and admins can change member roles', 403);
  }
  if ((role === 'owner' || previousRole === 'owner') && actor.role !== 'owner') {
    throw new ToolUserError('Only owners can grant or change ownership', 403);
  }
  if (checkLastOwner && previousRole === 'owner' && role !== 'owner') {
    const owners = await sql`SELECT id FROM member WHERE "organizationId" = ${organizationId} AND role = 'owner'`;
    if (owners.length <= 1) throw new ToolUserError('The workspace must retain at least one owner', 400);
  }
}

