/**
 * Workspace navigation: the curated sidebar document stored on the
 * organization row, and its resolution into links for one reader.
 *
 * Storage is one nullable JSONB document plus a revision. A write replaces the
 * whole document and lands only when the caller's revision is still current, so
 * two editors cannot silently overwrite each other.
 *
 * Resolution never trusts the document for access: every target is looked up
 * again for the reader through the reads the destination itself uses — views
 * by attachment through `viewPagePath`, records through `manage_entity get`
 * (read restrictions, identity groups, the member directory, deletion), types
 * through the same entity read gate, event subjects through the event page's
 * check. An unresolvable target is dropped without its label, and a group left
 * empty is dropped with it, so a deleted or restricted destination never shows
 * up by name. The workspace-wide view list is not narrowed: views carry no
 * per-reader ACL today.
 */

import type { CollectionSelection } from '@lobu/core/contracts/tools/collection-selection';
import type { ViewAttachment, ViewParamDecl } from '@lobu/core/contracts/tools/manage-views';
import {
  type NavigationConfig,
  type NavigationItem,
  navigationHrefDestination,
  type PageRef,
  type ResolvedNavigationItem,
  type ResolvedNavigationSection,
} from '@lobu/core/contracts/tools/navigation';
import { hasWorkspaceAttachment } from '@lobu/core/contracts/tools/view-attach';
import { viewPathSuffix } from '@lobu/core/contracts/tools/view-path';
import { getDb, pgTextArray } from '../db/client';
import type { Env } from '../index';
import { memberReadRole } from '../tools/access-control';
import { assertEntityReadAllowed, manageEntity } from '../tools/admin/manage_entity';
import { MEMBER_ENTITY_TYPE_SLUG } from '../tools/constants';
import { resolveViewParams, viewLinkQuery, viewPagePath } from '../tools/open_view';
import type { ToolContext } from '../tools/registry';
import { resolvePublicOrigin } from '../utils/public-origin';
import { canSeeMemberList } from '../utils/member-entity-type';
import { getOrganizationSlug } from '../utils/url-builder';
import { resolveEventViewSubject } from './event-subject';
import { getView } from './views';

/** Reads the resolver runs at once: a document holds up to 5,000 targets, and
 *  `get_navigation` is a public read, so per-target checks share the pool in
 *  small batches. */
const TARGET_READ_CONCURRENCY = 8;

async function inBatches<T>(items: readonly T[], read: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += TARGET_READ_CONCURRENCY) {
    await Promise.all(items.slice(i, i + TARGET_READ_CONCURRENCY).map(read));
  }
}

export interface NavigationState {
  revision: number;
  config: NavigationConfig | null;
}

export async function readNavigation(organizationId: string): Promise<NavigationState> {
  const sql = getDb();
  const rows = await sql<{ navigation_config: NavigationConfig | null; navigation_revision: string | number }>`
    SELECT navigation_config, navigation_revision FROM organization WHERE id = ${organizationId}
  `;
  const row = rows[0];
  return {
    revision: row ? Number(row.navigation_revision) : 0,
    config: row?.navigation_config ?? null,
  };
}

/** Replace the document if `expectedRevision` is current; null when it is stale. */
export async function writeNavigation(
  organizationId: string,
  expectedRevision: number,
  config: NavigationConfig | null
): Promise<NavigationState | null> {
  const sql = getDb();
  const rows = await sql<{ navigation_config: NavigationConfig | null; navigation_revision: string | number }>`
    UPDATE organization
    SET navigation_config = ${config === null ? null : sql.json(config)},
        navigation_revision = navigation_revision + 1
    WHERE id = ${organizationId} AND navigation_revision = ${expectedRevision}
    RETURNING navigation_config, navigation_revision
  `;
  const row = rows[0];
  if (!row) return null;
  return { revision: Number(row.navigation_revision), config: row.navigation_config ?? null };
}

interface ViewMeta {
  key: string;
  name: string;
  attach: ViewAttachment[];
  params: Record<string, ViewParamDecl>;
}

interface Lookup {
  orgSlug: string;
  origin: string;
  views: Map<string, ViewMeta>;
  types: Map<string, string>;
  entities: Map<number, { entity_type: string; slug: string; name: string }>;
  /** Event ids whose subject the reader may open, per view key. */
  events: Map<string, boolean>;
}

function walk(items: NavigationItem[] | undefined, visit: (item: NavigationItem) => void): void {
  for (const item of items ?? []) {
    visit(item);
    walk(item.children, visit);
  }
}

async function buildLookup(
  config: NavigationConfig | null,
  ctx: ToolContext,
  env: Env
): Promise<Lookup> {
  const sql = getDb();
  const typeSlugs = new Set<string>();
  const entityIds = new Set<number>();
  // One check per distinct (view, event), however often the document repeats it.
  const eventTargets = new Map<string, { key: string; event: number }>();
  for (const section of config?.sections ?? []) {
    walk(section.items, (item) => {
      const target = item.target;
      if (target?.kind === 'collection') typeSlugs.add(target.entityType);
      if (target?.kind === 'record') entityIds.add(target.entityId);
      if (target?.kind === 'view') {
        if (target.scope?.type !== undefined) typeSlugs.add(target.scope.type);
        if (target.scope?.entity !== undefined) entityIds.add(target.scope.entity);
        if (target.scope?.event !== undefined)
          eventTargets.set(`${target.key}\u0000${target.scope.event}`, { key: target.key, event: target.scope.event });
      }
    });
  }
  const [orgSlug, viewRows, typeRows] = await Promise.all([
    getOrganizationSlug(ctx.organizationId),
    sql<ViewMeta>`
      SELECT key, name, attach, params FROM views
      WHERE organization_id = ${ctx.organizationId}
      ORDER BY key ASC
    `,
    typeSlugs.size === 0
      ? Promise.resolve([] as Array<{ slug: string; name: string }>)
      : // The entity type search path every other type read uses: the
        // workspace's own type first, then a public catalog's. `$member` is
        // per-workspace and never comes from a catalog.
        sql<{ slug: string; name: string }>`
          SELECT DISTINCT ON (et.slug) et.slug, et.name
          FROM entity_types et
          LEFT JOIN organization o ON o.id = et.organization_id
          WHERE et.deleted_at IS NULL
            AND et.slug = ANY(${pgTextArray([...typeSlugs])}::text[])
            AND (
              et.organization_id = ${ctx.organizationId}
              OR (o.visibility = 'public' AND et.slug <> ${MEMBER_ENTITY_TYPE_SLUG})
            )
          ORDER BY et.slug, (et.organization_id = ${ctx.organizationId}) DESC, et.id ASC
        `,
  ]);
  const lookup: Lookup = {
    orgSlug: orgSlug ?? ctx.organizationId,
    origin: resolvePublicOrigin(ctx.requestUrl ?? ctx.baseUrl ?? 'http://127.0.0.1'),
    views: new Map(viewRows.map((v) => [v.key, v])),
    types: new Map(),
    entities: new Map(),
    events: new Map(),
  };
  // Types: the member directory only for members, and the same read policy
  // that gates a scoped agent's entity reads.
  await inBatches(typeRows, async (type) => {
    if (type.slug === MEMBER_ENTITY_TYPE_SLUG && !canSeeMemberList(memberReadRole(ctx))) return;
    const allowed = await assertEntityReadAllowed(undefined, ctx, type.slug).then(
      () => true,
      () => false
    );
    if (allowed) lookup.types.set(type.slug, type.name);
  });
  // Records: the record page's own read (`manage_entity get`), so every rule
  // it applies — read restrictions, identity groups, the member directory,
  // deletion — decides here too. Bounded by the document's item cap.
  await inBatches([...entityIds], async (id) => {
    const result = (await manageEntity({ action: 'get', entity_id: id }, env, ctx).catch(() => null)) as {
      entity?: { entity_type?: string; slug?: string; name?: string };
    } | null;
    const entity = result?.entity;
    if (entity?.entity_type && entity.slug && typeof entity.name === 'string') {
      lookup.entities.set(id, { entity_type: entity.entity_type, slug: entity.slug, name: entity.name });
    }
  });
  // Event subjects go through the event page's own visibility check. Each
  // view is read once, however many of its events the document names.
  const viewReads = new Map<string, ReturnType<typeof getView>>();
  await inBatches([...eventTargets], async ([id, { key, event }]) => {
    let view = viewReads.get(key);
    if (!view) {
      view = getView(ctx.organizationId, key);
      viewReads.set(key, view);
    }
    const found = await view;
    const ok = found
      ? await resolveEventViewSubject(found, event, env, ctx).then(
          () => true,
          () => false
        )
      : false;
    lookup.events.set(id, ok);
  });
  return lookup;
}

/** The link and default label one target resolves to, or null when it does not. */
function resolveTarget(target: PageRef, lookup: Lookup): { href: string; external?: boolean; name: string } | null {
  const org = lookup.orgSlug;
  switch (target.kind) {
    case 'collection': {
      const name = lookup.types.get(target.entityType);
      return name === undefined ? null : { href: `/${org}/${target.entityType}`, name };
    }
    case 'record': {
      const entity = lookup.entities.get(target.entityId);
      return entity ? { href: `/${org}/${entity.entity_type}/${entity.slug}`, name: entity.name } : null;
    }
    case 'link': {
      const destination = navigationHrefDestination(target.href, lookup.origin, org);
      if (!destination) return null;
      // Validation requires a link's own label; the href is never shown as one.
      return destination.kind === 'external'
        ? { href: destination.href, external: true, name: '' }
        : { href: destination.path, name: '' };
    }
    case 'view': {
      const view = lookup.views.get(target.key);
      if (!view) return null;
      const scope = (target.scope ?? {}) as {
        type?: string;
        entity?: number;
        event?: number;
        collection?: CollectionSelection;
      };
      try {
        let path: string;
        if (scope.event !== undefined) {
          if (!lookup.events.get(`${view.key}\u0000${scope.event}`)) return null;
          path = `/${org}/events/${scope.event}${viewPathSuffix(view.key)}`;
        } else {
          const entity = scope.entity === undefined ? undefined : lookup.entities.get(scope.entity) ?? null;
          path = viewPagePath(view, scope, org, {
            entity,
            typeExists: scope.type === undefined ? undefined : lookup.types.has(scope.type),
          });
        }
        const query = viewLinkQuery(view, scope, resolveViewParams(view, target.params));
        return { href: query ? `${path}?${query}` : path, name: view.name };
      } catch {
        // Not attached where the scope points, a removed subject, or params
        // the view no longer declares with that type.
        return null;
      }
    }
  }
}

/**
 * One item as the reader sees it. A destination that does not resolve (removed,
 * or not readable to this reader) never shows its label — not even as a group
 * heading, which would name it — so its resolvable children take its place.
 */
function resolveItem(item: NavigationItem, lookup: Lookup): ResolvedNavigationItem[] {
  const children = resolveItems(item.children, lookup);
  const icon = item.icon ? { icon: item.icon } : {};
  if (!item.target) {
    // A group exists only for what is in it.
    return children.length > 0 && item.label ? [{ id: item.id, label: item.label, ...icon, children }] : [];
  }
  const target = resolveTarget(item.target, lookup);
  if (!target) return children;
  return [
    {
      id: item.id,
      label: item.label ?? target.name,
      ...icon,
      href: target.href,
      ...(target.external ? { external: true } : {}),
      children,
    },
  ];
}

function resolveItems(items: NavigationItem[] | undefined, lookup: Lookup): ResolvedNavigationItem[] {
  return (items ?? []).flatMap((item) => resolveItem(item, lookup));
}

/** The automatic sidebar when no document is stored: every workspace view. */
function defaultSections(lookup: Lookup): ResolvedNavigationSection[] {
  const items = [...lookup.views.values()]
    .filter((view) => hasWorkspaceAttachment(view.attach))
    .map((view) => ({
      id: `view:${view.key}`,
      label: view.name,
      href: `/${lookup.orgSlug}/data${viewPathSuffix(view.key)}`,
      children: [],
    }));
  return items.length > 0 ? [{ id: 'views', items }] : [];
}

export async function resolveNavigation(
  config: NavigationConfig | null,
  ctx: ToolContext,
  env: Env
): Promise<ResolvedNavigationSection[]> {
  const lookup = await buildLookup(config, ctx, env);
  if (config === null) return defaultSections(lookup);
  return config.sections.flatMap((section) => {
    const items = resolveItems(section.items, lookup);
    return items.length > 0 ? [{ id: section.id, ...(section.label ? { label: section.label } : {}), items }] : [];
  });
}

/**
 * Ids of items whose target does not resolve for this (writing) caller. A
 * write names them so an author does not save a link to a page that is not
 * there; later deletions only hide the entry.
 */
export async function unresolvedTargets(config: NavigationConfig, ctx: ToolContext, env: Env): Promise<string[]> {
  const lookup = await buildLookup(config, ctx, env);
  const missing: string[] = [];
  for (const section of config.sections) {
    walk(section.items, (item) => {
      if (item.target && !resolveTarget(item.target, lookup)) missing.push(item.id);
    });
  }
  return missing;
}
