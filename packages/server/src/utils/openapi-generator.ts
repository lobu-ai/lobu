/**
 * OpenAPI Spec Generator
 *
 * Dynamically generates OpenAPI specification from tool registry TypeBox schemas
 */

import { AGENT_TOOL_NAMES, getMcpTools, getRawDispatchTools } from '../tools/registry';
import { deepCopyStrict } from './schema-copy';

/**
 * Recursively deep copies schema properties while filtering out hidden ones
 * Preserves all JSON Schema fields (patternProperties, additionalProperties, anyOf, etc.)
 */
function deepCopySchema(schema: any): any {
  if (schema === null || schema === undefined) {
    return schema;
  }

  // Handle arrays (for anyOf, oneOf, allOf, etc.)
  if (Array.isArray(schema)) {
    return schema.map(deepCopySchema);
  }

  // Handle primitives
  if (typeof schema !== 'object') {
    return schema;
  }

  // Deep copy object, preserving all fields
  const copied: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    // Skip internal TypeBox fields that shouldn't be in OpenAPI
    if (key === '$id' || key === 'static') {
      continue;
    }

    // Recursively copy the value
    copied[key] = deepCopySchema(value);
  }

  return copied;
}

/**
 * Filters out hidden properties (marked with x-hidden: true) from schema
 */
function filterHiddenProperties(properties: Record<string, any>): Record<string, any> {
  const filtered: Record<string, any> = {};
  for (const [key, prop] of Object.entries(properties)) {
    if (!prop['x-hidden']) {
      // Deep copy each property to preserve all schema fields
      filtered[key] = deepCopySchema(prop);
    }
  }
  return filtered;
}

/**
 * Normalizes schema for ChatGPT compatibility
 * - Removes patternProperties (ChatGPT's OpenAPI validator doesn't support it)
 * - Converts objects with patternProperties to use additionalProperties: {} instead
 * - Recursively processes nested schemas
 */
function normalizeSchemaForChatGPT(properties: Record<string, any>): Record<string, any> {
  const normalized: Record<string, any> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const normalizedProp = { ...prop };

    // ChatGPT's OpenAPI validator doesn't support patternProperties
    // Convert objects with patternProperties to use additionalProperties instead
    if (normalizedProp.type === 'object' && normalizedProp.patternProperties) {
      // Remove patternProperties (not supported by ChatGPT)
      delete normalizedProp.patternProperties;

      // Set additionalProperties to allow any object structure
      // Using {} instead of true to indicate any type is allowed
      normalizedProp.additionalProperties = {};
    }

    // Recursively normalize nested properties
    if (normalizedProp.properties) {
      normalizedProp.properties = normalizeSchemaForChatGPT(normalizedProp.properties);
    }

    // Recursively normalize items in arrays
    if (normalizedProp.items && typeof normalizedProp.items === 'object') {
      if (normalizedProp.items.properties) {
        normalizedProp.items.properties = normalizeSchemaForChatGPT(
          normalizedProp.items.properties
        );
      }
    }

    // Recursively normalize anyOf/oneOf/allOf
    for (const combiner of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(normalizedProp[combiner])) {
        normalizedProp[combiner] = normalizedProp[combiner].map((subSchema: any) => {
          if (subSchema.properties) {
            return {
              ...subSchema,
              properties: normalizeSchemaForChatGPT(subSchema.properties),
            };
          }
          return subSchema;
        });
      }
    }

    normalized[key] = normalizedProp;
  }

  return normalized;
}

/**
 * Converts TypeBox/JSON Schema to OpenAPI request body format
 */
function schemaToRequestBody(schema: any): any {
  const filteredProperties = schema.properties ? filterHiddenProperties(schema.properties) : {};

  // Normalize for ChatGPT compatibility (add additionalProperties: true for patternProperties)
  const normalizedProperties = normalizeSchemaForChatGPT(filteredProperties);

  // Filter required fields to only include non-hidden properties
  const filteredRequired = (schema.required || []).filter(
    (key: string) => !schema.properties?.[key]?.['x-hidden']
  );

  return {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: schema.type || 'object',
          properties: normalizedProperties,
          required: filteredRequired,
          // Allow additional properties for ChatGPT compatibility
          // ChatGPT's strict validation would otherwise reject nested object properties
          additionalProperties: true,
        },
      },
    },
  };
}

/**
 * Truncates text to max length, ending at last complete sentence
 */
function truncateDescription(text: string, maxLength: number = 300): string {
  if (text.length <= maxLength) return text;

  // Try to truncate at last sentence within limit
  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');

  if (lastPeriod > 0) {
    return truncated.substring(0, lastPeriod + 1);
  }

  // Fallback: truncate at space
  const lastSpace = truncated.lastIndexOf(' ');
  return `${truncated.substring(0, lastSpace > 0 ? lastSpace : maxLength - 3)}...`;
}

/**
 * Generates OpenAPI 3.1.0 spec from tool registry
 */
export function generateOpenAPISpec(serverUrl: string) {
  // `getMcpTools()` also lists the MCP-only presentation tools. Those exist to
  // give an MCP host a `ui://` bundle to render; a REST/OpenAPI consumer has
  // nothing to render them with, so the spec stays the agent data surface.
  const tools = getMcpTools().filter((tool) => AGENT_TOOL_NAMES.has(tool.name));
  const paths: Record<string, any> = {};

  for (const tool of tools) {
    const method = 'post';
    const path = `/api/{orgSlug}/${tool.name}`;

    if (!paths[path]) {
      paths[path] = {};
    }

    // Truncate description to 300 chars max for ChatGPT compatibility
    const truncatedDesc = truncateDescription(tool.description, 300);

    const operation: any = {
      summary: tool.description.split('.')[0], // First sentence as summary
      description: truncatedDesc,
      operationId: tool.name,
      parameters: [
        {
          name: 'orgSlug',
          in: 'path',
          required: true,
          description: 'Organization slug (workspace identifier)',
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': {
          description: 'Successful response',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {},
                additionalProperties: true,
              },
            },
          },
        },
        '400': {
          description: 'Bad request - invalid parameters',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden - your role or token scope does not allow this action',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                },
              },
            },
          },
        },
        '404': {
          description: 'Tool not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string' },
                },
              },
            },
          },
        },
      },
    };

    // Add request body or parameters based on method
    if (method === 'post') {
      operation.requestBody = schemaToRequestBody(tool.inputSchema);
    }

    paths[path][method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Lobu API',
      description:
        'API for building searchable workspace knowledge from customer content across multiple platforms',
      version: '1.0.0',
    },
    servers: [
      {
        url: serverUrl,
        description: 'Manage workspace knowledge and Automations',
      },
    ],
    paths,
  };
}

// ============================================
// Strict projection (typed first-party client)
// ============================================
//
// The ChatGPT projection above is deliberately lossy: it flattens discriminated
// unions, forces `additionalProperties: true`, and drops output schemas — all to
// satisfy ChatGPT's OpenAPI validator. The generated first-party `@lobu/client`
// has no such constraints, so it is generated from THIS projection, which keeps
// each tool's TypeBox schema verbatim (discriminated unions intact) and emits the
// real `outputSchema` as the 200 response. TypeBox serializes to JSON Schema
// 2020-12, which IS the OpenAPI 3.1 schema dialect, so the schemas drop in with
// no conversion. One TypeBox source, two projections — no hand-maintained spec.

const ERROR_RESPONSE = {
  content: {
    'application/json': {
      schema: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
} as const;

/**
 * OpenAPI `paths` for the whole dispatch-tool surface (`POST /api/{orgSlug}/{tool}`),
 * with faithful TypeBox input/output schemas. Merged into the gateway document so the
 * generated client covers domain data (entities, automations, feeds, metrics, …) — not
 * only agent-session orchestration.
 */
export function generateStrictToolPaths(): Record<string, any> {
  const paths: Record<string, any> = {};

  for (const tool of getRawDispatchTools()) {
    const path = `/api/{orgSlug}/${tool.name}`;
    const responseSchema = tool.outputSchema
      ? deepCopyStrict(tool.outputSchema)
      : { type: 'object', additionalProperties: true };

    paths[path] = {
      post: {
        summary: tool.description.split('.')[0],
        description: truncateDescription(tool.description, 300),
        operationId: tool.name,
        ...(tool.internal && { 'x-internal': true }),
        parameters: [
          {
            name: 'orgSlug',
            in: 'path',
            required: true,
            description: 'Organization slug (workspace identifier)',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: deepCopyStrict(tool.inputSchema) } },
        },
        responses: {
          '200': {
            description: 'Successful response',
            content: { 'application/json': { schema: responseSchema } },
          },
          '400': { description: 'Bad request - invalid parameters', ...ERROR_RESPONSE },
          '403': {
            description: 'Forbidden - your role or token scope does not allow this action',
            ...ERROR_RESPONSE,
          },
          '404': { description: 'Tool not found', ...ERROR_RESPONSE },
        },
      },
    };
  }

  return paths;
}
