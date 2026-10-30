/**
 * A compact "what belongs here" rendering of an operation's `input_schema` at
 * the path a validation error points to, so a caller that sent the wrong shape
 * learns the right one from the error instead of rediscovering the schema.
 *
 * Generic over every connector's JSON Schema: it follows `properties`, array
 * `items` / `prefixItems` and local `$ref`s, renders one level of an object
 * (nested objects collapse to `{ … }`), and never exceeds
 * {@link SHAPE_HINT_MAX_CHARS}. Anything it cannot follow yields no hint
 * rather than a wrong one.
 */

const SHAPE_HINT_MAX_CHARS = 300;
const MAX_UNION_VALUES = 6;
const MAX_REF_HOPS = 8;

type SchemaNode = Record<string, unknown>;

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArrayIndex(segment: string): boolean {
  return segment !== '' && [...segment].every((char) => char >= '0' && char <= '9');
}

/** JSON Pointer segments (RFC 6901), as AJV reports `instancePath`. */
function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.split('~1').join('/').split('~0').join('~'));
}

/** Follow local `$ref`s (`#/...`) to the schema they name; null when unresolvable. */
function resolveNode(value: unknown, root: SchemaNode): SchemaNode | null {
  let node = value;
  for (let hop = 0; hop < MAX_REF_HOPS; hop++) {
    if (!isNode(node)) return null;
    const ref = node.$ref;
    if (typeof ref !== 'string') return node;
    if (ref !== '#' && !ref.startsWith('#/')) return null;
    let target: unknown = root;
    for (const segment of pointerSegments(ref.slice(1))) {
      if (!isNode(target) || !Object.hasOwn(target, segment)) return null;
      target = target[segment];
    }
    node = target;
  }
  return null;
}

/** The sub-schema governing `instancePath`, or null when the path leaves what the schema declares. */
function schemaAt(root: SchemaNode, instancePath: string): SchemaNode | null {
  let node = resolveNode(root, root);
  for (const segment of pointerSegments(instancePath)) {
    if (!node) return null;
    const properties = node.properties;
    if (isNode(properties) && Object.hasOwn(properties, segment)) {
      node = resolveNode(properties[segment], root);
      continue;
    }
    if (!isArrayIndex(segment)) return null;
    const index = Number(segment);
    const { prefixItems, items } = node;
    if (Array.isArray(prefixItems) && index < prefixItems.length) {
      node = resolveNode(prefixItems[index], root);
    } else if (Array.isArray(items)) {
      node = index < items.length ? resolveNode(items[index], root) : null;
    } else {
      node = resolveNode(items, root);
    }
  }
  return node;
}

function declaredTypes(node: SchemaNode): string[] {
  if (typeof node.type === 'string') return [node.type];
  if (Array.isArray(node.type)) return node.type.filter((type): type is string => typeof type === 'string');
  if (isNode(node.properties)) return ['object'];
  if (node.items !== undefined || node.prefixItems !== undefined) return ['array'];
  return [];
}

function alternatives(node: SchemaNode): unknown[] {
  if (Array.isArray(node.anyOf)) return node.anyOf;
  if (Array.isArray(node.oneOf)) return node.oneOf;
  return [];
}

/** True when the node describes an object or array, where a shape says more than the type name. */
function isStructured(node: SchemaNode, root: SchemaNode, ancestors = new Set<SchemaNode>()): boolean {
  if (declaredTypes(node).some((type) => type === 'object' || type === 'array')) return true;
  if (ancestors.has(node) || ancestors.size >= MAX_REF_HOPS) return false;
  const next = new Set(ancestors).add(node);
  return alternatives(node).some((option) => {
    const resolved = resolveNode(option, root);
    return resolved != null && isStructured(resolved, root, next);
  });
}

function renderObject(node: SchemaNode, root: SchemaNode, depth: number, ancestors: Set<SchemaNode>): string {
  const properties = node.properties;
  if (!isNode(properties) || Object.keys(properties).length === 0) return 'object';
  if (depth > 0) return '{ … }';
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  const entries: string[] = [];
  let length = 4; // "{ " + " }"
  for (const [key, value] of Object.entries(properties)) {
    const entry = `${key}${required.has(key) ? '' : '?'}: ${render(value, root, depth + 1, ancestors)}`;
    const added = entry.length + (entries.length > 0 ? 2 : 0);
    if (length + added > SHAPE_HINT_MAX_CHARS - 3) {
      entries.push('…');
      break;
    }
    entries.push(entry);
    length += added;
  }
  return `{ ${entries.join(', ')} }`;
}

function renderArray(node: SchemaNode, root: SchemaNode, depth: number, ancestors: Set<SchemaNode>): string {
  const items = node.items;
  if (!isNode(items)) return 'array';
  const element = render(items, root, depth, ancestors);
  return element.includes(' | ') ? `(${element})[]` : `${element}[]`;
}

function render(value: unknown, root: SchemaNode, depth: number, ancestors = new Set<SchemaNode>()): string {
  const node = resolveNode(value, root);
  if (!node) return 'any';
  // Resolving a ref is bounded separately: arrays and unions can re-enter it.
  if (ancestors.has(node) || ancestors.size >= MAX_REF_HOPS) return '…';
  const next = new Set(ancestors).add(node);
  if (Object.hasOwn(node, 'const')) return JSON.stringify(node.const) ?? 'any';
  if (Array.isArray(node.enum)) {
    const shown = node.enum.slice(0, MAX_UNION_VALUES).map((option) => JSON.stringify(option));
    return node.enum.length > MAX_UNION_VALUES ? `${shown.join(' | ')} | …` : shown.join(' | ');
  }
  const types = declaredTypes(node);
  if (types.length === 0) {
    // Only a node with no shape of its own is described by its branches; on a
    // typed node, anyOf/oneOf usually carries constraints (`required` sets)
    // that would render as `any`. Branches with no shape add nothing.
    const options = alternatives(node);
    const shown = options
      .slice(0, MAX_UNION_VALUES)
      .map((option) => render(option, root, depth, next))
      .filter((shape) => shape !== 'any');
    if (shown.length === 0) return 'any';
    return options.length > MAX_UNION_VALUES ? `${shown.join(' | ')} | …` : shown.join(' | ');
  }
  return types
    .map((type) =>
      type === 'object'
        ? renderObject(node, root, depth, next)
        : type === 'array'
          ? renderArray(node, root, depth, next)
          : type
    )
    .join(' | ');
}

/**
 * `expected <path>: <shape>` for the structured value at `instancePath`, or
 * null when the schema there is a scalar (the validation message already names
 * its type) or cannot be followed.
 */
export function expectedShapeHint(schema: SchemaNode, instancePath: string): string | null {
  const node = schemaAt(schema, instancePath);
  if (!node || !isStructured(node, schema)) return null;
  let shape = render(node, schema, 0);
  if (shape.length > SHAPE_HINT_MAX_CHARS) shape = `${shape.slice(0, SHAPE_HINT_MAX_CHARS - 1)}…`;
  const path = instancePath.startsWith('/') ? instancePath.slice(1) : instancePath;
  return path ? `expected ${path}: ${shape}` : `expected ${shape}`;
}
