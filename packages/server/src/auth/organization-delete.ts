import { APIError } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { getDb } from '../db/client';
import { requestWorkspaceDeletion } from '../workspace/deletion';
import { isDeletionRequested, organizationLiveSql } from '../workspace/deletion-state';
import { isPersonalOrgDeletionBlocked } from './personal-org-provisioning';

const ORGANIZATION_DELETE_PATH = '/organization/delete';
const ORGANIZATION_UPDATE_PATH = '/organization/update';
const ORGANIZATION_PATH_PREFIX = '/organization/';

function organizationNotFound(): APIError {
  return new APIError('NOT_FOUND', {
    code: 'ORGANIZATION_NOT_FOUND',
    message: 'Organization not found',
  });
}

interface RequestSession {
  user: { id: string };
  session: { token: string; activeOrganizationId?: string | null };
}

/**
 * Owns Better Auth's `POST /organization/delete`.
 *
 * Better Auth deletes the organization synchronously inside one transaction,
 * which runs the whole FK cascade at once: a large workspace outlives the
 * statement timeout, and tables with no FK keep orphaned rows. This plugin's
 * before hook short-circuits the endpoint (the same mechanism as
 * `memberRoleAuthHook`) and records a deletion request instead; the
 * `workspace-purge` task removes it in the background. The organization
 * plugin sets `disableOrganizationDeletion`, so
 * the synchronous path cannot run even if this hook were bypassed.
 *
 * Sibling before hooks never see each other's header rewrites (Better Auth
 * merges them only after every hook ran), so the bearer plugin's token → cookie
 * conversion is invisible here. The session is therefore resolved through the
 * full auth API by the caller-supplied resolver, which covers cookies and
 * `Authorization: Bearer` alike.
 *
 * Origin/CSRF validation already ran: Better Auth registers its origin check
 * as a router middleware, which runs before endpoint hooks. The response is
 * the deleted organization, as Better Auth's own endpoint returned.
 */
export function workspaceDeletionPlugin(
  resolveRequestSession: (headers: Headers) => Promise<RequestSession | null>,
) {
  const handler = createAuthMiddleware(async (ctx) => {
    const session = ctx.headers ? await resolveRequestSession(ctx.headers) : null;
    if (!session) throw new APIError('UNAUTHORIZED');
    const organizationId = ctx.body?.organizationId;
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new APIError('BAD_REQUEST', {
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    const sql = getDb();
    const [org] = await sql<{
      id: string;
      name: string;
      slug: string;
      logo: string | null;
      createdAt: Date;
      metadata: string | null;
      role: string;
    }>`
      SELECT o.id, o.name, o.slug, o.logo, o."createdAt", o.metadata, m.role
      FROM organization o
      JOIN member m ON m."organizationId" = o.id AND m."userId" = ${session.user.id}
      WHERE o.id = ${organizationId}
    `;
    if (!org) {
      throw new APIError('BAD_REQUEST', {
        code: 'USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION',
        message: 'User is not a member of the organization',
      });
    }
    if (org.role !== 'owner') {
      throw new APIError('FORBIDDEN', {
        code: 'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_ORGANIZATION',
        message: 'You are not allowed to delete this organization',
      });
    }
    // A personal org is not user-deletable — see `isPersonalOrgDeletionBlocked`.
    if (isPersonalOrgDeletionBlocked(org.metadata, session.user.id)) {
      throw new APIError('FORBIDDEN', {
        code: 'PERSONAL_ORGANIZATION_CANNOT_BE_DELETED',
        message:
          "Your personal workspace can't be deleted — devices and personal connections are bound to it.",
      });
    }

    await requestWorkspaceDeletion(sql, {
      organizationId: org.id,
      requestedBy: session.user.id,
      actorSource: 'ui',
    });
    if (session.session.activeOrganizationId === org.id) {
      await ctx.context.internalAdapter.updateSession(session.session.token, {
        activeOrganizationId: null,
      });
    }

    const { role: _role, ...deleted } = org;
    return ctx.json(deleted);
  });

  // A deleting workspace is read-only: an owner's metadata update would
  // otherwise overwrite the marker and resurface the workspace mid-purge.
  const refuseUpdate = createAuthMiddleware(async (ctx) => {
    const bodyOrgId = ctx.body?.organizationId;
    let organizationId = typeof bodyOrgId === 'string' && bodyOrgId ? bodyOrgId : null;
    if (!organizationId && ctx.headers) {
      const session = await resolveRequestSession(ctx.headers);
      organizationId = session?.session.activeOrganizationId ?? null;
    }
    if (!organizationId) return;
    const sql = getDb();
    const deleting = await sql`
      SELECT 1 FROM organization o
      WHERE o.id = ${organizationId} AND NOT ${sql.unsafe(organizationLiveSql('o'))}
    `;
    if (deleting.length > 0) throw organizationNotFound();
  });

  // Better Auth's organization reads (list, get-full-organization,
  // set-active, ...) go through its own adapter, not our SQL predicate, so the
  // deleting workspace is filtered from their responses here.
  const hideFromResponses = createAuthMiddleware(async (ctx) => {
    const returned = ctx.context.returned;
    if (Array.isArray(returned)) {
      const visible = returned.filter(
        (org) => !isDeletionRequested((org as { metadata?: unknown } | null)?.metadata),
      );
      return visible.length !== returned.length ? ctx.json(visible) : undefined;
    }
    if (
      returned &&
      typeof returned === 'object' &&
      !(returned instanceof APIError) &&
      'slug' in returned &&
      isDeletionRequested((returned as { metadata?: unknown }).metadata)
    ) {
      throw organizationNotFound();
    }
    return undefined;
  });

  return {
    id: 'workspace-deletion',
    hooks: {
      before: [
        { matcher: (ctx) => ctx.path === ORGANIZATION_DELETE_PATH, handler },
        { matcher: (ctx) => ctx.path === ORGANIZATION_UPDATE_PATH, handler: refuseUpdate },
      ],
      after: [
        {
          matcher: (ctx) =>
            (ctx.path ?? '').startsWith(ORGANIZATION_PATH_PREFIX) &&
            ctx.path !== ORGANIZATION_DELETE_PATH,
          handler: hideFromResponses,
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
