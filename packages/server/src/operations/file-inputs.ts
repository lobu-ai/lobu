import { type FileInputOptions, MAX_CONNECTOR_FILE_BYTES } from '@lobu/connector-sdk';
import { runArtifactBinding, type ArtifactStore, type StoredArtifactMetadata } from '../gateway/files/artifact-store';
import { inputArtifactId, inputFileBinding, MAX_INPUT_FILES, storedInputFile } from '../gateway/files/input-files';
import { getLobuCoreServices } from '../lobu/gateway';
import { handleGetRun } from '../tools/admin/manage_operations/handlers/runs';
import { resolvePublicGatewayUrl } from '../utils/public-origin';
import type { ToolContext } from '../tools/registry';
import { ToolUserError } from '../utils/errors';

interface FileClaim {
  path: string[];
  artifactId: string;
  binding: string;
  sha256: string;
  maxBytes: number;
}

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value);
const hasFiles = (input: unknown): boolean => JSON.stringify(input).includes('"$file":');

function storeOrThrow(store?: ArtifactStore): ArtifactStore {
  const resolved = store ?? getLobuCoreServices()?.getArtifactStore();
  if (!resolved) throw new ToolUserError('File storage is unavailable.', 503);
  return resolved;
}

function expandSchemas(schema: Schema, root: Schema, seen = new Set<Schema>()): Schema[] {
  if (seen.has(schema)) return [];
  if (seen.size >= 64) throw new ToolUserError('File input schema is too complex.', 422);
  seen.add(schema);
  const variants = [schema];
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    let target: unknown = root;
    for (const part of schema.$ref.slice(2).split('/')) {
      target = object(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
    }
    if (object(target)) variants.push(...expandSchemas(target, root, seen));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      for (const child of schema[key]) if (object(child)) variants.push(...expandSchemas(child, root, seen));
    }
  }
  return variants;
}

/** Walk only caller input; no byte payload crosses the agent's SDK bridge. */
async function rewriteFiles(
  input: Record<string, unknown>,
  schema: Schema,
  resolve: (value: Schema, path: string[], schemas: Schema[]) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  let visited = 0;
  async function visit(value: unknown, path: string[], schemas: Schema[]): Promise<unknown> {
    if (++visited > 10_000 || path.length > 64) throw new ToolUserError('File input is too complex.', 422);
    const expanded = schemas.flatMap((item) => expandSchemas(item, schema));
    if (object(value) && (Object.hasOwn(value, '$file') || expanded.some((item) => object(item['x-lobu-file'])))) return resolve(value, path, expanded);
    if (!value || typeof value !== 'object') return value;
    const entries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      const childSchemas = expanded.flatMap((item) => {
        let candidate: unknown;
        if (Array.isArray(value)) {
          candidate = Array.isArray(item.items) ? item.items[Number(key)] : item.items;
        } else if (object(item.properties) && Object.hasOwn(item.properties, key)) {
          candidate = item.properties[key];
        } else {
          candidate = item.additionalProperties;
        }
        return object(candidate) ? [candidate] : [];
      });
      entries.push([key, await visit(child, [...path, key], childSchemas)]);
    }
    return Array.isArray(value) ? entries.map(([, child]) => child) : Object.fromEntries(entries);
  }
  return await visit(input, [], [schema]) as Record<string, unknown>;
}

function readInlineFile(value: Schema, maxBytes: number) {
  if (typeof value.base64 !== 'string' || typeof value.filename !== 'string' || typeof value.content_type !== 'string') return null;
  const bytes = Buffer.from(value.base64, 'base64');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== value.base64) return null;
  return {
    bytes,
    metadata: { artifactId: '', filename: value.filename, contentType: value.content_type, size: bytes.length, sha256: '' },
  };
}

/** `run:<id>` is the binding `materializeActionOutputAttachments` stamps on an action's output files. */
// 15 digits keeps the id inside Number.MAX_SAFE_INTEGER, matching the
// `Number.isSafeInteger` guard in mcp-media-resources.ts.
const RUN_BINDING = /^run:([1-9][0-9]{0,14})$/;

/**
 * Adopt an artifact a connector action produced into the caller's own input
 * namespace, or return null when it is not one / the caller may not have it.
 *
 * An agent that downloads a file (Drive `download_file`, Gmail
 * `download_attachment`) gets back an artifact bound `run:<id>`. Feeding it
 * straight into another connector's `$file` field fails, because
 * `prepareOperationFiles` reads under `input:<sha256(principal)>` and
 * `ArtifactStore.read` demands an exact binding match. The bytes are right
 * there and every connector-to-connector handoff dead-ends on the boundary.
 *
 * The boundary is correct and stays: this does not relax the binding check, it
 * re-runs the SAME authorization the MCP media-resource reader already uses for
 * run-bound attachments (`mcp-media-resources.ts`) — can this caller `get_run`
 * that run? — and only then copies the bytes into a NEW artifact the caller
 * genuinely owns. A copy rather than a rebind, so the run's own artifact keeps
 * its binding and lifetime: adopting a file must not mutate the run's output or
 * let one caller's cleanup delete another's input.
 *
 * `inspect` is deliberately called WITHOUT a binding. That is the one read here
 * that is not access-controlled, and it is safe precisely because nothing is
 * returned from it to the caller — it only names which run to authorize
 * against. An unauthorized caller learns nothing: a foreign run and a
 * nonexistent one both end as the same 422.
 */
async function adoptRunArtifact(params: {
  store: ArtifactStore;
  artifactId: string;
  ctx: ToolContext;
  binding: string;
  maxBytes: number;
  publicGatewayUrl: string;
  /**
   * Runs against the SOURCE metadata, before the copy is published: a gate that
   * rejected afterwards would leave an orphan in the caller's own `input:`
   * namespace, referenced by no claim. Throwing from here publishes nothing.
   *
   * Per file, not per operation — in a multi-file input an already-adopted copy
   * still outlives a later file's rejection, same as an uploaded input does.
   */
  accept: (metadata: { contentType: string; size: number }) => void;
}): Promise<{ metadata: StoredArtifactMetadata; bytes: Buffer } | null> {
  const stored = await params.store.inspect(params.artifactId);
  const runId = stored?.binding ? RUN_BINDING.exec(stored.binding)?.[1] : undefined;
  if (!runId) return null;

  // The authorization. `handleGetRun` scopes to `ctx.organizationId` and
  // excludes the run types `list_runs` hides, so a run this caller cannot see
  // is "Run not found" here too.
  const run = await handleGetRun({ action: 'get_run', run_id: Number(runId) }, params.ctx);
  if (!('run' in run) || !run.run) return null;

  const source = await params.store.read(params.artifactId, {
    binding: runArtifactBinding(Number(runId)),
    maxBytes: params.maxBytes,
  });
  if (!source) return null;

  params.accept(source.metadata);

  const published = await params.store.publish({
    buffer: source.bytes,
    filename: source.metadata.filename,
    contentType: source.metadata.contentType,
    publicGatewayUrl: params.publicGatewayUrl,
    binding: params.binding,
  });
  // Everything but the id and the binding carries over verbatim: the adopted
  // copy must present the SAME filename, media type, size and digest, so a
  // connector's contentTypes gate and the claim's sha256 pin behave identically
  // whether the file was uploaded or adopted.
  return {
    metadata: { ...source.metadata, artifactId: published.artifactId, binding: params.binding },
    bytes: source.bytes,
  };
}

/** Authorize files before queuing; persist claims with the existing operation run. */
export async function prepareOperationFiles(
  input: Record<string, unknown>,
  schema: Schema | undefined,
  ctx: ToolContext,
  store?: ArtifactStore,
): Promise<{ input: Record<string, unknown>; claims: FileClaim[] }> {
  const claims: FileClaim[] = [];
  if (!hasFiles(input) && !JSON.stringify(schema ?? {}).includes('"x-lobu-file"')) return { input, claims };
  let totalBytes = 0;
  let fileCount = 0;
  const prepared = await rewriteFiles(input, schema ?? {}, async (value, path, schemas) => {
    const declarations = schemas.map((item) => item['x-lobu-file']).filter(object);
    const artifactId = inputArtifactId(value);
    if (declarations.length === 0 || (Object.hasOwn(value, '$file') && !artifactId)) {
      throw new ToolUserError(`Field ${path.join('.')} must declare a valid connector file input.`, 422);
    }
    if (++fileCount > MAX_INPUT_FILES) throw new ToolUserError(`An operation supports at most ${MAX_INPUT_FILES} files.`, 422);
    let maxBytes = MAX_CONNECTOR_FILE_BYTES;
    for (const declaration of declarations) {
      if (!Number.isSafeInteger(declaration.maxBytes) || Number(declaration.maxBytes) <= 0) {
        throw new ToolUserError('Connector file input has an invalid size limit.', 422);
      }
      maxBytes = Math.min(maxBytes, Number(declaration.maxBytes));
    }
    // One rule for both paths. Adoption applies it BEFORE publishing its copy,
    // so a rejected file never leaves an orphan behind; the direct path applies
    // it below, where it has always run.
    const accept = (metadata: { contentType: string; size: number }) => {
      for (const declaration of declarations) {
        const contentTypes = (declaration as unknown as FileInputOptions).contentTypes;
        if (contentTypes && (!Array.isArray(contentTypes) || !contentTypes.includes(metadata.contentType))) {
          throw new ToolUserError(`File type ${metadata.contentType} is not accepted by this connector field.`, 422);
        }
      }
      if (totalBytes + metadata.size > MAX_CONNECTOR_FILE_BYTES) {
        throw new ToolUserError('Operation files exceed the 12 MiB connector execution limit. Use smaller files or separate operations.', 413);
      }
    };
    const binding = artifactId ? inputFileBinding(ctx) : undefined;
    let adoptedArtifactId: string | undefined;
    let file = artifactId
      ? await storeOrThrow(store).read(artifactId, { binding, maxBytes })
      : readInlineFile(value, maxBytes);
    if (!file && artifactId) {
      // Not in the caller's own namespace — it may still be a file produced by
      // a run this caller's ORG can `get_run`, which lands bound to that run.
      // Note the asymmetry: input bindings are principal-scoped, while this
      // adoption is org-scoped, exactly like the run-attachment read that
      // mcp-media-resources.ts already exposes.
      const adopted = await adoptRunArtifact({
        store: storeOrThrow(store),
        artifactId,
        ctx,
        binding: binding!,
        maxBytes,
        publicGatewayUrl: resolvePublicGatewayUrl(),
        accept,
      });
      if (adopted) {
        adoptedArtifactId = adopted.metadata.artifactId;
        file = adopted;
      }
    }
    if (!file) throw new ToolUserError('File is unavailable, outside this caller’s scope, or exceeds the connector limit. Upload it again in this workspace.', 422);
    // Idempotent for an adopted file: `accept` ran on the same metadata before
    // the copy was published, and re-running it changes nothing.
    accept(file.metadata);
    totalBytes += file.metadata.size;
    if (!artifactId) return value;
    // The claim names the ADOPTED copy: it is the one bound to this caller, and
    // the one `resolveOperationFiles` will read back under the `input:` binding.
    claims.push({ path, artifactId: adoptedArtifactId ?? artifactId, binding: binding!, sha256: file.metadata.sha256, maxBytes });
    // Approval cards show storage metadata, never caller-invented filenames/hashes.
    return storedInputFile(file.metadata);
  });
  return { input: prepared, claims };
}

/** Called only with server-stamped metadata from an authorized action run. */
export async function resolveOperationFiles(
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | null | undefined,
  store?: ArtifactStore,
): Promise<Record<string, unknown>> {
  const claims = Array.isArray(metadata?.input_files) ? metadata.input_files as FileClaim[] : [];
  const changed = () => new ToolUserError('Operation file changed after authorization. Create a new operation with the intended file.', 422);
  if (!hasFiles(input)) {
    if (claims.length > 0) throw changed();
    return input;
  }
  const artifacts = storeOrThrow(store);
  const unresolvedClaims = new Set(claims);
  let totalBytes = 0;
  const resolved = await rewriteFiles(input, {}, async (value, path) => {
    const artifactId = inputArtifactId(value);
    const claim = claims.find((item) => JSON.stringify(item.path) === JSON.stringify(path));
    if (!artifactId || !claim || claim.artifactId !== artifactId ||
        typeof claim.binding !== 'string' || !/^input:[0-9a-f]{64}$/.test(claim.binding) ||
        !Number.isSafeInteger(claim.maxBytes) || claim.maxBytes <= 0 || claim.maxBytes > MAX_CONNECTOR_FILE_BYTES ||
        typeof claim.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(claim.sha256)) {
      throw changed();
    }
    unresolvedClaims.delete(claim);
    const file = await artifacts.read(artifactId, { binding: claim.binding, maxBytes: claim.maxBytes });
    if (!file || file.metadata.sha256 !== claim.sha256) {
      throw new ToolUserError('An authorized operation file is missing or changed. Upload it again and create a new operation.', 422);
    }
    totalBytes += file.metadata.size;
    if (totalBytes > MAX_CONNECTOR_FILE_BYTES) throw new ToolUserError('Operation files exceed the 12 MiB connector execution limit. Use smaller files or separate operations.', 413);
    return { base64: file.bytes.toString('base64'), filename: file.metadata.filename, content_type: file.metadata.contentType };
  });
  if (unresolvedClaims.size > 0) throw changed();
  return resolved;
}
