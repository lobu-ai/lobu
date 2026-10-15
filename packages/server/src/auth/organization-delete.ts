import { APIError } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';
import { getDb, pgTextArray } from '../db/client';
import { requestWorkspaceDeletion } from '../workspace/deletion';
import {
  carriesDeletionMarker,
  isDeletionRequested,
  organizationLiveSql,
} from '../workspace/deletion-state';
import { isPersonalOrgDeletionBlocked } from './personal-org-provisioning';

const ORGANIZATION_DELETE_PATH = '/organization/delete';
const ORGANIZATION_CREATE_PATH = '/organization/create';
const ORGANIZATION_UPDATE_PATH = '/organization/update';
const ORGANIZATION_LIST_PATH = '/organization/list';
const ORGANIZATION_SET_ACTIVE_PATH = '/organization/set-active';
const ORGANIZATION_PATH_PREFIX = '/organization/';

function organizationNotFound(): APIError {
  return new APIError('NOT_FOUND', {
    code: 'ORGANIZATION_NOT_FOUND',
    message: 'Organization not found',
  });
}

interface RequestSession {
  user: { id: string };
  session: { activeOrganizationId?: string | null };
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
    const { role: _role, ...deleted } = org;
    return ctx.json(deleted);
  });

  // The deletion marker is written only by `requestWorkspaceDeletion`, after
  // the owner and personal-workspace checks above. Accepting it from a client
  // would let an admin hide a workspace with no owner decision and no purge.
  const refuseReservedMetadata = createAuthMiddleware(async (ctx) => {
    const metadata =
      ctx.path === ORGANIZATION_CREATE_PATH ? ctx.body?.metadata : ctx.body?.data?.metadata;
    if (carriesDeletionMarker(metadata)) {
      throw new APIError('BAD_REQUEST', {
        code: 'ORGANIZATION_METADATA_KEY_RESERVED',
        message: 'Organization metadata cannot set a deletion marker',
      });
    }
  });

  // One guard for every Better Auth organization endpoint, run BEFORE the
  // endpoint so no member, invitation, role or session change is applied and
  // then hidden. Which selector an endpoint consumes varies by endpoint (and
  // one it ignores must not hide the workspace it acts on), so the target is
  // every organization the request could resolve to: each organization id or
  // slug, invitation and member it names, plus the session's active
  // organization that Better Auth falls back to. The one place the fallback
  // does not apply is Better Auth's own: set-active given an explicit target
  // or `organizationId: null` acts on that, not on the active organization.
  // `requestWorkspaceDeletion` clears every session's active organization, so
  // only a session that raced the request still holds one, and it must switch
  // away (or clear) before anything else.
  const refuseDeletingTarget = createAuthMiddleware(async (ctx) => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const query = (ctx.query ?? {}) as Record<string, unknown>;
    const strings = (...values: unknown[]) =>
      values.filter((value): value is string => typeof value === 'string' && value.length > 0);

    const organizationIds = strings(body.organizationId, query.organizationId);
    const slugs = strings(body.organizationSlug, query.organizationSlug);
    const invitationIds = strings(body.invitationId, query.invitationId, query.id);
    const memberIds = strings(body.memberId, body.memberIdOrEmail);

    const setsActiveExplicitly =
      ctx.path === ORGANIZATION_SET_ACTIVE_PATH &&
      (body.organizationId === null || organizationIds.length + slugs.length > 0);
    if (!setsActiveExplicitly && ctx.headers) {
      const session = await resolveRequestSession(ctx.headers);
      const active = session?.session.activeOrganizationId;
      if (active) organizationIds.push(active);
    }
    if (organizationIds.length + slugs.length + invitationIds.length + memberIds.length === 0) {
      return;
    }

    const sql = getDb();
    const deleting = await sql`
      SELECT 1 FROM organization o
      WHERE NOT ${sql.unsafe(organizationLiveSql('o'))}
        AND (
          o.id = ANY(${pgTextArray(organizationIds)}::text[])
          OR o.slug = ANY(${pgTextArray(slugs)}::text[])
          OR o.id IN (
            SELECT i."organizationId" FROM invitation i
            WHERE i.id = ANY(${pgTextArray(invitationIds)}::text[])
          )
          OR o.id IN (
            SELECT m."organizationId" FROM member m
            WHERE m.id = ANY(${pgTextArray(memberIds)}::text[])
          )
        )
      LIMIT 1
    `;
    if (deleting.length > 0) throw organizationNotFound();
  });

  // `/organization/list` reads through Better Auth's adapter, not our SQL
  // predicate, and names no target, so the deleting workspace is filtered from
  // its response here.
  const hideFromList = createAuthMiddleware(async (ctx) => {
    const returned = ctx.context.returned;
    if (!Array.isArray(returned)) return undefined;
    const visible = returned.filter(
      (org) => !isDeletionRequested((org as { metadata?: unknown } | null)?.metadata),
    );
    return visible.length !== returned.length ? ctx.json(visible) : undefined;
  });

  return {
    id: 'workspace-deletion',
    hooks: {
      before: [
        { matcher: (ctx) => ctx.path === ORGANIZATION_DELETE_PATH, handler },
        {
          matcher: (ctx) =>
            ctx.path === ORGANIZATION_CREATE_PATH || ctx.path === ORGANIZATION_UPDATE_PATH,
          handler: refuseReservedMetadata,
        },
        // Delete resolves and checks its own target in `handler`.
        {
          matcher: (ctx) =>
            (ctx.path ?? '').startsWith(ORGANIZATION_PATH_PREFIX) &&
            ctx.path !== ORGANIZATION_DELETE_PATH,
          handler: refuseDeletingTarget,
        },
      ],
      after: [{ matcher: (ctx) => ctx.path === ORGANIZATION_LIST_PATH, handler: hideFromList }],
    },
  } satisfies BetterAuthPlugin;
}
