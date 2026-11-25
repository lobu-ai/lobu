/**
 * Generic factory for action-discriminated admin tools.
 *
 * The `manage_*` tools all share the same shape: an `action` discriminator,
 * a per-action handler, and dispatch via `routeAction` (which enforces the
 * per-action access policy). This module lets a tool declare itself as a map
 * of `action -> { schema, handler }` instead of hand-rolling that plumbing.
 *
 * Two flavors, matching the two schema shapes that exist today:
 *
 * - `defineActionTool` — for tools whose input schema is a `Type.Union` of
 *   per-action variants (one `Type.Object` with an `action` literal each).
 *   The factory derives the union schema from the declared variants, so the
 *   exposed JSON schema is identical to the previous hand-written
 *   `Type.Union([...])` as long as variants are declared in the same order.
 *   Args are coerced + validated against the matched variant before dispatch
 *   (`withValidatedArgs`), so per-action required fields come from the schema.
 *
 * - `defineFlatActionTool` — for tools that intentionally expose a single
 *   flat object schema with an `action` enum (kept flat for MCP clients and
 *   because the registry's per-action public/access filtering only applies
 *   to union variants — flattening a union here would change the exposed
 *   schema). The flat schema stays declared in the tool file; the factory
 *   only provides dispatch + required-field checks.
 *
 * Handler signature is `(args, ctx, env)` — `ctx` before `env` because most
 * handlers need the context but not the environment, and trailing unused
 * params can simply be omitted.
 */

import type { Static, TObject, TUnion } from '@sinclair/typebox';
import { Type } from '@sinclair/typebox';
import type { Env } from '../../index';
import type { ToolContext } from '../registry';
import { withValidatedArgs } from '../validate-args';
import { requireField, routeAction } from './action-router';

interface ActionDefinition<S extends TObject = TObject, R = unknown> {
  /** TypeBox variant for this action (must carry the `action` literal). */
  schema: S;
  handler: (args: Static<S>, ctx: ToolContext, env: Env) => Promise<R>;
}

/** Pair an action's TypeBox variant with its typed handler. */
export function action<S extends TObject, R>(
  schema: S,
  handler: (args: Static<S>, ctx: ToolContext, env: Env) => Promise<R>
): ActionDefinition<S, R> {
  return { schema, handler };
}

type AnyActions = Record<string, ActionDefinition<any, any>>;

type ArgsOf<T extends AnyActions> = Static<T[keyof T]['schema']>;
type ResultOf<T extends AnyActions> = Awaited<ReturnType<T[keyof T]['handler']>>;

function runActions<T extends AnyActions>(
  toolName: string,
  actions: T,
  args: ArgsOf<T>,
  env: Env,
  ctx: ToolContext
): Promise<ResultOf<T>> {
  const record = args as Record<string, unknown> & { action: string };
  const handlers: Record<string, () => Promise<ResultOf<T>>> = {};
  for (const [name, def] of Object.entries(actions)) {
    handlers[name] = () => def.handler(args, ctx, env);
  }
  return routeAction<ResultOf<T>>(toolName, record.action, ctx, handlers);
}

/**
 * Define a union-schema action tool. Returns the derived `Type.Union` input
 * schema (variants in declaration order) and the `(args, env, ctx)` runner
 * used as the registry handler. The runner coerces + validates args against
 * the matched action variant before dispatch (lobu#1137), so per-action
 * required fields are enforced by the schema, not `requires` lists.
 */
export function defineActionTool<T extends AnyActions>(
  toolName: string,
  actions: T,
  options?: { beforeValidate?: (args: unknown) => void }
): {
  schema: TUnion<Array<T[keyof T]['schema']>>;
  run: (args: ArgsOf<T>, env: Env, ctx: ToolContext) => Promise<ResultOf<T>>;
} {
  const schema = Type.Union(Object.values(actions).map((def) => def.schema)) as TUnion<
    Array<T[keyof T]['schema']>
  >;
  return {
    schema,
    run: withValidatedArgs(
      toolName,
      schema,
      (args: ArgsOf<T>, env: Env, ctx: ToolContext) => runActions(toolName, actions, args, env, ctx),
      options?.beforeValidate
    ),
  };
}

/**
 * Define a flat-schema action tool: the tool keeps its hand-written flat
 * object schema; the factory provides typed dispatch + required-field checks.
 * Actions missing from the map fail with `Unknown action: ...` (routeAction).
 */
export function defineFlatActionTool<TArgs extends { action: string }, R>(
  toolName: string,
  actions: {
    [A in TArgs['action']]?: {
      requires?: string[];
      handler: (args: TArgs, ctx: ToolContext, env: Env) => Promise<R>;
    };
  }
): (args: TArgs, env: Env, ctx: ToolContext) => Promise<R> {
  return (args, env, ctx) => {
    const record = args as Record<string, unknown> & { action: string };
    const handlers: Record<string, () => Promise<R>> = {};
    for (const [name, def] of Object.entries(actions) as Array<
      [string, { requires?: string[]; handler: (args: TArgs, ctx: ToolContext, env: Env) => Promise<R> }]
    >) {
      handlers[name] = () => {
        for (const field of def.requires ?? []) {
          requireField(record[field], field, name);
        }
        return def.handler(args, ctx, env);
      };
    }
    return routeAction<R>(toolName, args.action, ctx, handlers);
  };
}

/** Shorthand for a flat-tool action entry. */
export function flatAction<TArgs extends { action: string }, R>(
  handler: (args: TArgs, ctx: ToolContext, env: Env) => Promise<R>,
  options?: { requires?: string[] }
): { requires?: string[]; handler: (args: TArgs, ctx: ToolContext, env: Env) => Promise<R> } {
  return { handler, requires: options?.requires };
}
