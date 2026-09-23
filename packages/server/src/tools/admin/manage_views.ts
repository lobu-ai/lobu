/**
 * Tool: manage_views
 *
 * View management (the re-key of `manage_view_templates`). Actions:
 * set/get/list/remove. There are no attach/detach, rollback, versions or
 * clear verbs: the attach line lives in the module source, git is the only
 * history of definitions, and removing a view is `remove`.
 *
 * `set` compiles `source_code` server-side with esbuild (browser IIFE) and
 * upserts by (organization_id, key). Same executable artifact (source,
 * declared metadata AND compiled bundle digest) means the same content hash
 * and no write. The server never executes view code.
 */

import {
  GetViewAction,
  ListViewsAction,
  ManageViewsResultSchema,
  ManageViewsSchema,
  RemoveViewAction,
  SetViewAction,
  type ManageViewsResult,
} from '@lobu/core/contracts/tools/manage-views';
import type { Static } from '@sinclair/typebox';
import { emit } from '../../events/emitter';
import { ToolUserError } from '../../utils/errors';
import {
  isShellOwnedParam,
  VIEW_ACTION_NAME_RE,
  VIEW_COMPILED_MAX_BYTES,
  VIEW_SOURCE_MAX_CHARS,
  compileView,
  contentHash,
  getView,
  isValidViewKey,
  listViews,
  projectView,
  removeView,
  setView,
  type SetViewInput,
} from '../../views/views';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';

export { ManageViewsResultSchema, ManageViewsSchema };

// Variants in the contract's order, so the derived union matches the exposed
// `ManageViewsSchema`. Each handler receives its own variant's args.
const manageViewsTool = defineActionTool('manage_views', {
  set: action(SetViewAction, handleSet),
  get: action(GetViewAction, handleGet),
  list: action(ListViewsAction, handleList),
  remove: action(RemoveViewAction, handleRemove),
});

export const manageViews = manageViewsTool.run;

// ============================================
// Helpers
// ============================================

/** Writes need a signed-in caller; reads ride on the workspace context. */
function requireWriter(ctx: ToolContext): void {
  if (!ctx.userId) throw new ToolUserError('Authentication required', 401);
}

// Event-kind names are `<subject>.<op>` (`deal.won`); the semantic check
// against the kind registry happens when the action fires, but a malformed
// name is rejected at authoring so it can never be stored.
const EMITS_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

/**
 * Validate the caller-declared metadata (`lobu apply` extracts attach/params/
 * actions from the module file; direct callers declare them). Shape only: the
 * server does not execute the module to re-derive them.
 */
function validateViewMetadata(args: Static<typeof SetViewAction>): void {
  if (!isValidViewKey(args.key)) {
    throw new ToolUserError(
      `Invalid view key '${args.key}': use 1-64 lowercase letters, digits and dashes`
    );
  }
  if (typeof args.source_code !== 'string' || args.source_code.length === 0) {
    throw new ToolUserError('set requires source_code', 400);
  }
  if (args.source_code.length > VIEW_SOURCE_MAX_CHARS) {
    throw new ToolUserError(
      `source_code is ${args.source_code.length} chars, over the ${VIEW_SOURCE_MAX_CHARS} char cap`,
      422
    );
  }
  for (const entry of args.attach ?? []) {
    const keys = [
      'type' in entry && entry.type !== undefined,
      'entity' in entry && entry.entity !== undefined,
      'workspace' in entry && entry.workspace !== undefined,
    ].filter(Boolean).length;
    if (keys !== 1) {
      throw new ToolUserError(
        'Each attach entry needs exactly one of type, entity or workspace',
        400
      );
    }
    if ('type' in entry && entry.type !== undefined && entry.type.trim() === '') {
      throw new ToolUserError('attach type must not be blank', 400);
    }
    if ('entity' in entry && entry.entity !== undefined) {
      const entity = entry.entity;
      if (
        typeof entity !== 'number' &&
        (typeof entity !== 'string' || entity.trim() === '')
      ) {
        throw new ToolUserError('attach entity must be an id or a slug', 400);
      }
    }
  }
  for (const [name, decl] of Object.entries(args.params ?? {})) {
    if (isShellOwnedParam(name)) {
      throw new ToolUserError(
        `Param '${name}' is reserved: the web shell's peek pane reads peek and peek_* on every page`,
        400
      );
    }
    // Defaults must match their declared scalar type: the reader fills them
    // in verbatim, so a mistyped default would surface as a wrong-typed
    // param (or a 500) instead of failing at authoring.
    const d = decl.default;
    if (
      d !== undefined &&
      (typeof d !== decl.type ||
        (typeof d === 'number' && !Number.isFinite(d)))
    ) {
      throw new ToolUserError(
        `Param '${name}' default must be a ${decl.type}`,
        400
      );
    }
  }
  for (const [name, decl] of Object.entries(args.actions ?? {})) {
    if (!VIEW_ACTION_NAME_RE.test(name)) {
      throw new ToolUserError(
        `Action '${name}' must start with a letter and contain only letters, digits, underscores or dashes (1-64 characters)`,
        400
      );
    }
    if (!EMITS_NAME_RE.test(decl.emits)) {
      throw new ToolUserError(
        `Action '${name}' emits '${decl.emits}': use <subject>.<op> event-kind names`,
        400
      );
    }
  }
}

// ============================================
// Action Handlers
// ============================================

async function handleSet(
  args: Static<typeof SetViewAction>,
  ctx: ToolContext
): Promise<ManageViewsResult> {
  requireWriter(ctx);
  validateViewMetadata(args);

  // Normalize BEFORE hashing: the comparison must see exactly what the row
  // would store, or equivalent declarations compare differently.
  const name = args.name?.trim() ? args.name : args.key;
  const description = args.description ?? '';
  const attach = (args.attach ?? []) as SetViewInput['attach'];
  const params = (args.params ?? {}) as SetViewInput['params'];
  const actions = (args.actions ?? {}) as SetViewInput['actions'];
  // Resolve the executable artifact BEFORE the identity: a supplied bundle is
  // validated (non-empty, under the cap) and source-only input is compiled,
  // so the no-op comparison below sees the same bytes `setView` would store.
  // Comparing a source/metadata-only hash first would discard bundle-only
  // fixes before they reach the compiled-bytes comparison.
  const compiled = args.compiled_code
    ? checkCompiledCode(args.compiled_code)
    : await compileView(args.source_code);
  const hash = contentHash(
    args.source_code,
    {
      name,
      description,
      attach,
      params,
      actions,
    },
    compiled
  );
  // Same source AND same metadata AND same executable bundle: no write.
  // A legacy row (source/metadata-only hash) never matches, so it refreshes
  // exactly once on the next set and is a no-op after that.
  const current = await getView(ctx.organizationId, args.key);
  if (current && current.content_hash === hash) {
    return { action: 'set', view: projectView(current), written: false };
  }

  const { view, written } = await setView(ctx.organizationId, {
    key: args.key,
    name,
    description,
    source_code: args.source_code,
    compiled_code: compiled,
    content_hash: hash,
    attach,
    params,
    actions,
    last_writer: args.last_writer ?? (ctx.applyId ? `apply:${ctx.applyId}` : (ctx.userId ?? 'unknown')),
  });

  // No config-audit emission: the audit trail gains no view resource kind in
  // phase 1, and `last_writer` (apply_id | user) carries the provenance.
  // A no-op set changes nothing, so it invalidates nothing.
  if (written) {
    emit(ctx.organizationId, { keys: [`view:${args.key}`] });
  }

  return { action: 'set', view: projectView(view), written };
}

/**
 * Validate a CLI-bundled browser bundle: non-empty and under the same cap the
 * server compiler enforces, so the two set paths store comparable artifacts.
 * The bundle is author code shipped over an operator credential — the same
 * trust as `source_code` — so no recompilation, just the size check.
 */
function checkCompiledCode(compiledCode: string): string {
  if (compiledCode.length === 0) {
    throw new ToolUserError('set requires compiled_code to be non-empty', 400);
  }
  const bytes = Buffer.byteLength(compiledCode, 'utf8');
  if (bytes > VIEW_COMPILED_MAX_BYTES) {
    throw new ToolUserError(
      `View bundle is ${bytes} bytes, over the ${VIEW_COMPILED_MAX_BYTES} byte cap`,
      422
    );
  }
  return compiledCode;
}

async function handleGet(
  args: Static<typeof GetViewAction>,
  ctx: ToolContext
): Promise<ManageViewsResult> {
  const view = await getView(ctx.organizationId, args.key);
  if (!view) throw new ToolUserError(`Unknown view: ${args.key}`, 404);
  return { action: 'get', view: projectView(view), source_code: view.source_code };
}

async function handleList(
  _args: Static<typeof ListViewsAction>,
  ctx: ToolContext
): Promise<ManageViewsResult> {
  const views = await listViews(ctx.organizationId);
  return { action: 'list', views: views.map(projectView) };
}

async function handleRemove(
  args: Static<typeof RemoveViewAction>,
  ctx: ToolContext
): Promise<ManageViewsResult> {
  requireWriter(ctx);
  const removed = await removeView(ctx.organizationId, args.key);
  if (removed) {
    emit(ctx.organizationId, { keys: [`view:${args.key}`] });
  }
  return { action: 'remove', key: args.key, removed };
}
