/**
 * Shared vocabulary for the `json_template` render DSL.
 *
 * Entity/list templates and historical event templates share this vocabulary
 * across web and MCP rendering. Their bound values use the same formatting
 * directives rather than reimplementing scalar formatting per renderer.
 * Chat summaries and native decisions do not interpret this DSL.
 *
 * Structural node shapes stay with each renderer: the node vocabulary is
 * deliberately open (see the server's `validate-json-template`), and each
 * surface resolves components against its own registry.
 */

/**
 * Display-format directives a `data` binding (or a table column) can request.
 * Domain-agnostic on purpose — this knows how to format a currency/date/enum,
 * never which field is one; that comes from the JSON-Schema annotation resolved
 * by whoever authors the binding.
 */
export type ValueFormat =
  | "currency"
  | "date"
  | "url"
  | "enum"
  | "boolean"
  | "number"
  | "auto"
  | "text";

/** Every directive `formatValue` understands, for validating authored templates. */
export const VALUE_FORMATS: ReadonlySet<ValueFormat> = new Set<ValueFormat>([
  "currency",
  "date",
  "url",
  "enum",
  "boolean",
  "number",
  "auto",
  "text",
]);

export function isValueFormat(value: unknown): value is ValueFormat {
  return typeof value === "string" && VALUE_FORMATS.has(value as ValueFormat);
}

const DATE_STRING =
  /^\d{4}-\d{2}-\d{2}(?:[tT ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function looksLikeDateString(value: string): boolean {
  return DATE_STRING.test(value);
}

export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** `pull_request_opened` → `Pull Request Opened`. */
export function titleCaseWords(value: string): string {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: value >= 1000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000_000_000 ? 1 : 0,
  }).format(value);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Compact `host/path` label for a URL; the caller decides link-ness. */
export function formatUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, "");
    const path =
      url.pathname && url.pathname !== "/"
        ? url.pathname.replace(/\/$/, "")
        : "";
    return `${host}${path}`;
  } catch {
    return value;
  }
}

function formatStructuredValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(formatValue(value));
  }
  if (Array.isArray(value)) {
    if (!value.some((item) => typeof item === "object" && item !== null)) {
      return JSON.stringify(value);
    }
    return value
      .map((item, index) => `${index + 1}. ${formatStructuredValue(item)}`)
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entryValue]) =>
        entryValue !== null && entryValue !== undefined && entryValue !== ""
    );
    return entries
      .map(
        ([key, entryValue]) =>
          `${titleCaseWords(key)}: ${formatStructuredValue(entryValue)}`
      )
      .join("; ");
  }
  return JSON.stringify(value);
}

/**
 * Format one bound value per an explicit directive.
 *
 * `format` omitted or `"text"` keeps scalar strings and numbers raw. `"auto"`
 * opts into shape inference (dates/urls, never currency), while specific formats
 * force that treatment. Booleans always render Yes/No; objects and object arrays
 * use compact line-item text, and primitive arrays stay in JSON form.
 */
export function formatValue(value: unknown, format?: ValueFormat): string {
  if (value === null || value === undefined) return "";

  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (typeof value === "number") {
    if (format === "currency") return formatCurrency(value);
    if (format === undefined || format === "text") return String(value);
    return formatNumber(value);
  }

  if (typeof value !== "string") return formatStructuredValue(value);

  switch (format) {
    case "currency":
      return formatCurrency(Number(value));
    case "date":
      return formatDate(value);
    case "url":
      return formatUrlLabel(value);
    case "enum":
      return titleCaseWords(value);
    case "number":
      return formatNumber(Number(value));
    case "auto": {
      // Infer date/url from the value's shape, but never currency.
      if (isHttpUrl(value)) return formatUrlLabel(value);
      if (looksLikeDateString(value)) return formatDate(value);
      return value;
    }
    default:
      // undefined | "text" → raw passthrough (no silent reformatting).
      return value;
  }
}

/** A json_template node. Open by design — `type` is extended app-side. */
export type TemplateNode = Record<string, unknown>;

/**
 * The node types the DSL itself defines. Everything else is a component, whose
 * vocabulary is extended app-side and deliberately NOT allowlisted.
 *
 * Shared so the validator and the renderers cannot disagree about which types
 * are structural. They do NOT share a traversal, and shouldn't: validation must
 * be strict (a malformed node is an authoring error worth failing on) while
 * rendering must be lenient (a half-valid template should still show what it
 * can). Same grammar, opposite failure modes.
 */
export const STRUCTURAL_NODE_TYPES = ["text", "data", "if", "each"] as const;
export type StructuralNodeType = (typeof STRUCTURAL_NODE_TYPES)[number];

/**
 * Resolve a `data` path against the render scope.
 *
 * Byte-for-byte the rule owletto's renderer uses (`renderer.tsx:434`), so a
 * path resolves identically on every surface: bracket indices are rewritten to
 * dots, then walked, short-circuiting to `undefined` on the first nullish hop.
 */
export function getValueByPath(
  obj: Record<string, unknown>,
  path: string
): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Keys the node shape itself owns, so they are never treated as props. Matches
 * owletto's renderer exactly (`renderer.tsx`), which is what lets a template
 * use the flat DSL (`{"type":"metric","label":"…"}`) as well as an explicit
 * `props` bag — the bag wins on conflict.
 */
const RESERVED_KEYS = new Set([
  "type",
  "children",
  "props",
  "path",
  "fallback",
  "key",
]);

/** Resolve one prop value: `{{path}}` binding, `{{a}}/b` interpolation, or literal. */
function resolveBinding(
  value: unknown,
  data: Record<string, unknown>
): unknown {
  if (typeof value !== "string") return value;
  if (value.startsWith("{{") && value.endsWith("}}")) {
    const inner = value.slice(2, -2);
    // A second `}}` inside means this is interpolation (`{{a}}/{{b}}`), not a
    // single binding, so fall through to the replace below.
    if (!inner.includes("}}")) return getValueByPath(data, inner.trim());
  }
  if (value.includes("{{")) {
    return value.replace(/\{\{(.+?)\}\}/g, (_, path: string) => {
      const resolved = getValueByPath(data, path.trim());
      return resolved !== undefined ? String(resolved) : "";
    });
  }
  return value;
}

function resolveProps(
  node: TemplateNode,
  data: Record<string, unknown>
): { props: Record<string, unknown>; actions: Record<string, string> } {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!RESERVED_KEYS.has(key)) raw[key] = value;
  }
  if (
    node.props &&
    typeof node.props === "object" &&
    !Array.isArray(node.props)
  ) {
    Object.assign(raw, node.props as Record<string, unknown>);
  }

  const props: Record<string, unknown> = {};
  const actions: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    // Keep action names separate from a renderer's JavaScript handlers.
    if (
      typeof value === "string" &&
      value.startsWith("@") &&
      value.length > 1
    ) {
      actions[key] = value.slice(1);
      continue;
    }
    props[key] = resolveBinding(value, data);
  }
  return { props, actions };
}

/**
 * What a surface must supply to render a template. `walkTemplate` owns every
 * structural decision — path resolution, `if` truthiness, `each` scoping and
 * the string-shorthand — so a visitor only decides how a leaf or a component
 * BECOMES its output type. That split is the point: adding a surface must not
 * mean re-deriving the DSL's semantics.
 */
export interface TemplateVisitor<T> {
  /** A literal `text` node. */
  text(content: string): T[];
  /** A resolved `data` node, already formatted. */
  value(rendered: string, raw: unknown): T[];
  /**
   * Any non-structural node. `type` is open — a visitor that cannot render one
   * should say so rather than guess; see `walkTemplate`'s `unsupported`.
   *
   * `props` arrive RESOLVED: `{{path}}` yields the bound value with its type
   * intact, `"a/{{b}}"` interpolates to a string. Handler props (`onClick` and
   * friends) are split into `actions` as bare action names so each renderer
   * can bind its own handlers.
   */
  component(
    type: string,
    props: Record<string, unknown>,
    children: T[],
    ctx: { actions: Record<string, string>; node: TemplateNode }
  ): T[] | null;
}

/**
 * One event a template action is allowed to append. The action name is the
 * registry key; the template references it as `@name` and never names a tool
 * or executable handler.
 */
export interface TemplateInteractionDefinition {
  emits: string;
}

export type TemplateInteractionRegistry = Record<
  string,
  TemplateInteractionDefinition
>;

/** The presentation-neutral result of a user activating a rendered control. */
export interface TemplateActionInvocation {
  action: string;
  value: string | null;
}

export function templateInteractionValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return null;
}

/** Convert a declarative `@action` handler and resolved control value to the shared wire shape. */
export function templateActionInvocation(
  handler: unknown,
  value: unknown
): TemplateActionInvocation | null {
  if (
    typeof handler !== "string" ||
    !handler.startsWith("@") ||
    handler.length === 1
  ) {
    return null;
  }
  return { action: handler.slice(1), value: templateInteractionValue(value) };
}

/**
 * Resolve every action/value pair a rendered template actually exposes.
 *
 * This deliberately walks the same conditionals, loops, bindings, and handler
 * syntax as every renderer. Server-side invocation validation can therefore
 * reject a forged value without maintaining a second JSON-template parser.
 */
export function collectTemplateActionInvocations(
  node: unknown,
  data: Record<string, unknown>
): TemplateActionInvocation[] {
  const invocations: TemplateActionInvocation[] = [];
  const seen = new Set<string>();
  const add = (action: string, value: string | null) => {
    const key = JSON.stringify([action, value]);
    if (seen.has(key)) return;
    seen.add(key);
    invocations.push({ action, value });
  };

  walkTemplate(node, data, {
    text: () => [],
    value: () => [],
    component: (type, props, _children, { actions }) => {
      const names =
        type === "button"
          ? [actions.onClick ?? actions.onPress ?? actions.onSubmit].filter(
              (name): name is string => Boolean(name)
            )
          : type === "select"
            ? [actions.onChange ?? actions.onSelect].filter(
                (name): name is string => Boolean(name)
              )
            : [];
      if (type === "select" && Array.isArray(props.options)) {
        for (const option of props.options) {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            continue;
          }
          const record = option as Record<string, unknown>;
          const value = templateInteractionValue(record.value ?? record.label);
          if (value === null) continue;
          for (const action of names) add(action, value);
        }
        return [];
      }
      const value = templateInteractionValue(props.value);
      for (const action of names) add(action, value);
      return [];
    },
  });
  return invocations;
}

/**
 * Walk a template against `data`, emitting whatever the visitor builds.
 *
 * `unsupported` collects the component types the visitor refused — signalled by
 * returning `null`, NOT by returning nothing. The distinction matters: a
 * visitor that knowingly drops a node (a control it cannot wire up, a wrapper
 * with no content) has handled it, and reporting that as unrenderable would
 * misname the problem to the reader.
 */
export function walkTemplate<T>(
  node: unknown,
  data: Record<string, unknown>,
  visitor: TemplateVisitor<T>,
  unsupported?: Set<string>
): T[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  const n = node as TemplateNode;
  const type = typeof n.type === "string" ? n.type : "";

  if (type === "text") {
    return typeof n.content === "string" ? visitor.text(n.content) : [];
  }

  if (type === "data") {
    const path = typeof n.path === "string" ? n.path : "";
    const raw = path ? getValueByPath(data, path) : undefined;
    if (raw === undefined || raw === null || raw === "") {
      const fallback = typeof n.fallback === "string" ? n.fallback : "";
      return fallback ? visitor.value(fallback, raw) : [];
    }
    const format = isValueFormat(n.format) ? n.format : undefined;
    return visitor.value(formatValue(raw, format), raw);
  }

  if (type === "if") {
    const condition = typeof n.condition === "string" ? n.condition : "";
    const branch =
      condition && getValueByPath(data, condition) ? n.then : n.else;
    return branch === undefined
      ? []
      : walkTemplate(branch, data, visitor, unsupported);
  }

  if (type === "each") {
    const itemsPath = typeof n.items === "string" ? n.items : "";
    const items = itemsPath ? getValueByPath(data, itemsPath) : undefined;
    if (!Array.isArray(items)) return [];
    const as = typeof n.as === "string" ? n.as : "";
    return items.flatMap((item, index) => {
      // String shorthand ("- {{t}}"), matching owletto's renderer: the loop
      // variable is substituted textually and the result is a text leaf.
      if (typeof n.render === "string") {
        const value = typeof item === "string" ? item : JSON.stringify(item);
        return visitor.text(n.render.split(`{{${as}}}`).join(value));
      }
      const scope = { ...data, [as]: item, [`${as}Index`]: index };
      return walkTemplate(n.render, scope, visitor, unsupported);
    });
  }

  const { props, actions } = resolveProps(n, data);
  const children = Array.isArray(n.children)
    ? (n.children as unknown[]).flatMap((child) =>
        walkTemplate(child, data, visitor, unsupported)
      )
    : [];
  const emitted = visitor.component(type, props, children, {
    actions,
    node: n,
  });
  if (emitted === null) {
    if (type) unsupported?.add(type);
    return children;
  }
  return emitted;
}
