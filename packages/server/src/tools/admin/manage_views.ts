/**
 * Tool: manage_views
 *
 * View management (the re-key of `manage_view_templates`). Actions:
 * set/get/list/remove. There are no attach/detach, rollback, versions or
 * clear verbs: the attach line lives in the module source, git is the only
 * history of definitions, and removing a view is `remove`.
 *
 * `set` compiles `source_code` server-side with esbuild (browser IIFE) and
 * creates an absent key or conditionally replaces its authored revision. Same artifact (source,
 * declared metadata AND compiled bundle digest) means the same content hash
 * and no write. The server never executes view code.
 */

import {
  type SourceDependencies,
  type SourceFiles,
  validateRetainedSource,
} from '@lobu/core/contracts/tools/source-files';
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
import { getDb, pgTextArray } from '../../db/client';
import { isEventAttachment } from '@lobu/core/contracts/tools/view-attach';
import type { ViewDefinitionRecord } from '@lobu/core/contracts/tools/view-definition';
import { ToolUserError } from '../../utils/errors';
import {
  refreshMemberEventKinds,
  validateSaveContentSemanticType,
} from '../../utils/event-kind-validation';
import {
  isShellOwnedParam,
  VIEW_ACTION_NAME_RE,
  VIEW_COMPILED_MAX_BYTES,
  VIEW_SOURCE_MAX_CHARS,
  compileView,
  serverCompileStamp,
  contentHash,
  isServerBuildable,
  getView,
  listViews,
  projectView,
  readViewModule,
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

// Event-kind names are `<subject>.<op>` (`deal.won`). A malformed name is
// rejected here; whether the registry knows the kind is checked by
// `assertActionKindsRegistered`.
const EMITS_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

/** The source size cap, before anything parses it. */
function validateViewSource(args: Static<typeof SetViewAction>): void {
  if (typeof args.source_code !== 'string' || args.source_code.length === 0) {
    throw new ToolUserError('set requires source_code', 400);
  }
  if (args.source_code.length > VIEW_SOURCE_MAX_CHARS) {
    throw new ToolUserError(
      `source_code is ${args.source_code.length} chars, over the ${VIEW_SOURCE_MAX_CHARS} char cap`,
      422
    );
  }
}

/**
 * Rules the definition's schema cannot say: reserved param names, defaults
 * and filter options of the declared type, action and event-kind names.
 */
function validateViewDefinition(def: ViewDefinitionRecord): void {
  for (const [name, decl] of Object.entries(def.params)) {
    if (isShellOwnedParam(name)) {
      throw new ToolUserError(
        `Param '${name}' is reserved for the web shell's collection selection or peek pane`,
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
    // A filter option becomes this param's value when picked, so it must
    // already be a valid value: the guest would coerce a mistyped one away.
    const seen = new Set<unknown>();
    for (const option of decl.filter?.options ?? []) {
      if (typeof option.value !== decl.type) {
        throw new ToolUserError(
          `Param '${name}' filter option '${option.label}' must have a ${decl.type} value`,
          400
        );
      }
      if (seen.has(option.value)) {
        throw new ToolUserError(
          `Param '${name}' filter repeats the option value ${JSON.stringify(option.value)}`,
          400
        );
      }
      seen.add(option.value);
    }
  }
  for (const [name, decl] of Object.entries(def.actions)) {
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

/**
 * A view's actions must be valid in every scope it can mount. Entity-qualified
 * event views inherit that entity's registry; unbound or kind-only attachments
 * still need a workspace kind. Invocation validates the actual source again.
 */
async function assertActionKindsRegistered(
  organizationId: string,
  actions: Record<string, { emits: string }>,
  attach: SetViewInput['attach'],
): Promise<void> {
  if (Object.keys(actions).length === 0) return;
  await refreshMemberEventKinds(organizationId);
  const qualifiedTypes = attach.length > 0 &&
    attach.every((entry) => isEventAttachment(entry) && entry.type)
      ? [...new Set(attach.flatMap((entry) =>
          isEventAttachment(entry) && entry.type ? [entry.type] : []))]
      : [];
  const registries = qualifiedTypes.length === 0 ? [] : await getDb()<{
    slug: string; event_kinds: Record<string, unknown> | null;
  }>`
    SELECT slug, event_kinds FROM entity_types
    WHERE organization_id = ${organizationId}
      AND slug = ANY(${pgTextArray(qualifiedTypes)}::text[])
      AND deleted_at IS NULL
  `;
  for (const [name, decl] of Object.entries(actions)) {
    const global = await validateSaveContentSemanticType(decl.emits, null, organizationId, []);
    if (global.valid) continue;
    if (qualifiedTypes.length > 0 && registries.length === qualifiedTypes.length &&
      registries.every((row) => row.event_kinds && Object.hasOwn(row.event_kinds, decl.emits))) continue;
    throw new ToolUserError(
      `Action '${name}' emits '${decl.emits}', which is not registered for every attached scope. Declare it on the qualified entity types or in $member event_kinds.\n${global.errors.join('\n')}`,
      422,
    );
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
  validateViewSource(args);
  // The module declares the view; defaults are applied by the same reader the
  // CLI hashes with, so both compare exactly what the row would store.
  const def = await readViewModule(args.source_code);
  validateViewDefinition(def);
  const { key, name, description, attach, params, actions } = def;
  await assertActionKindsRegistered(ctx.organizationId, actions, attach);
  // Resolve the executable artifact BEFORE the identity: a supplied bundle is
  // validated (non-empty, under the cap) and source-only input is compiled,
  // so the no-op comparison below sees the same bytes `setView` would store.
  // Comparing a source/metadata-only hash first would discard bundle-only
  // fixes before they reach the compiled-bytes comparison.
  if ((args.source_files === undefined) !== (args.dependencies === undefined)) {
    throw new ToolUserError('source_files and dependencies must be supplied together', 400);
  }
  const retained = args.source_files
    ? { sourceFiles: args.source_files, dependencies: args.dependencies! }
    : args.compiled_code ? undefined : {
      sourceFiles: { entrypoint: 'index.tsx', files: { 'index.tsx': args.source_code } },
      // The runtime comes from the shell, so a source-only view bundles
      // nothing but its own file.
      dependencies: {},
    };
  if (retained) {
    try { validateRetainedSource(args.source_code, retained.sourceFiles, retained.dependencies); }
    catch (error) { throw new ToolUserError((error as Error).message, 400); }
  }
  const compiled = args.compiled_code
    ? checkCompiledCode(args.compiled_code)
    : await compileRetained(retained!);
  const hash = contentHash(
    args.source_code,
    {
      name,
      description,
      attach,
      params,
      actions,
    },
    compiled,
    retained
  );
  // Only a bundle this server compiled may be rebuilt later; a supplied one
  // is the caller's and stays as sent.
  const compileConfigHash = args.compiled_code ? null : serverCompileStamp(compiled);
  const { view, written } = await setView(ctx.organizationId, {
    expected_revision: args.expected_revision,
    key,
    name,
    description,
    source_code: args.source_code,
    compiled_code: compiled,
    source_files: retained?.sourceFiles ?? null,
    dependencies: retained?.dependencies ?? null,
    source_complete: retained !== undefined,
    compile_config_hash: compileConfigHash,
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
    emit(ctx.organizationId, { keys: [`view:${key}`, 'workspace-navigation'] });
  }

  return { action: 'set', view: projectView(view), written };
}

/** Build a bundle-less save from its retained source; only a view whose
 *  dependencies are all shell runtime packages can be built here. */
async function compileRetained(retained: {
  sourceFiles: SourceFiles;
  dependencies: SourceDependencies;
}): Promise<string> {
  if (!isServerBuildable(retained.dependencies)) {
    throw new ToolUserError(
      `View depends on ${Object.keys(retained.dependencies).join(', ')}; save it with lobu apply, which bundles npm dependencies`,
      400
    );
  }
  return compileView(retained.sourceFiles);
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
  return {
    action: 'get', view: projectView(view), source_code: view.source_code,
    source_files: view.source_files, dependencies: view.dependencies,
    source_complete: view.source_complete,
  };
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
  const removed = await removeView(ctx.organizationId, args.key, args.expected_revision);
  if (removed) {
    emit(ctx.organizationId, { keys: [`view:${args.key}`, 'workspace-navigation'] });
  }
  return { action: 'remove', key: args.key, removed };
}
