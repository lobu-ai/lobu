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
    expect(validateOperationInput(descriptor, {})).toBe('missing required field: code');
    const input = { code: 123 };
    expect(validateOperationInput(descriptor, input)).toBe('code: must be string');
    expect(input.code).toBe(123);
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

    expect(error).toBe('missing required field: to');
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
});
