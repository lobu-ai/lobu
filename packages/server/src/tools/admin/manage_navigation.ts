import { randomUUID } from 'node:crypto';
import {
  GetNavigationAction,
  SetNavigationAction,
  ManageNavigationSchema,
  ManageNavigationResultSchema,
  validateNavigationDocument,
  type NavigationDocument,
  type NavigationTarget,
  type ManageNavigationResult,
} from '@lobu/core/contracts/tools/manage-navigation';
import {
  COLLECTION_PRESENTATION_KEY,
  parseCollectionPresentation,
  resolveCollectionPreset,
} from '@lobu/core/contracts/tools/collection-presentation';
import type { CollectionSelection } from '@lobu/core/contracts/tools/collection-selection';
import type { ViewAttachment } from '@lobu/core/contracts/tools/manage-views';
import { hasWorkspaceAttachment, matchesCollection } from '@lobu/core/contracts/tools/view-attach';
import type { Static } from '@sinclair/typebox';
import { getDb, pgTextArray, type DbClient } from '../../db/client';
import { emit } from '../../events/emitter';
import { assertExpectedRevision, configRevision } from '../../utils/config-revision';
import { ToolUserError } from '../../utils/errors';
import { insertWorkspaceChangeEventInTransaction } from '../../utils/insert-event';
import { deriveToolActorSource } from '../../utils/apply-context';
import { eventClientId } from '../../auth/event-client-id';
import { requireOrgReadAccess, requireOrgWriteAccess } from '../../utils/organization-access';
import { isAdminOrOwnerRole, isInProcessSystemCall, isPublicReader } from '../access-control';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';
import { withToolConfigTransaction } from './helpers/config-audit';

export { ManageNavigationSchema, ManageNavigationResultSchema };

interface NavigationState { id: string; document: NavigationDocument | null }
interface OrganizationNavigation {
  navigation: NavigationState | null;
  created_at: string;
  visibility: string;
}

function revision(ctx: ToolContext, row: OrganizationNavigation): string {
  return configRevision('navigation', `${ctx.organizationId}:${row.navigation?.id ?? row.created_at}`,
    row.navigation?.document ?? null);
}

async function readRow(sql: DbClient, ctx: ToolContext, lock = false): Promise<OrganizationNavigation> {
  await requireOrgReadAccess(sql, ctx);
  const rows = lock
    ? await sql<OrganizationNavigation>`SELECT navigation, "createdAt"::text AS created_at, visibility
        FROM organization WHERE id = ${ctx.organizationId} FOR NO KEY UPDATE`
    : await sql<OrganizationNavigation>`SELECT navigation, "createdAt"::text AS created_at, visibility
        FROM organization WHERE id = ${ctx.organizationId}`;
  const row = rows[0];
  if (!row || (isPublicReader(ctx) && row.visibility !== 'public'))
    throw new ToolUserError('Workspace navigation is not available.', 404);
  return row;
}

/** Read bounded metadata only; never scan a collection or execute its backing query. */
async function targetVisibility(sql: DbClient, ctx: ToolContext, document: NavigationDocument) {
  const targets = document.sections.flatMap(section => section.items.flatMap(item =>
    [item.target, ...(item.children ?? []).map(child => child.target)]));
  const types = [...new Set(targets.flatMap(target => target.entity_type ? [target.entity_type] : []))];
  const keys = [...new Set(targets.flatMap(target => target.type === 'view' ? [target.key] : []))];
  const schemas = types.length ? await sql<{ slug: string; metadata_schema: Record<string, unknown> }>`
    SELECT slug, metadata_schema FROM entity_types
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND slug = ANY(${pgTextArray(types)}::text[])
  ` : [];
  // Custom views retain their existing member-only navigation policy. A public
  // projection must not reveal their keys, names, parent labels, or children.
  const views = keys.length && !isPublicReader(ctx)
    ? await sql<{ key: string; attach: ViewAttachment[] }>`SELECT key, attach FROM views
        WHERE organization_id = ${ctx.organizationId} AND key = ANY(${pgTextArray(keys)}::text[])`
    : [];
  const schemasByType = new Map(schemas.map(schema => [schema.slug, schema]));
  const viewsByKey = new Map(views.map(view => [view.key, view]));
  return (target: NavigationTarget): boolean => {
    let selection: CollectionSelection = {};
    if (target.entity_type) {
      const schema = schemasByType.get(target.entity_type);
      if (!schema) return false;
      if (target.preset) {
        try {
          const presentation = parseCollectionPresentation(schema.metadata_schema?.[COLLECTION_PRESENTATION_KEY] ?? {});
          const preset = presentation.presets?.find(preset => preset.key === target.preset);
          if (!preset) return false;
          selection = resolveCollectionPreset(preset);
        } catch { return false; }
      }
    }
    if (target.type === 'collection') return true;
    const view = viewsByKey.get(target.key);
    return !!view && (target.entity_type
      ? view.attach.some(attachment => matchesCollection(attachment, target.entity_type!, selection))
      : hasWorkspaceAttachment(view.attach));
  };
}

async function handleGet(args: Static<typeof GetNavigationAction>, ctx: ToolContext): Promise<ManageNavigationResult> {
  const sql = getDb();
  const row = await readRow(sql, ctx);
  const document = row.navigation?.document ?? null;
  const result: ManageNavigationResult = { action: 'get', document, revision: revision(ctx, row) };
  // Editors need the complete document to repair deleted targets, rather than
  // accidentally replacing it with a filtered projection.
  if (!document || (args.projection !== 'display' && (isAdminOrOwnerRole(ctx.memberRole) || isInProcessSystemCall(ctx)))) return result;
  const visible = await targetVisibility(sql, ctx, document);
  return { ...result, document: {
    sections: document.sections.map(section => ({
      ...section,
      items: section.items.filter(item => visible(item.target)).map(item => ({
        ...item,
        ...(item.children ? { children: item.children.filter(child => visible(child.target)) } : {}),
      })),
    })).filter(section => section.items.length > 0),
  } };
}

async function handleSet(args: Static<typeof SetNavigationAction>, ctx: ToolContext): Promise<ManageNavigationResult> {
  if (!ctx.userId && !isInProcessSystemCall(ctx)) throw new ToolUserError('Authentication required', 401);
  if (args.document !== null) {
    try { validateNavigationDocument(args.document); }
    catch (error) { throw new ToolUserError((error as Error).message, 422); }
  }
  const result = await withToolConfigTransaction(ctx, async sql => {
    await requireOrgWriteAccess(sql, ctx);
    const row = await readRow(sql, ctx, true);
    const currentRevision = revision(ctx, row);
    assertExpectedRevision(args.expected_revision, currentRevision);
    if (args.document) {
      const visible = await targetVisibility(sql, ctx, args.document);
      for (const section of args.document.sections) {
        for (const item of section.items) {
          for (const node of [item, ...(item.children ?? [])]) {
            if (!visible(node.target)) throw new ToolUserError(`Navigation target '${node.id}' is unavailable or not attached to that page.`, 422);
          }
        }
      }
    }
    const before = row.navigation?.document ?? null;
    const next: NavigationState = {
      // Reset retains a durable new incarnation, so the pre-creation token can
      // never be used to recreate a document after a later reset.
      id: args.document === null || !row.navigation ? randomUUID() : row.navigation.id,
      document: args.document,
    };
    const nextRevision = revision(ctx, { ...row, navigation: next });
    if (args.document !== null && nextRevision === currentRevision)
      return { action: 'set' as const, document: args.document, revision: currentRevision, written: false };
    await sql`UPDATE organization SET navigation = ${sql.json(next)} WHERE id = ${ctx.organizationId}`;
    await insertWorkspaceChangeEventInTransaction({
      organizationId: ctx.organizationId,
      resourceKind: 'organization', resourceId: ctx.organizationId, op: 'updated',
      summary: args.document === null ? 'Workspace navigation reset' : 'Workspace navigation updated',
      state: { navigation: args.document }, before: { navigation: before }, changedFields: ['navigation'],
      action: 'set_navigation', actorSource: deriveToolActorSource(ctx),
      applyId: ctx.applyId,
      createdBy: ctx.userId, clientId: eventClientId(ctx),
      agentId: ctx.agentId, actingAutomationId: ctx.actingAutomationId, actingRunId: ctx.actingRunId,
      mcpSessionId: ctx.mcpSessionId, mcpConversationId: ctx.mcpConversationId, tokenType: ctx.tokenType,
    }, sql);
    return { action: 'set' as const, document: args.document, revision: nextRevision, written: true };
  });
  if (result.written) emit(ctx.organizationId, { keys: ['workspace-navigation'] });
  return result;
}

export const manageNavigation = defineActionTool('manage_navigation', {
  get: action(GetNavigationAction, handleGet),
  set: action(SetNavigationAction, handleSet),
}).run;
