/**
 * Generic entity lifecycle hook registry.
 *
 * Entity types can register hooks that fire during semantic create/update/delete operations.
 * Hooks are skipped when `skipHooks: true` is passed (used by auth callbacks
 * to prevent circular calls).
 */

import type { ConfigActorSource } from './apply-context';
import { ToolUserError } from './errors';
import type { IdentityContext } from '../auth/direct-user-context';
import {
  assertHumanMemberChange,
  authorizeMemberRole,
  lockMemberRoleChanges,
  parseMemberRole,
} from '../auth/member-role-policy';
import { changeMemberRoleInTransaction, removeMemberInTransaction } from '../auth/member-roles';
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
import { patchEntityRows } from './entity-management';
import { validateEntityRowPatch } from '../authz/entity-row-validation';
import logger from './logger';

export interface EntityHookContext {
  organizationId: string;
  userId: string | null;
  env?: Env;
  /**
   * Who is acting and through what credential. Membership hooks require a
   * human decision, the run-approval rule (`assertHumanMemberChange`); absent
   * means not a person.
   */
  principal?: IdentityContext;
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
  /**
   * Runs in the delete transaction before any entity row lock, so a hook can
   * claim a coarser lock first (the `beforeUpdate` rule, for deletes).
   */
  lockBeforeDelete?: (ctx: EntityTransactionHookContext) => Promise<void>;
  /**
   * Runs in the delete transaction after the row rule accepted the delete, for
   * every live entity of the type a soft or tree delete removes. Throw to roll
   * the delete back.
   */
  beforeDelete?: (
    entity: { id: number; entity_type: string; metadata: Record<string, unknown> | null },
    ctx: EntityTransactionHookContext
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
  entity: { metadata?: Record<string, unknown> | null },
  ctx: EntityHookContext
): Promise<void> {
  const { emailField } = await resolveMemberSchemaFields(ctx.organizationId);
  const meta = entity.metadata as Record<string, unknown> | null;
  const email = meta?.[emailField] as string | undefined;
  if (!email || !ctx.env?.CLOUDFLARE_EMAIL_API_TOKEN || !ctx.env?.CLOUDFLARE_EMAIL_ACCOUNT_ID) return;

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

/**
 * The membership a $member record stands for, found by its authentication
 * claim, never by the editable email. Null when the record has no membership
 * (a placeholder or an invitee).
 */
async function linkedMemberId(
  sql: DbClient,
  organizationId: string,
  entityId: number
): Promise<string | null> {
  const members = await sql`
    SELECT m.id FROM entity_identities ei JOIN member m
      ON m."userId" = ei.identifier AND m."organizationId" = ei.organization_id
    WHERE ei.organization_id = ${organizationId} AND ei.entity_id = ${entityId}
      AND ei.namespace = 'auth_user_id' AND ei.source_connector = 'auth:signup'
      AND ei.deleted_at IS NULL
  `;
  if (members.length > 1) {
    throw new ToolUserError('Member has more than one authentication identity', 400);
  }
  return members.length === 1 ? (members[0].id as string) : null;
}

/**
 * Insert a Better Auth invitation unless one is already pending for the email.
 * A pending invitation for another role is a conflict, resolved by editing the
 * record that owns it rather than silently keeping either role.
 */
async function ensurePendingInvitation(
  sql: DbClient,
  ctx: EntityHookContext,
  email: string,
  role: string
): Promise<void> {
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
    return;
  }
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

/**
 * Cancel every pending invitation for an email, recording each cancellation
 * so the invitation lifecycle audit (sent → cancelled) stays complete.
 */
async function cancelPendingInvitations(
  sql: DbClient,
  ctx: EntityTransactionHookContext,
  email: string
): Promise<void> {
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
  for (const inv of cancelled) {
    await insertWorkspaceChangeEventInTransaction({
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
    }, sql);
  }
}

interface MemberEmailChange {
  entityId: number;
  oldEmail: string | null;
  newEmail: string | null;
  /** The record's full metadata after the edit. */
  metadata: Record<string, unknown> | null | undefined;
}

// An email added or corrected after the $member record was created must invite
// like a create-with-email does: creating the record and filling in the email
// later is the same administrative act, and leaving it invite-free strands the
// invitee with a record but no access (the placeholder looks "added" while
// organizations.list hides the workspace until an invitation is accepted).
async function updateMemberInvitationForEmail(
  sql: DbClient,
  ctx: EntityTransactionHookContext,
  change: MemberEmailChange
): Promise<void> {
  const { entityId, oldEmail, newEmail } = change;
  // An established membership owns its access; an email edit there stays a
  // pure profile edit and must not mint invitations.
  if (await linkedMemberId(sql, ctx.organizationId, entityId)) return;
  assertHumanMemberChange(ctx.principal);
  const role = parseMemberRole(change.metadata?.role ?? 'member');
  await authorizeMemberRole(sql, ctx.organizationId, ctx.userId, role);
  // A removed or replaced address must not keep a live invitation behind:
  // cancel it the way deleting the record does.
  if (oldEmail) await cancelPendingInvitations(sql, ctx, oldEmail);
  if (!newEmail) return;
  await ensurePendingInvitation(sql, ctx, newEmail, role);
  // Hooks cannot write entity rows directly (entity-write funnel), so the
  // status badge flips through the validated patch like member-entity's
  // role/status projections do.
  const metadata = { ...(change.metadata ?? {}), status: 'invited' };
  await patchEntityRows({
    tx: sql,
    ids: [entityId],
    patch: await validateEntityRowPatch({ tx: sql, ids: [entityId], patch: { metadata } }),
  });
  // The invitation row commits with this transaction, so the email — which
  // reads it back on a fresh connection — must run after commit.
  if (ctx.deferAfterCommit) {
    ctx.deferAfterCommit(() => sendMemberInvitationEmail({ metadata }, ctx));
  } else {
    logger.error('[Entity Hook] No post-commit drain for $member invitation email; invitation created without email');
  }
}

registerEntityHooks('$member', {
  async beforeCreate(data, ctx) {
    assertHumanMemberChange(ctx.principal);
    const sql = ctx.sql ?? getDb();
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, sql);
    const meta = { ...(data.metadata ?? {}) };
    const role = parseMemberRole(meta.role ?? 'member');
    await lockMemberRoleChanges(sql, ctx.organizationId);
    await authorizeMemberRole(sql, ctx.organizationId, ctx.userId, role);
    meta.role = role;
    const email = meta[emailField] as string | undefined;

    if (email) {
      await ensurePendingInvitation(sql, ctx, email, role);
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
    // A role write needs the org-wide serialization; an email write may mint
    // an invitation in afterUpdate, so it claims the same lock. Other profile
    // edits skip it so they never block unrelated entity writes.
    if (Object.hasOwn(fields, 'role')) {
      await lockMemberRoleChanges(ctx.sql, ctx.organizationId);
      return;
    }
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, ctx.sql);
    if (Object.hasOwn(fields, emailField)) {
      await lockMemberRoleChanges(ctx.sql, ctx.organizationId);
    }
  },

  async afterUpdate(before, after, ctx) {
    const sql = ctx.sql;
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, sql);
    const oldEmail = before.metadata?.[emailField];
    const newEmail = after.metadata?.[emailField];
    const roleChanged = before.metadata?.role !== after.metadata?.role;
    const emailChanged = oldEmail !== newEmail;
    if (!roleChanged && !emailChanged) return;
    // An editable profile field must never retarget a permission mutation.
    if (roleChanged && emailChanged) {
      assertHumanMemberChange(ctx.principal);
      throw new ToolUserError('Change member email separately from its permission role', 400);
    }
    if (emailChanged) {
      await updateMemberInvitationForEmail(sql, ctx, {
        entityId: before.id,
        oldEmail: typeof oldEmail === 'string' && oldEmail !== '' ? oldEmail : null,
        newEmail: typeof newEmail === 'string' && newEmail !== '' ? newEmail : null,
        metadata: after.metadata,
      });
      return;
    }
    assertHumanMemberChange(ctx.principal);
    const role = parseMemberRole(after.metadata?.role);
    const memberId = await linkedMemberId(sql, ctx.organizationId, before.id);
    if (memberId) {
      await changeMemberRoleInTransaction(sql, {
        organizationId: ctx.organizationId, actorId: ctx.userId,
        memberId, role, actorSource: ctx.actorSource ?? 'api',
      });
      return;
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

  async lockBeforeDelete(ctx) {
    await lockMemberRoleChanges(ctx.sql, ctx.organizationId);
  },

  // Deleting the record is how the web app removes a person, so it removes the
  // membership in the same transaction, as a role edit changes it. Leaving the
  // `member` row would tombstone the record while the person kept full access.
  async beforeDelete(entity, ctx) {
    assertHumanMemberChange(ctx.principal);
    const sql = ctx.sql;
    const { emailField } = await resolveMemberSchemaFields(ctx.organizationId, sql);
    const email = entity.metadata?.[emailField] as string | undefined;

    const memberId = await linkedMemberId(sql, ctx.organizationId, entity.id);
    if (memberId) {
      await removeMemberInTransaction(sql, {
        organizationId: ctx.organizationId, actorId: ctx.userId,
        memberId, actorSource: ctx.actorSource ?? 'api',
      });
    } else if (email) {
      // A record that lost its claim cannot be tied to a membership safely, but
      // deleting it must never look like a removal while that person keeps access.
      const [unlinked] = await sql`
        SELECT 1 FROM member m JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = ${ctx.organizationId} AND lower(u.email) = lower(${email})
        LIMIT 1
      `;
      if (unlinked) {
        throw new ToolUserError(
          'This member record is not linked to the sign-in of the workspace member with this email, so deleting it would not remove their access. Nothing was changed.',
          409
        );
      }
    }
    if (email) await cancelPendingInvitations(sql, ctx, email);
  },
});
