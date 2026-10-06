/**
 * Google Discovery documents, read directly.
 *
 * Every Google REST API publishes a Discovery document: each method's HTTP
 * verb, path template, parameters, request/response schemas and the OAuth
 * scopes that may authorize it. The connectors pin a trimmed copy of each
 * document (see `scripts/pin-google-discovery.ts`) and compile actions and
 * feed requests from it, so URL building, parameter encoding and scope lists
 * come from Google's own description instead of being retyped per action.
 */
import { fileInputSchema, MAX_CONNECTOR_FILE_BYTES } from '@lobu/connector-sdk';

export interface DiscoverySchema {
  id?: string;
  type?: string;
  $ref?: string;
  description?: string;
  properties?: Record<string, DiscoverySchema>;
  items?: DiscoverySchema;
  additionalProperties?: DiscoverySchema;
  enum?: string[];
  format?: string;
  readOnly?: boolean;
  default?: string;
  required?: boolean;
  repeated?: boolean;
  location?: 'path' | 'query';
  minimum?: string;
  maximum?: string;
  deprecated?: boolean;
}

export interface DiscoveryMethod {
  id: string;
  path: string;
  httpMethod: string;
  description?: string;
  parameters?: Record<string, DiscoverySchema>;
  parameterOrder?: string[];
  request?: { $ref: string };
  response?: { $ref: string };
  scopes?: string[];
  supportsMediaDownload?: boolean;
  useMediaDownloadService?: boolean;
  supportsMediaUpload?: boolean;
  mediaUpload?: {
    accept?: string[];
    maxSize?: string;
    protocols?: { simple?: { multipart?: boolean; path: string } };
  };
  deprecated?: boolean;
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface DiscoveryDocument extends DiscoveryResource {
  name: string;
  version: string;
  title?: string;
  revision?: string;
  rootUrl: string;
  servicePath: string;
  batchPath?: string;
  auth?: { oauth2?: { scopes?: Record<string, { description?: string }> } };
  schemas?: Record<string, DiscoverySchema>;
}

export function discoveryMethods(doc: DiscoveryResource): DiscoveryMethod[] {
  const out = Object.values(doc.methods ?? {});
  for (const resource of Object.values(doc.resources ?? {})) {
    out.push(...discoveryMethods(resource));
  }
  return out;
}

/**
 * A method's own parameters. Discovery declares the transport plumbing every
 * method shares (`key`, `access_token`, `alt`, `fields`, …) once at document
 * level; the pin script drops it, so it never reaches an action's input. Of
 * those, only `fields` is a caller's choice, and `methodInputSchema` adds it.
 */
export function methodParameters(method: DiscoveryMethod): Array<[string, DiscoverySchema]> {
  return Object.entries(method.parameters ?? {});
}

/** Lookup by Discovery method id, e.g. `calendar.events.list`. */
export function findMethod(doc: DiscoveryDocument, id: string): DiscoveryMethod {
  const method = discoveryMethods(doc).find((m) => m.id === id);
  if (!method) throw new Error(`${doc.name}/${doc.version} has no method ${id}`);
  return method;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface GoogleRequest {
  method: string;
  url: string;
  body?: string | Uint8Array;
  headers: Record<string, string>;
}

/**
 * RFC 6570 expansion as Discovery uses it. `{name}` is a single path segment
 * and is fully encoded (`team@example.com` → `team%40example.com`). `{+name}`
 * is reserved expansion: the value is a resource NAME such as
 * `spaces/AAA/messages/BBB` whose slashes are structure, so only each segment
 * is encoded. Encoding the whole value would send `spaces%2FAAA…`, which
 * Google answers with 404.
 */
function expandPath(template: string, values: Record<string, unknown>, methodId: string): string {
  return template.replace(/\{(\+?)([^}]+)\}/g, (_, reserved: string, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === '') {
      throw new Error(`${methodId} requires path parameter "${name}".`);
    }
    const text = String(value);
    return reserved ? text.split('/').map(encodeURIComponent).join('/') : encodeURIComponent(text);
  });
}

/** File bytes for a media upload, already resolved from a Lobu file input. */
export interface UploadMedia {
  bytes: Uint8Array;
  contentType: string;
}

export function buildGoogleRequest(
  doc: DiscoveryDocument,
  method: DiscoveryMethod,
  input: Record<string, unknown>,
  options: { media?: 'download'; upload?: UploadMedia } = {}
): GoogleRequest {
  const uploadPath = options.upload ? uploadProtocol(method)?.path : undefined;
  if (options.upload && !uploadPath) throw new Error(`${method.id} does not accept a file upload.`);
  // Concatenated, not `new URL(path, base)`: a relative path whose first
  // segment holds a colon (`spaces:search`) would parse as a URL scheme. An
  // upload path is absolute from the API host (`/upload/drive/v3/files`).
  const url = new URL(
    uploadPath
      ? `${doc.rootUrl.replace(/\/$/, '')}${expandPath(uploadPath, input, method.id)}`
      : `${doc.rootUrl}${doc.servicePath}${expandPath(method.path, input, method.id)}`
  );
  for (const [name, schema] of methodParameters(method)) {
    if (schema.location !== 'query') continue;
    const value = input[name];
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(name, String(item));
    }
  }
  if (typeof input.fields === 'string' && input.fields) url.searchParams.set('fields', input.fields);
  if (options.media === 'download') url.searchParams.set('alt', 'media');

  const request: GoogleRequest = { method: method.httpMethod, url: url.toString(), headers: {} };
  if (options.upload) {
    // Multipart carries the request object beside the bytes; a method with no
    // request object (YouTube `thumbnails.set`) takes the bytes alone.
    const upload = method.request
      ? multipartRelated(JSON.stringify(input.body ?? {}), options.upload)
      : { body: options.upload.bytes, contentType: options.upload.contentType };
    url.searchParams.set('uploadType', method.request ? 'multipart' : 'media');
    request.url = url.toString();
    request.body = upload.body;
    request.headers['Content-Type'] = upload.contentType;
  } else if (input.body !== undefined && method.request) {
    request.body = JSON.stringify(input.body);
    request.headers['Content-Type'] = 'application/json';
  }
  return request;
}

/** Google's simple upload protocol, when the method offers its multipart form. */
function uploadProtocol(method: DiscoveryMethod): { path: string } | undefined {
  const simple = method.supportsMediaUpload ? method.mediaUpload?.protocols?.simple : undefined;
  return simple?.multipart ? simple : undefined;
}

/** `multipart/related`: the JSON request object, then the file's bytes verbatim. */
function multipartRelated(metadata: string, media: UploadMedia): { body: Uint8Array; contentType: string } {
  const boundary = `lobu_${crypto.randomUUID().replace(/-/g, '')}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: ${media.contentType}\r\n\r\n`
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + media.bytes.length + tail.length);
  body.set(head, 0);
  body.set(media.bytes, head.length);
  body.set(tail, head.length + media.bytes.length);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/**
 * Formats handed to the operation validator (ajv-formats): only those whose
 * AJV rule is no stricter than Google's. Dropped, and left to Google to
 * validate: Google-only formats (`google-fieldmask`, `uint64`, …) AJV does not
 * know; `byte`, because Gmail sends base64url, which AJV's base64 rejects; and
 * `date-time`/`google-datetime`, because Google accepts an offset-free time
 * beside a `timeZone` (Calendar `EventDateTime`), which RFC 3339 does not.
 */
const FORMAT_ALIASES: Record<string, string> = {
  date: 'date',
  int32: 'int32',
  int64: 'int64',
  float: 'float',
  double: 'double',
};

function scalarSchema(schema: DiscoverySchema, describe = true): JsonSchema {
  const out: JsonSchema = {};
  if (schema.type && schema.type !== 'any') out.type = schema.type;
  if (describe && schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  const format = schema.format ? FORMAT_ALIASES[schema.format] : undefined;
  if (format) out.format = format;
  if (schema.default !== undefined) out.default = coerceDefault(schema);
  if (schema.minimum !== undefined) out.minimum = Number(schema.minimum);
  if (schema.maximum !== undefined) out.maximum = Number(schema.maximum);
  return out;
}

/** Discovery spells every default as a string, even `"true"` and `"250"`. */
function coerceDefault(schema: DiscoverySchema): unknown {
  if (schema.type === 'boolean') return schema.default === 'true';
  if (schema.type === 'integer' || schema.type === 'number') return Number(schema.default);
  return schema.default;
}

function parameterSchema(schema: DiscoverySchema): JsonSchema {
  if (!schema.repeated) return scalarSchema(schema);
  const { description, ...item } = scalarSchema(schema);
  return { type: 'array', items: item, ...(description ? { description } : {}) };
}

/**
 * Convert a Discovery schema, collecting every referenced schema into `defs`.
 * Refs stay refs (`#/$defs/Event`): Discovery schemas can be recursive, so
 * inlining may not terminate. `readOnly` properties are dropped from request
 * bodies: they are server-assigned (`etag`, `htmlLink`) and Google rejects or
 * ignores them.
 *
 * Descriptions are kept only on the request object's own fields (`describe`).
 * Google's nested field prose is what makes `events.insert` 35 KB and Sheets
 * `batchUpdate` 175 KB of schema; the structure alone is a fraction of that.
 */
function bodySchema(
  doc: DiscoveryDocument,
  schema: DiscoverySchema,
  defs: Record<string, JsonSchema>,
  describe: boolean
): JsonSchema {
  if (schema.$ref) {
    addDef(doc, schema.$ref, defs, false);
    return { $ref: `#/$defs/${schema.$ref}`, ...(describe && schema.description ? { description: schema.description } : {}) };
  }
  const out = scalarSchema(schema, describe);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([, property]) => !property.readOnly)
        .map(([name, property]) => [name, bodySchema(doc, property, defs, describe)])
    );
  }
  if (schema.items) out.items = bodySchema(doc, schema.items, defs, false);
  if (schema.additionalProperties) {
    out.additionalProperties = bodySchema(doc, schema.additionalProperties, defs, false);
  }
  return out;
}

function addDef(
  doc: DiscoveryDocument,
  name: string,
  defs: Record<string, JsonSchema>,
  describe: boolean
): void {
  if (defs[name]) return;
  const schema = doc.schemas?.[name];
  if (!schema) throw new Error(`${doc.name}/${doc.version} references unknown schema ${name}`);
  defs[name] = {}; // placeholder first: a self-reference must not recurse forever
  defs[name] = bodySchema(doc, schema, defs, describe);
}

/**
 * Google's partial-response selector, valid on every method. Drive needs it
 * most: without it `files.get` answers with four fields.
 */
const FIELDS_PARAMETER: JsonSchema = {
  type: 'string',
  description:
    'Partial-response field selector, e.g. `nextPageToken,files(id,name,modifiedTime)`. `*` returns every field; some APIs (Drive) return only a few unless asked.',
};

/**
 * The file a media-upload method sends beside its request object. Lobu's file
 * input contract carries it, so bytes never pass through the model; the cap is
 * the platform's per-operation limit or Google's, whichever is lower.
 */
function mediaSchema(method: DiscoveryMethod): JsonSchema {
  const googleMax = Number(method.mediaUpload?.maxSize);
  const maxBytes = Math.min(MAX_CONNECTOR_FILE_BYTES, Number.isFinite(googleMax) && googleMax > 0 ? googleMax : Infinity);
  const accept = method.mediaUpload?.accept?.join(', ');
  return {
    ...fileInputSchema({ maxBytes }),
    description:
      `File content to upload with this request (at most ${maxBytes} bytes${accept ? `; ${accept}` : ''}). ` +
      'The request object still goes in `body`. Pass a file from run_sdk ctx.files or a Lobu file reference, never inline bytes copied through the model.',
  };
}

/**
 * Flat action input: every path/query parameter at the top level, plus `body`
 * for methods that take a request object. Flat because that is how every
 * Google client library and Google's own reference page present a call.
 */
export function methodInputSchema(
  doc: DiscoveryDocument,
  method: DiscoveryMethod,
  defaults: Record<string, unknown> = {}
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, schema] of methodParameters(method)) {
    if (name === 'body' || name === 'fields' || name === 'media') {
      throw new Error(`${method.id} has a parameter named "${name}", which collides with a reserved input.`);
    }
    properties[name] = parameterSchema(schema);
    if (name in defaults) properties[name].default = defaults[name];
    else if (schema.required) required.push(name);
  }
  properties.fields = FIELDS_PARAMETER;
  if (uploadProtocol(method)) properties.media = mediaSchema(method);
  const schema: JsonSchema = { type: 'object', properties, ...(required.length ? { required } : {}) };
  if (!method.request) return schema;
  const defs: Record<string, JsonSchema> = {};
  addDef(doc, method.request.$ref, defs, true);
  properties.body = { $ref: `#/$defs/${method.request.$ref}`, description: 'Request body.' };
  return fitToBudget({ ...schema, $defs: defs }, method.request.$ref);
}

/**
 * Upper bound on one action's input schema, in serialized bytes.
 *
 * `operations.listAvailable` returns every input schema by default, so a
 * connector's whole catalogue lands in an agent's context: Calendar's 32
 * actions were 134 KB, Sheets `batchUpdate` alone 54 KB (203 nested types).
 */
const SCHEMA_BUDGET_BYTES = 12 * 1024;

/**
 * Shrink a body-carrying schema until it fits the budget, in order of what is
 * lost: first the body's field prose is cut to its first sentence, then the
 * deepest nested types collapse to opaque `{ type, title }` placeholders, one
 * level at a time. Parameters are never touched. Collapsing only loosens
 * validation — Google still validates the body — so what is lost is guidance,
 * never correctness of what is sent. A request type whose own fields exceed the
 * budget (Drive `File`) is returned at depth 0 rather than truncated further.
 */
function fitToBudget(schema: JsonSchema, root: string): JsonSchema {
  const size = (s: JsonSchema) => JSON.stringify(s).length;
  if (size(schema) <= SCHEMA_BUDGET_BYTES) return schema;

  const defs = mapDescriptions(schema.$defs, firstSentence) as Record<string, JsonSchema>;
  let fitted: JsonSchema = { ...schema, $defs: defs };
  if (size(fitted) <= SCHEMA_BUDGET_BYTES) return fitted;

  const depths = new Map([[root, 0]]);
  const queue = [root];
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const ref of refsIn(defs[name])) {
      if (depths.has(ref)) continue;
      depths.set(ref, (depths.get(name) ?? 0) + 1);
      queue.push(ref);
    }
  }
  for (let depth = Math.max(...depths.values()) - 1; depth >= 0; depth--) {
    const keep = new Set([...depths].filter(([, d]) => d <= depth).map(([name]) => name));
    fitted = {
      ...schema,
      properties: collapseRefs(schema.properties, keep, defs),
      $defs: Object.fromEntries([...keep].map((name) => [name, collapseRefs(defs[name], keep, defs)])),
    };
    if (size(fitted) <= SCHEMA_BUDGET_BYTES) break;
  }
  return fitted;
}

function firstSentence(text: string): string {
  const sentence = (text.match(/^[\s\S]*?[.!?](?=\s+[A-Z]|$)/)?.[0] ?? text).trim();
  return sentence.length > 200 ? `${sentence.slice(0, 199)}…` : sentence;
}

function mapDescriptions(node: unknown, map: (text: string) => string): unknown {
  if (Array.isArray(node)) return node.map((child) => mapDescriptions(child, map));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === 'description' && typeof value === 'string' ? map(value) : mapDescriptions(value, map),
    ])
  );
}

const DEF_PREFIX = '#/$defs/';

function refsIn(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const child of node) refsIn(child, found);
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.add(value.slice(DEF_PREFIX.length));
      else refsIn(value, found);
    }
  }
  return found;
}

/** Replace refs to types outside `keep` with an opaque schema naming the Google type. */
function collapseRefs(node: unknown, keep: Set<string>, defs: Record<string, JsonSchema>): JsonSchema {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const { $ref, ...rest } = value as JsonSchema;
    if (typeof $ref === 'string') {
      const name = $ref.slice(DEF_PREFIX.length);
      if (!keep.has(name)) return { type: defs[name]?.type ?? 'object', title: name, ...rest };
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
  };
  return walk(node) as JsonSchema;
}
