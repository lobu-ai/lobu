/**
 * Single chokepoint for tool-arg validation (lobu#1137).
 *
 * Tool handlers are wrapped with `withValidatedArgs` at their definition
 * (`defineActionTool`) or export site, so every entry path — executeTool
 * (MCP + REST), direct REST handler calls, and the sandbox SDK namespaces —
 * runs the same coerce-then-validate pipeline. This is deliberately a leaf
 * module (typebox + errors only): the registry imports tool modules which
 * import the sandbox namespaces, so anything heavier here would close an
 * import cycle.
 *
 * Coercion before validation (`Value.Convert`) is load-bearing: the callers
 * of this boundary are LLMs and external MCP clients,
 * and the historical failure class was round-trip type drift (a list action
 * returns `automation_id` as a number, the update schema gates on Type.String —
 * see #1131). Coercing `123` → `"123"` and `"5"` → `5` makes that whole
 * class a non-issue instead of a per-tool audit.
 */

import type { TSchema } from '@sinclair/typebox';
import { FormatRegistry } from '@sinclair/typebox';
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler';
import { Value } from '@sinclair/typebox/value';
import { ToolUserError } from '../utils/errors';
import { stripNul } from '../utils/strip-nul';

// typebox's Value.Check FAILS (returns false) on any `format` constraint that
// isn't registered — there is no permissive default. Register every format
// used by a tool contract here so adding a schema annotation cannot make all
// otherwise-valid calls fail before their handler runs.
if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}
if (!FormatRegistry.Has('uri')) {
  // Same absolute-URI shape used by ajv-formats' fast validator. Individual
  // handlers still enforce narrower contracts such as HTTP(S)-only URLs.
  FormatRegistry.Set('uri', (value) =>
    /^(?:[a-z][a-z0-9+\-.]*:)(?:\/?\/)?[^\s]*$/i.test(value)
  );
}

interface SchemaWithVariants {
  anyOf?: Array<{ properties?: { action?: { const?: unknown } } }>;
}

/**
 * Schema-level annotation listing fields a tool ACCEPTS but does not ADVERTISE
 * (server-internal args populated from auth context or a server pre-compute).
 * Such fields stay valid input, but must not appear in the "valid arguments
 * are: …" list of an unknown-argument error — an error message is not a place
 * to publish an affordance the tool's advertised schema deliberately hides.
 */
const ACCEPTED_INTERNAL_FIELDS = 'x-lobu-accepted-internal-fields';

/**
 * Annotate `schema` with the args it accepts but does not advertise.
 *
 * The annotation is defined NON-ENUMERABLE on purpose. A TypeBox schema object
 * is routinely handed to `JSON.stringify` (tools/list payloads, ClientSDK
 * discovery metadata, snapshot fixtures), and an enumerable own property would
 * serialize straight into that JSON — publishing the very field names the
 * annotation exists to keep unpublished. `search_memory` happens to be safe
 * today because it declares a marker-free `publicInputSchema`, but the marker
 * must be inert-by-construction for the next tool that opts in without one.
 * `Object.keys` / spread / `{...schema}` skip it for the same reason; readers
 * go through `advertisedArgNames`, which reads the key directly.
 */
export function markAcceptedInternalFields(schema: TSchema, fields: readonly string[]): void {
  Object.defineProperty(schema, ACCEPTED_INTERNAL_FIELDS, {
    value: [...fields],
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/** Public argument names to name in error text: declared properties minus the
 * accepted-but-unadvertised ones. */
function advertisedArgNames(schema: TSchema): string[] {
  const { properties } = schema as { properties?: Record<string, unknown> };
  const internal = (schema as Record<string, unknown>)[ACCEPTED_INTERNAL_FIELDS];
  const hidden = new Set(Array.isArray(internal) ? internal.map(String) : []);
  return Object.keys(properties ?? {}).filter((key) => !hidden.has(key));
}

/**
 * For a `Type.Union` of per-action variants, validation must dispatch on the
 * `action` literal and check ONLY the matched variant: the schema advertised
 * to MCP clients is the FLATTENED union (registry `flattenUnionSchema`), so a
 * call that is valid against the advertised schema can carry fields from any
 * variant — naive full-union checking would reject it, and TypeBox's union
 * errors ("Expected union value") name no field anyway.
 */
function unionVariants(schema: TSchema): TSchema[] | null {
  const anyOf = (schema as SchemaWithVariants).anyOf;
  if (!Array.isArray(anyOf) || anyOf.length === 0) return null;
  if (!anyOf.every((v) => v.properties?.action?.const !== undefined)) return null;
  return anyOf as unknown as TSchema[];
}

function actionOf(variant: TSchema): string {
  return String(
    (variant as { properties?: { action?: { const?: unknown } } }).properties?.action?.const
  );
}

/**
 * Normalize in-process arg values to their wire (JSON) equivalents before
 * coercion. Wire callers can only send JSON, but direct callers (REST param
 * builders, sandbox namespaces, tests feeding a tool's output back into its
 * input) pass richer values that JSON.stringify would have flattened:
 *
 * - Keys with `undefined` values mean "absent" and are dropped —
 *   `Value.Convert` would wrap an explicitly-undefined Optional(Array) key
 *   into `[undefined]` and fail validation. Array ELEMENTS are not dropped;
 *   an `undefined` element is a genuine caller bug and must fail.
 * - `Date` instances become ISO strings — e.g. read_knowledge returns
 *   `occurred_at` as a Date and its own cursor inputs
 *   (`before_occurred_at`) are Type.String; the list→page round trip must
 *   survive validation.
 */
function normalizeArgs(value: unknown): unknown {
  // Postgres text columns and tsquery cannot contain NUL (0x00): a string
  // carrying one raises `invalid byte sequence for encoding "UTF8": 0x00`,
  // which would leak from any tool that passes the value into SQL (surfaced by
  // the tool-input fuzz against resolve_path). Strip it at the single tool-arg
  // chokepoint so no handler has to defend against it individually.
  if (typeof value === 'string') return stripNul(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeArgs);
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue;
        const key = stripNul(k);
        // `out[key] = …` invokes the `__proto__` accessor for a key named
        // `__proto__`, mutating the prototype instead of creating an own key —
        // so `Object.keys` never sees it and rejectUnknownKeys can't reject it
        // (prototype-pollution bypass). `defineProperty` always creates a
        // plain own data property, so a JSON `__proto__` key becomes a real
        // (unknown) argument that validation then rejects.
        Object.defineProperty(out, key, {
          value: normalizeArgs(v),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return out;
    }
  }
  return value;
}

const compiledCache = new Map<TSchema, TypeCheck<TSchema>>();

function compileSchema(schema: TSchema): TypeCheck<TSchema> {
  let compiled = compiledCache.get(schema);
  if (!compiled) {
    compiled = TypeCompiler.Compile(schema);
    compiledCache.set(schema, compiled);
  }
  return compiled;
}

/**
 * Return the allowed string literals of a subschema when it is a single
 * literal, an enum, or a union of literals — so an "Expected union value"
 * error (which names none) can be rewritten as `Expected one of: "a", "b"`.
 * Returns null for any other schema shape.
 */
function allowedLiterals(schema: unknown): string[] | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as {
    const?: unknown;
    enum?: unknown[];
    anyOf?: unknown[];
    oneOf?: unknown[];
  };
  if (Array.isArray(s.enum)) {
    return s.enum.map((v) => String(v));
  }
  if (s.const !== undefined) return [String(s.const)];
  const variants = s.anyOf ?? s.oneOf;
  if (Array.isArray(variants)) {
    const lits: string[] = [];
    for (const v of variants) {
      const inner = allowedLiterals(v);
      if (!inner) return null; // a non-literal member → not a pure literal union
      lits.push(...inner);
    }
    return lits.length > 0 ? lits : null;
  }
  return null;
}

/** An object union names no member in TypeBox's "Expected union value"; its
 *  own description (the accepted shapes) is the useful message. */
function unionDescription(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as { anyOf?: unknown[]; description?: unknown };
  return Array.isArray(s.anyOf) && typeof s.description === 'string'
    ? `Expected ${s.description}`
    : null;
}

/** Resolve the subschema at a TypeBox error `path` (e.g. `/list_scope`, `/kinds/0`). */
function subschemaAtPath(schema: TSchema, path: string): unknown {
  const segments = path.split('/').filter(Boolean);
  let current: unknown = schema;
  for (const seg of segments) {
    if (!current || typeof current !== 'object') return undefined;
    const node = current as { properties?: Record<string, unknown>; items?: unknown };
    // An array index (e.g. the `0` in `/kinds/0`) resolves to the array's item
    // schema — so a bad element in Array(Union(literals)) still gets the
    // humanized `Expected one of: ...` instead of "Expected union value".
    if (node.items !== undefined && /^\d+$/.test(seg)) {
      current = node.items;
      continue;
    }
    current = node.properties ? node.properties[seg] : undefined;
  }
  return current;
}

/**
 * Find top-level keys the schema does not declare, so they can be reported
 * ALONGSIDE any missing/typed-wrong fields (a caller who passes `{ id }` for a
 * `{ feed_id }` schema must learn both that `feed_id` is missing AND that `id`
 * is unknown — fixing one at a time is the failure the audit flagged).
 *
 * Returns `null` when the schema accepts arbitrary keys by design
 * (`additionalProperties` non-false, or no `properties`); empty array when all
 * keys are known. Object.hasOwn (not `key in`) so prototype-named keys
 * (`constructor`, `toString`) are correctly treated as unknown.
 */
function unknownKeys(schema: TSchema, coerced: unknown): string[] | null {
  const { properties, additionalProperties } = schema as {
    properties?: Record<string, unknown>;
    additionalProperties?: unknown;
  };
  if (!properties) return null;
  if (additionalProperties !== undefined && additionalProperties !== false) return null;
  if (!coerced || typeof coerced !== 'object' || Array.isArray(coerced)) return [];
  return Object.keys(coerced).filter((key) => !Object.hasOwn(properties, key));
}

function checkAgainst(toolName: string, schema: TSchema, args: unknown): unknown {
  // Convert returns a coerced copy — the handler must receive it, otherwise
  // coercion would satisfy the validator but the handler would still see the
  // raw value. Deliberately NO `Value.Default`: schema `default:` annotations
  // are client-facing documentation, and handlers apply their own defaults
  // via `??`. Materializing them here changes semantics — e.g. read_knowledge
  // declares `sort_by: { default: 'score' }` while its include_superseded
  // path requires sort_by to be UNSET; injecting the default broke it.
  const coerced = Value.Convert(schema, normalizeArgs(args));
  const validator = compileSchema(schema);
  const checkPassed = validator.Check(coerced);

  const unknown = unknownKeys(schema, coerced);
  const action = (
    (schema as { properties?: Record<string, { const?: unknown }> }).properties?.action
  )?.const;
  const scope = action !== undefined ? ` for action '${String(action)}'` : '';

  if (checkPassed) {
    if (unknown && unknown.length > 0) {
      const valid = advertisedArgNames(schema);
      throw new ToolUserError(
        `Invalid arguments for ${toolName}: unknown argument(s): ${unknown.join(', ')} — valid arguments${scope} are: ${valid.join(', ')}`
      );
    }
    return coerced;
  }

  // Deduplicate by path — TypeBox emits both `Expected required property` and
  // `Expected <type>` against the same missing field, which would otherwise
  // duplicate the field name in the error message. Humanize enum failures by
  // listing the allowed literals (TypeBox's "Expected union value" names none).
  const unknownSet = new Set(unknown ?? []);
  const seen = new Set<string>();
  const errs: string[] = [];
  for (const e of validator.Errors(coerced)) {
    const path = e.path || '/';
    if (seen.has(path)) continue;
    // Skip TypeBox's raw `Unexpected property` — the humanized "unknown
    // argument(s)" line below re-reports every unknown key at once with the
    // valid-argument set, so leaving the raw one in would double-list the key.
    const key = path.replace(/^\//, '');
    if (unknownSet.has(key)) continue;
    seen.add(path);
    const subschema = subschemaAtPath(schema, path);
    const literals = allowedLiterals(subschema);
    const message = literals
      ? `Expected one of: ${literals.map((l) => JSON.stringify(l)).join(', ')}`
      : (unionDescription(subschema) ?? e.message);
    errs.push(`${path}: ${message}`);
    if (errs.length >= 3) break;
  }

  // Report unknown keys in the SAME message as the type/required failures, so a
  // caller who supplied the wrong field name (dropping the required one) sees
  // both problems at once instead of fixing them serially.
  if (unknown && unknown.length > 0) {
    const valid = advertisedArgNames(schema);
    errs.push(
      `unknown argument(s): ${unknown.join(', ')} — valid arguments${scope} are: ${valid.join(', ')}`
    );
  }
  throw new ToolUserError(`Invalid arguments for ${toolName}: ${errs.join('; ')}`);
}

/**
 * Validate (and coerce) `args` against a tool's TypeBox input schema.
 * Returns the value the handler must receive. Throws `ToolUserError` (400)
 * naming the offending fields on mismatch.
 */
export function validateToolArgs(toolName: string, schema: TSchema, args: unknown): unknown {
  const variants = unionVariants(schema);
  if (variants) {
    const action =
      args && typeof args === 'object' ? (args as Record<string, unknown>).action : undefined;
    const variant = variants.find((v) => actionOf(v) === action);
    if (!variant) {
      const actions = variants.map(actionOf).join(', ');
      throw new ToolUserError(
        `Invalid arguments for ${toolName}: action must be one of: ${actions} (got ${JSON.stringify(action)})`
      );
    }
    return checkAgainst(toolName, variant, args);
  }
  return checkAgainst(toolName, schema, args);
}

/**
 * Validate (and coerce) a tool's RESULT against its TypeBox output schema,
 * for the `structuredContent` emission path (MCP spec: declaring `outputSchema`
 * means the client validates the returned structured result against it).
 *
 * Returns the coerced result to emit as `structuredContent`, or `null` when the
 * result cannot be made to satisfy the schema — the caller then falls back to
 * text-only so a schema/runtime drift degrades gracefully instead of turning a
 * successful tool call into a client-side validation error.
 *
 * The result is first JSON-normalized (`JSON.parse(JSON.stringify(...))`): this
 * is exactly the transform the transport applies before the client sees the
 * `structuredContent`, so we validate the shape the client will actually
 * receive — and it is load-bearing, because handler results are assembled from
 * raw SQL rows where a timestamp column is a `Date` (which `Value.Check` against
 * `Type.String()` REJECTS, but whose JSON form is the ISO string the schema
 * wants) and a `bigint` count needs its numeric form. A trailing `Value.Convert`
 * still catches the residual numeric-string drift.
 *
 * Unlike the input side there is no per-variant dispatch: result unions are not
 * uniformly `action`-keyed (e.g. manage_operations splits `execute` by `status`,
 * and has an `error`-only variant), and `Value.Check` against a `Type.Union`
 * already passes when ANY member matches — the exact semantics we want here.
 */
export function validateToolResult(schema: TSchema, result: unknown): unknown | null {
  const validator = compileSchema(schema);
  let normalized: unknown;
  try {
    // Mirror the wire transform: Dates → ISO strings, undefined keys dropped,
    // non-JSON values surfaced. A result that cannot be serialized cannot be
    // emitted as structuredContent anyway, so fall back to text-only.
    normalized = JSON.parse(JSON.stringify(result));
  } catch {
    return null;
  }
  const coerced = Value.Convert(schema, normalized);
  return validator.Check(coerced) ? coerced : null;
}

const VALIDATED_BRAND = Symbol.for('lobu.validated-tool-handler');
// Vitest's resetModules() and bundled tool graphs can instantiate this module
// more than once in one process. The validator metadata must survive that
// module boundary; the SDK preflight marker itself remains module-private.
const VALIDATE_ARGS = Symbol.for('lobu.validated-tool-args');

export type ArgsValidator = (args: unknown) => unknown;

export function getArgsValidator(handler: unknown): ArgsValidator | undefined {
  return typeof handler === 'function'
    ? (handler as unknown as Record<symbol, ArgsValidator | undefined>)[VALIDATE_ARGS]
    : undefined;
}

interface BrandedHandler {
  [VALIDATED_BRAND]?: string;
}

/**
 * Wrap a tool handler so its first argument is coerced + validated against
 * `schema` before the handler runs. Signature-preserving: remaining params
 * are forwarded untouched, so it fits both the registry `(args, env, ctx)`
 * shape and divergent ones like `listOrganizations`. Compiles eagerly — a
 * schema TypeCompiler can't handle must explode at module load, not silently
 * skip validation at call time.
 */
export function withValidatedArgs<A, R extends unknown[], T>(
  toolName: string,
  schema: TSchema,
  handler: (args: A, ...rest: R) => Promise<T>
): (args: A, ...rest: R) => Promise<T> {
  for (const s of unionVariants(schema) ?? [schema]) {
    compileSchema(s);
  }
  // `async` so a validation failure REJECTS the returned promise instead of
  // throwing synchronously — callers (`await`, `.rejects`, .catch chains)
  // treat tool handlers as promise-returning and a sync throw would escape
  // them.
  const wrapped = async (args: A, ...rest: R): Promise<T> =>
    handler(validateToolArgs(toolName, schema, args) as A, ...rest);
  Object.defineProperty(wrapped, VALIDATE_ARGS, {
    value: (args: unknown) => validateToolArgs(toolName, schema, args),
    enumerable: false,
  });
  (wrapped as BrandedHandler)[VALIDATED_BRAND] = toolName;
  return wrapped;
}
