/**
 * Generic entity lifecycle hook registry.
 *
 * Entity types can register hooks that fire during semantic create/update/delete operations.
 * Hooks are skipped when `skipHooks: true` is passed (used by auth callbacks
 * to prevent circular calls).
 */

import type { ConfigActorSource } from './apply-context';
import { ToolUserError } from './errors';
import { hasRequiredMcpScope } from '../auth/tool-access';
import { authorizeMemberRole, lockMemberRoleChanges, parseMemberRole } from '../auth/member-role-policy';
import { changeMemberRoleInTransaction } from '../auth/member-roles';
import { createElement } from 'react';
import { sendTransactionalEmail } from '../email/send';
import { InvitationEmail, invitationSubject } from '../email/templates/invitation';
import type { Env } from '../index';
import { type DbClient, getDb } from '../db/client';
import { resolveMemberSchemaFields } from './member-entity';
import { getConfiguredPublicOrigin } from './public-origin';
import {
  insertWorkspaceChangeEventInTransaction,
  recordWorkspaceChangeEvent,
  type WorkspaceChangeEventParams,
} from './insert-event';
import type { CreatedEntity, EntityData } from './entity-management';
import logger from './logger';

export interface EntityHookContext {
  organizationId: string;
  userId: string | null;
  env?: Env;
  scopes?: readonly string[] | null;
  actorSource?: ConfigActorSource;
  /** Caller-owned transaction for hook database work. */
  sql?: DbClient;
  /** Register network side effects that may run only after the caller commits. */
  deferAfterCommit?: (effect: () => Promise<void>) => void;
}

/**
 * Context for hooks that must run inside the caller's write transaction: their
 * locks and writes are only meaningful on that connection, so `sql` is required
 * rather than falling back to a fresh pool client.
 */
export type EntityTransactionHookContext = EntityHookContext & { sql: DbClient };

interface EntityLifecycleHooks {
  /** Runs before INSERT. Can mutate data (e.g. set status). Throw to abort. */
  beforeCreate?: (data: EntityData, ctx: EntityHookContext) => Promise<EntityData>;
  /** Runs after INSERT. For side-effects (e.g. sending notifications). */
  afterCreate?: (entity: CreatedEntity, ctx: EntityHookContext) => Promise<void>;
  /**
   * Runs in the write transaction before any row lock, so a hook can claim a
   * coarser lock first. `fields` is the proposed metadata patch, letting a hook
   * skip work when the write cannot touch what it guards.
   */
  beforeUpdate?: (
    fields: Record<string, unknown>,
    ctx: EntityTransactionHookContext
  ) => Promise<void>;
  /** Runs after an applied update, in the same transaction. Throw to roll back. */
  afterUpdate?: (
    before: { id: number; metadata: Record<string, unknown> | null },
    after: { id: number; metadata?: Record<string, unknown> | null },
    ctx: EntityTransactionHookContext
  ) => Promise<void>;
  /** Runs before soft/hard delete. For cleanup (e.g. cancelling invitations). */
  beforeDelete?: (
    entity: { id: number; entity_type: string; metadata: Record<string, unknown> | null },
    ctx: EntityHookContext
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry: Record<string, EntityLifecycleHooks> = {};

function registerEntityHooks(entityType: string, hooks: EntityLifecycleHooks): void {
  registry[entityType] = hooks;
}

export function getEntityHooks(entityType: string): EntityLifecycleHooks | undefined {
  return registry[entityType];
}

// ---------------------------------------------------------------------------
// $member hooks
// ---------------------------------------------------------------------------

async function sendMemberInvitationEmail(
  entity: CreatedEntity,
  ctx: EntityHookContext
): Promise<void> {
  const { emailField } = await resolveMemberSchemaFields(ctx.organizationId);
  const meta = entity.metadata as Record<string, unknown> | null;
  const email = meta?.[emailField] as string | undefined;
  if (!email || !ctx.env?.RESEND_API_KEY) return;

  try {
    const sql = getDb();
    const orgRows =
      await sql`SELECT name FROM organization WHERE id = ${ctx.organizationId} LIMIT 1`;
    const orgName = (orgRows[0]?.name as string) || 'your organization';

    let inviterName: string | undefined;
    if (ctx.userId) {
      const userRows = await sql`SELECT name FROM "user" WHERE id = ${ctx.userId} LIMIT 1`;
      if (userRows[0]?.name) inviterName = userRows[0].name as string;
    }

    const invRows = await sql`
      SELECT id FROM invitation
      WHERE "organizationId" = ${ctx.organizationId} AND email = ${email} AND status = 'pending'
      ORDER BY "createdAt" DESC LIMIT 1
    `;
    if (invRows.length === 0) return;

    const baseUrl = getConfiguredPublicOrigin() || 'http://localhost:8787';
    const acceptUrl = `${baseUrl}/auth/accept-invitation?invitationId=${invRows[0].id}`;

    await sendTransactionalEmail({
      env: ctx.env,
      to: email,
      category: 'invite',
      subject: invitationSubject({ inviterName, orgName }),
      react: createElement(InvitationEmail, { inviterName, orgName, acceptUrl }),
    });
  } catch (err) {
    logger.error({ err }, '[Entity Hook] Failed to send invitation email');
  }
}

registerEntityHooks('$member', {
  async beforeCreate(data, ctx) {
    if (!hasRequiredMcpScope('admin', ctx.scopes)) throw new ToolUserError('Changing membership requires mcp:admin scope', 403);
    const sql = ctx.sql ?? getDb();
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, sql);
    const meta = { ...(data.metadata ?? {}) };
    const role = parseMemberRole(meta.role ?? 'member');
    await lockMemberRoleChanges(sql, ctx.organizationId);
    await authorizeMemberRole(sql, ctx.organizationId, ctx.userId, role);
    meta.role = role;
    const email = meta[emailField] as string | undefined;

    if (email) {
      // Insert a Better Auth invitation (skip if one already pending)
      const inserted = (await sql`
        INSERT INTO invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId", "createdAt")
        SELECT
          gen_random_uuid()::text,
          ${ctx.organizationId},
          ${email},
          ${role},
          'pending',
          ${new Date(Date.now() + 48 * 60 * 60 * 1000)},
          ${ctx.userId},
          current_timestamp
        WHERE NOT EXISTS (
          SELECT 1 FROM invitation
          WHERE "organizationId" = ${ctx.organizationId}
            AND email = ${email}
            AND status = 'pending'
        )
        RETURNING id
      `) as unknown as Array<{ id: string }>;
      if (inserted.length === 0) {
        const [pending] = await sql`SELECT role FROM invitation
          WHERE "organizationId" = ${ctx.organizationId} AND email = ${email} AND status = 'pending'`;
        if (!pending || pending.role !== role) {
          throw new ToolUserError('A pending invitation already exists; edit its member record to change the role', 400);
        }
      }
      if (inserted.length > 0) {
        const event: WorkspaceChangeEventParams = {
          organizationId: ctx.organizationId,
          resourceKind: 'invitation',
          resourceId: inserted[0].id,
          op: 'created',
          summary: 'Invitation sent',
          state: {
            id: inserted[0].id,
            role,
            status: 'pending',
          },
          changedFields: ['role', 'status'],
          actorSource: ctx.actorSource,
          createdBy: ctx.userId ?? null,
        };
        if (ctx.sql) {
          await insertWorkspaceChangeEventInTransaction(event, sql);
        } else {
          recordWorkspaceChangeEvent(event);
        }
      }
      meta.status = 'invited';
    } else {
      meta.status = meta.status ?? 'active';
    }

    return { ...data, metadata: meta };
  },

  async afterCreate(entity, ctx) {
    if (ctx.deferAfterCommit) {
      ctx.deferAfterCommit(() => sendMemberInvitationEmail(entity, ctx));
      return;
    }
    await sendMemberInvitationEmail(entity, ctx);
  },

  async beforeUpdate(fields, ctx) {
    // Only a role write needs the org-wide serialization; taking it for every
    // profile edit would block unrelated entity writes in the workspace.
    if (!Object.hasOwn(fields, 'role')) return;
    await lockMemberRoleChanges(ctx.sql, ctx.organizationId);
  },

  async afterUpdate(before, after, ctx) {
    if (before.metadata?.role === after.metadata?.role) return;
    if (!hasRequiredMcpScope('admin', ctx.scopes)) throw new ToolUserError('Changing membership requires mcp:admin scope', 403);
    const sql = ctx.sql;
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, sql);
    const oldEmail = before.metadata?.[emailField];
    const newEmail = after.metadata?.[emailField];
    // An editable profile field must never retarget a permission mutation.
    if (oldEmail !== newEmail) {
      throw new ToolUserError('Change member email separately from its permission role', 400);
    }
    const role = parseMemberRole(after.metadata?.role);
    const members = await sql`
      SELECT m.id FROM entity_identities ei JOIN member m
        ON m."userId" = ei.identifier AND m."organizationId" = ei.organization_id
      WHERE ei.organization_id = ${ctx.organizationId} AND ei.entity_id = ${before.id}
        AND ei.namespace = 'auth_user_id' AND ei.source_connector = 'auth:signup'
        AND ei.deleted_at IS NULL
    `;
    if (members.length === 1) {
      await changeMemberRoleInTransaction(sql, {
        organizationId: ctx.organizationId, actorId: ctx.userId,
        memberId: members[0].id as string, role, actorSource: ctx.actorSource ?? 'api',
      });
      return;
    }
    if (members.length > 1) {
      throw new ToolUserError('Member has more than one authentication identity', 400);
    }
    if (typeof oldEmail !== 'string') {
      throw new ToolUserError('Member has no active membership or pending invitation', 400);
    }
    const invitations = await sql`
      SELECT id, role FROM invitation WHERE "organizationId" = ${ctx.organizationId}
        AND email = ${oldEmail} AND status = 'pending'
      FOR UPDATE
    `;
    if (invitations.length !== 1) {
      throw new ToolUserError('Member has no active membership or pending invitation', 400);
    }
    const invitation = invitations[0];
    await authorizeMemberRole(sql, ctx.organizationId, ctx.userId, role,
      invitation.role as string);
    await sql`UPDATE invitation SET role = ${role} WHERE id = ${invitation.id}`;
    await insertWorkspaceChangeEventInTransaction({
      organizationId: ctx.organizationId, resourceKind: 'invitation',
      resourceId: invitation.id as string, op: 'updated', summary: `Invitation role set to ${role}`,
      state: { id: invitation.id, role, status: 'pending' }, changedFields: ['role'],
      actorSource: ctx.actorSource, createdBy: ctx.userId,
    }, sql);
  },

  async beforeDelete(entity, ctx) {
    const sql = ctx.sql ?? getDb();
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, sql);
    const email = entity.metadata?.[emailField] as string | undefined;
    if (!email) return;

    // Cancel any pending invitation for this email
    const cancelled = (await sql`
      UPDATE invitation
      SET status = 'canceled'
      WHERE "organizationId" = ${ctx.organizationId}
        AND email = ${email}
        AND status = 'pending'
      RETURNING id, role, status
    `) as unknown as Array<{
      id: string;
      role: string | null;
      status: string | null;
    }>;
    // The $member delete cancels every pending invite; record each
    // cancellation so the invitation lifecycle audit (send → canceled) stays
    // complete.
    for (const inv of cancelled) {
      const event: WorkspaceChangeEventParams = {
        organizationId: ctx.organizationId,
        resourceKind: 'invitation',
        resourceId: inv.id,
        op: 'updated',
        summary: 'Invitation cancelled',
        state: {
          id: inv.id,
          role: inv.role ?? 'member',
          status: inv.status ?? 'canceled',
        },
        changedFields: ['status'],
        actorSource: ctx.actorSource,
        createdBy: ctx.userId ?? null,
      };
      if (ctx.sql) {
        await insertWorkspaceChangeEventInTransaction(event, sql);
      } else {
        recordWorkspaceChangeEvent(event);
      }
    }
  },
});
