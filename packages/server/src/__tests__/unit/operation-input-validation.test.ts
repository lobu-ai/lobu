import { describe, expect, test } from 'bun:test';
import { validateOperationInput } from '../../operations/input-validation';
import type { OperationDescriptor } from '../../operations/types';

function operation(inputSchema?: Record<string, unknown>): OperationDescriptor {
  return {
    connector_key: 'test',
    connector_name: 'Test',
    operation_key: 'send',
    name: 'Send',
    kind: 'write',
    backend: 'mcp_tool',
    ...(inputSchema ? { input_schema: inputSchema } : {}),
    output_schema: undefined,
    backend_config: {
      backend: 'mcp_tool',
      toolName: 'send',
      upstreamUrl: 'https://example.com/mcp',
    },
  };
}

describe('validateOperationInput', () => {
  test('validates remote tools declaring JSON Schema 2020-12', () => {
    const descriptor = operation({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    });

    expect(validateOperationInput(descriptor, { code: 'async () => []' })).toBeNull();
    expect(validateOperationInput(descriptor, {})).toBe(
      'missing required field: code; expected { code: string }'
    );
    const input = { code: 123 };
    expect(validateOperationInput(descriptor, input)).toBe('code: must be string');
    expect(input.code).toBe(123);
  });

  test('accepts the fragment form of the 2020-12 dialect URI', () => {
    const descriptor = operation({
      $schema: 'https://json-schema.org/draft/2020-12/schema#',
      type: 'object',
      properties: { code: { type: 'string' } },
    });

    expect(validateOperationInput(descriptor, { code: 'x' })).toBeNull();
    expect(validateOperationInput(descriptor, { code: 1 })).toBe('code: must be string');
  });

  test('enforces 2020-12 tuple keywords rather than stripping the dialect', () => {
    const descriptor = operation({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        values: {
          type: 'array',
          prefixItems: [{ type: 'string', format: 'email' }],
          items: false,
        },
      },
    });

    expect(validateOperationInput(descriptor, { values: ['person@example.com'] })).toBeNull();
    expect(validateOperationInput(descriptor, { values: ['invalid'] })).toContain('valid email');
    expect(validateOperationInput(descriptor, { values: ['person@example.com', 'extra'] })).not.toBeNull();
  });

  test('preserves draft-07 tuple validation for existing operations', () => {
    const descriptor = operation({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: [{ type: 'string' }],
          additionalItems: false,
        },
      },
    });

    expect(validateOperationInput(descriptor, { values: ['value'] })).toBeNull();
    expect(validateOperationInput(descriptor, { values: [123] })).not.toBeNull();
    expect(validateOperationInput(descriptor, { values: ['value', 'extra'] })).not.toBeNull();
  });

  test('accepts input matching the operation schema', () => {
    const error = validateOperationInput(
      operation({
        type: 'object',
        required: ['to'],
        properties: {
          to: { type: 'string', format: 'email' },
          count: { type: 'number', minimum: 1 },
        },
      }),
      { to: 'person@example.com', count: 1 }
    );

    expect(error).toBeNull();
  });

  test('rejects invalid input before execution is queued', () => {
    const error = validateOperationInput(
      operation({
        type: 'object',
        required: ['to'],
        properties: { to: { type: 'string' } },
      }),
      {}
    );

    expect(error).toBe('missing required field: to; expected { to: string }');
  });

  test('does not coerce caller input', () => {
    const input = { count: '1' };
    const error = validateOperationInput(
      operation({
        type: 'object',
        required: ['count'],
        properties: { count: { type: 'number' } },
      }),
      input
    );

    expect(error).toBe('count: must be number');
    expect(input.count).toBe('1');
  });

  describe('expected-shape hint', () => {
    const clickSchema = {
      type: 'object',
      required: ['tab_id', 'ref'],
      properties: {
        tab_id: { type: 'number' },
        ref: {
          type: 'object',
          required: ['backend_node_id'],
          properties: {
            backend_node_id: { type: 'integer' },
            frame_id: { type: 'string' },
            hints: { type: 'object', properties: { text: { type: 'string' } } },
          },
        },
        document_epoch: { type: 'number' },
        mode: { enum: ['click', 'hover'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
    };

    test('a missing nested field names its parent and the shape expected there', () => {
      expect(validateOperationInput(operation(clickSchema), { tab_id: 1, ref: {} })).toBe(
        "missing required field: ref/backend_node_id; expected ref: { backend_node_id: integer, frame_id?: string, hints?: { … } }"
      );
    });

    test('a missing top-level field shows the whole input shape, nested objects collapsed', () => {
      expect(validateOperationInput(operation(clickSchema), { ref: { backend_node_id: 1 } })).toBe(
        "missing required field: tab_id; expected { tab_id: number, ref: { … }, document_epoch?: number, mode?: \"click\" | \"hover\", tags?: string[] }"
      );
    });

    test('a structured field of the wrong type shows what belongs there', () => {
      expect(validateOperationInput(operation(clickSchema), { tab_id: 1, ref: 'button' })).toBe(
        "ref: must be object; expected ref: { backend_node_id: integer, frame_id?: string, hints?: { … } }"
      );
    });

    test('a scalar mismatch keeps its message, which already names the type', () => {
      expect(validateOperationInput(operation(clickSchema), { tab_id: '1', ref: { backend_node_id: 1 } })).toBe(
        'tab_id: must be number'
      );
    });

    test('array items and local $refs are followed to the failing element', () => {
      const descriptor = operation({
        type: 'object',
        $defs: {
          recipient: {
            type: 'object',
            required: ['email'],
            properties: { email: { type: 'string' }, name: { type: ['string', 'null'] } },
          },
        },
        properties: { to: { type: 'array', items: { $ref: '#/$defs/recipient' } } },
      });
      expect(validateOperationInput(descriptor, { to: [{ email: 'a@example.com' }, {}] })).toBe(
        'missing required field: to/1/email; expected to/1: { email: string, name?: string | null }'
      );
    });

    test('the hint stays bounded for very wide schemas', () => {
      const properties = Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [`a_rather_long_property_name_${index}`, { type: 'string' }])
      );
      const error = validateOperationInput(
        operation({ type: 'object', required: ['missing_one'], properties }),
        {}
      );
      expect(error).toStartWith('missing required field: missing_one; expected { a_rather_long_property_name_0?: string');
      expect(error!.length).toBeLessThanOrEqual('missing required field: missing_one; expected '.length + 300);
      expect(error).toEndWith('… }');
    });

    test('constraint-only union branches keep the object shape instead of rendering any', () => {
      const descriptor = operation({
        type: 'object',
        required: ['body'],
        properties: {
          body: { type: 'string' },
          post_url: { type: 'string' },
          post_urn: { type: 'string' },
        },
        anyOf: [{ required: ['post_url'] }, { required: ['post_urn'] }],
      });
      expect(validateOperationInput(descriptor, { post_url: 'https://example.com/p/1' })).toBe(
        'missing required field: body; expected { body: string, post_url?: string, post_urn?: string }'
      );
    });

    test('a union of typed branches drops untyped ones', () => {
      const descriptor = operation({
        type: 'object',
        properties: {
          target: {
            anyOf: [
              { type: 'object', required: ['id'], properties: { id: { type: 'number' } } },
              { not: { type: 'string' } },
            ],
          },
        },
      });
      expect(validateOperationInput(descriptor, { target: 'x' })).toBe(
        'target: must be object; expected target: { id: number }'
      );
    });

    test('recursive array and union schemas preserve the input validation error', () => {
      for (const value of [
        { type: 'array', items: { $ref: '#/properties/value' } },
        { anyOf: [{ type: 'string' }, { $ref: '#/properties/value' }] },
      ]) {
        const descriptor = operation({
          type: 'object',
          required: ['value'],
          properties: { value },
        });
        const error = validateOperationInput(descriptor, {});
        expect(error).toStartWith('missing required field: value; expected ');
        expect(error!.length).toBeLessThan(350);
      }
    });
  });
});
