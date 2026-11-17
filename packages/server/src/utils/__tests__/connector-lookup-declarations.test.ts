import { describe, expect, test } from 'vitest';
import { type ConnectorMetadata, validateConnectorMetadata } from '../connector-compiler';

const lookupInput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    values: { type: 'array', maxItems: 20, items: { type: 'string' } },
    query: { type: 'string', maxLength: 200 },
  },
};

const lookupOutput = {
  type: 'object',
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['value', 'label'],
        properties: {
          value: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          image_url: { type: 'string', format: 'uri' },
        },
      },
    },
  },
};

function lookupOperation(overrides: Record<string, unknown> = {}) {
  return { key: 'find_people', kind: 'read', inputSchema: lookupInput, outputSchema: lookupOutput, ...overrides };
}

function metadataWith(field: Record<string, unknown>, actions: Record<string, unknown> = {}): ConnectorMetadata {
  return {
    key: 'lookup-probe',
    name: 'Lookup Probe',
    version: '1.0.0',
    authSchema: null,
    webhook: null,
    feeds: null,
    actions: {
      send: {
        key: 'send',
        kind: 'write',
        inputSchema: {
          type: 'object',
          required: ['to'],
          properties: { to: field, body: { type: 'string', 'x-multiline': true } },
        },
      },
      find_people: lookupOperation(),
      write_people: lookupOperation({ key: 'write_people', kind: 'write' }),
      ...actions,
    },
    automationEvents: null,
    optionsSchema: null,
  };
}

const validate = (metadata: ConnectorMetadata) => () => validateConnectorMetadata(metadata);

describe('connector x-lookup declarations', () => {
  test('accepts a string field whose lookup names a read operation of the lookup contract', () => {
    expect(validate(metadataWith({ type: 'string', 'x-lookup': { operation: 'find_people' } }))).not.toThrow();
  });

  test('finds a lookup nested under array items', () => {
    const field = { type: 'array', items: { type: 'string', 'x-lookup': { operation: 'missing' } } };
    expect(validate(metadataWith(field))).toThrow(
      "Connector 'lookup-probe' action 'send' inputSchema.properties.to.items: x-lookup operation 'missing' must be a kind: \"read\" operation of this connector."
    );
  });

  test('a property that is merely named x-lookup is not a declaration', () => {
    expect(validate(metadataWith({ type: 'object', properties: { 'x-lookup': { type: 'string' } } }))).not.toThrow();
  });

  test.each([
    ['a missing operation', { operation: 'nope' }, 'must be a kind: "read" operation'],
    ['a write operation', { operation: 'write_people' }, 'must be a kind: "read" operation'],
    ['an inherited property name', { operation: 'toString' }, 'must be a kind: "read" operation'],
    ['a non-string operation', { operation: 7 }, 'operation must be a non-empty string'],
    ['an empty operation', { operation: '' }, 'operation must be a non-empty string'],
    ['an extra key', { operation: 'find_people', label: 'name' }, 'must be an object with only `operation`'],
    ['a bare string', 'find_people', 'must be an object with only `operation`'],
  ])('rejects %s', (_case, lookup, message) => {
    expect(validate(metadataWith({ type: 'string', 'x-lookup': lookup }))).toThrow(message);
  });

  test('rejects a lookup on a non-string field', () => {
    expect(validate(metadataWith({ type: 'integer', 'x-lookup': { operation: 'find_people' } }))).toThrow(
      'x-lookup belongs on a string field'
    );
  });

  test.each([
    ['input without query', { inputSchema: { type: 'object', properties: { values: lookupInput.properties.values } } }, 'exactly `values` and `query`'],
    ['required values', { inputSchema: { ...lookupInput, required: ['values'] } }, 'must be optional'],
    ['unbounded values', { inputSchema: { ...lookupInput, properties: { ...lookupInput.properties, values: { type: 'array', items: { type: 'string' } } } } }, '`values` input must be an array of strings'],
    ['an over-long query', { inputSchema: { ...lookupInput, properties: { ...lookupInput.properties, query: { type: 'string', maxLength: 201 } } } }, '`query` input must be a string'],
    ['no output schema', { outputSchema: undefined }, 'output schema must be an object'],
    ['optional items', { outputSchema: { ...lookupOutput, required: [] } }, 'require an `items` array'],
    ['items without a label', { outputSchema: { ...lookupOutput, properties: { items: { ...lookupOutput.properties.items, items: { type: 'object', required: ['value'], properties: { value: { type: 'string' } } } } } } }, 'requiring string `value` and `label`'],
    ['a non-string image_url', { outputSchema: { ...lookupOutput, properties: { items: { ...lookupOutput.properties.items, items: { ...lookupOutput.properties.items.items, properties: { ...lookupOutput.properties.items.items.properties, image_url: { type: 'object' } } } } } } }, '`image_url` must be a string'],
  ])('rejects a read operation with %s', (_case, overrides, message) => {
    const metadata = metadataWith(
      { type: 'string', 'x-lookup': { operation: 'find_people' } },
      { find_people: lookupOperation(overrides) }
    );
    expect(validate(metadata)).toThrow(message);
  });
});
