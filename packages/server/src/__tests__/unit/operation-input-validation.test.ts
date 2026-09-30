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
