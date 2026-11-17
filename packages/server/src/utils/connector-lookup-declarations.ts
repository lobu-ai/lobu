type UnknownRecord = Record<string, unknown>;

interface ConnectorLookupMetadata {
  key: string;
  actions: UnknownRecord | null;
}

/** The most values one lookup resolves and the most items it returns. */
const LOOKUP_MAX_ITEMS = 20;
const LOOKUP_MAX_QUERY_LENGTH = 200;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function inputSchemaOf(action: UnknownRecord): UnknownRecord | null {
  return record(action.inputSchema ?? action.input_schema);
}

function outputSchemaOf(action: UnknownRecord): UnknownRecord | null {
  return record(action.outputSchema ?? action.output_schema);
}

function isBoundedNumber(value: unknown, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function isStringSchema(value: unknown): boolean {
  return record(value)?.type === 'string';
}

function requiredOf(schema: UnknownRecord): unknown[] {
  return Array.isArray(schema.required) ? schema.required : [];
}

/**
 * The lookup operation's input: `{ values?: string[] (≤20), query?: string (≤200) }`,
 * both declared and optional, nothing else.
 */
function lookupInputProblem(schema: UnknownRecord | null): string | null {
  if (!schema || schema.type !== 'object') return 'its input schema must be an object';
  const properties = record(schema.properties) ?? {};
  const names = Object.keys(properties).sort();
  if (names.join(',') !== 'query,values') {
    return 'its input must declare exactly `values` and `query`';
  }
  if (requiredOf(schema).length > 0) return 'its `values` and `query` inputs must be optional';
  const values = record(properties.values);
  if (
    values?.type !== 'array' ||
    !isStringSchema(values.items) ||
    !isBoundedNumber(values.maxItems, LOOKUP_MAX_ITEMS)
  ) {
    return `its \`values\` input must be an array of strings with maxItems at most ${LOOKUP_MAX_ITEMS}`;
  }
  const query = record(properties.query);
  if (query?.type !== 'string' || !isBoundedNumber(query.maxLength, LOOKUP_MAX_QUERY_LENGTH)) {
    return `its \`query\` input must be a string with maxLength at most ${LOOKUP_MAX_QUERY_LENGTH}`;
  }
  return null;
}

/**
 * The lookup operation's output:
 * `{ items: [{ value: string, label: string, description?: string, image_url?: string }] }`
 * with at most 20 items.
 */
function lookupOutputProblem(schema: UnknownRecord | null): string | null {
  if (!schema || schema.type !== 'object') return 'its output schema must be an object';
  const items = record(record(schema.properties)?.items);
  if (
    !requiredOf(schema).includes('items') ||
    items?.type !== 'array' ||
    !isBoundedNumber(items.maxItems, LOOKUP_MAX_ITEMS)
  ) {
    return `its output must require an \`items\` array with maxItems at most ${LOOKUP_MAX_ITEMS}`;
  }
  const item = record(items.items);
  const fields = record(item?.properties) ?? {};
  const required = item ? requiredOf(item) : [];
  if (
    item?.type !== 'object' ||
    !isStringSchema(fields.value) ||
    !isStringSchema(fields.label) ||
    !required.includes('value') ||
    !required.includes('label')
  ) {
    return 'each output item must be an object requiring string `value` and `label`';
  }
  for (const optional of ['description', 'image_url']) {
    if (fields[optional] !== undefined && !isStringSchema(fields[optional])) {
      return `an output item's \`${optional}\` must be a string`;
    }
  }
  return null;
}

/** Keywords whose object value maps names (not keywords) to subschemas. */
const SCHEMA_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

/** Every `x-lookup` in a schema tree, with the path that carries it. */
function collectLookups(
  schema: unknown,
  path: string,
  found: Array<{ path: string; schema: UnknownRecord; lookup: unknown }>
): void {
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => collectLookups(entry, `${path}[${index}]`, found));
    return;
  }
  const node = record(schema);
  if (!node) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'x-lookup') {
      found.push({ path, schema: node, lookup: value });
    } else if (SCHEMA_MAPS.has(key)) {
      for (const [name, subschema] of Object.entries(record(value) ?? {})) {
        collectLookups(subschema, `${path}.${key}.${name}`, found);
      }
    } else {
      collectLookups(value, `${path}.${key}`, found);
    }
  }
}

/**
 * Reject an action input field whose `x-lookup` does not name a read operation
 * of the same connector that takes and returns the lookup contract. The form
 * runs that operation to show the field's value as the record it points to.
 */
export function validateConnectorLookupDeclarations(metadata: ConnectorLookupMetadata): void {
  const actions = metadata.actions;
  if (!actions) return;
  for (const [actionKey, actionValue] of Object.entries(actions)) {
    const action = record(actionValue);
    if (!action) continue;
    const found: Array<{ path: string; schema: UnknownRecord; lookup: unknown }> = [];
    collectLookups(inputSchemaOf(action), 'inputSchema', found);
    for (const { path, schema, lookup } of found) {
      const label = `Connector '${metadata.key}' action '${actionKey}' ${path}`;
      const declaration = record(lookup);
      if (!declaration || Object.keys(declaration).some((key) => key !== 'operation')) {
        throw new Error(`${label}: x-lookup must be an object with only \`operation\`.`);
      }
      const operation = declaration.operation;
      if (typeof operation !== 'string' || operation.length === 0) {
        throw new Error(`${label}: x-lookup operation must be a non-empty string.`);
      }
      if (schema.type !== 'string') {
        throw new Error(`${label}: x-lookup belongs on a string field.`);
      }
      const target = Object.hasOwn(actions, operation) ? record(actions[operation]) : null;
      if (!target || target.kind !== 'read') {
        throw new Error(
          `${label}: x-lookup operation '${operation}' must be a kind: "read" operation of this connector.`
        );
      }
      const problem =
        lookupInputProblem(inputSchemaOf(target)) ?? lookupOutputProblem(outputSchemaOf(target));
      if (problem) {
        throw new Error(`${label}: x-lookup operation '${operation}' does not fit the lookup contract: ${problem}.`);
      }
    }
  }
}
