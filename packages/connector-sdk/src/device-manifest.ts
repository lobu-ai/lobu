export type DeviceManifestSchema = Record<string, unknown>;

export interface DeviceConnectorManifest {
  key: string;
  version: string;
  name: string;
  description?: string | null;
  favicon_domain?: string | null;
  required_capability: string;
  runtime: {
    platforms: string[];
    scopes?: string[];
    nix?: { packages?: string[] } | null;
  };
  auth_schema?: DeviceManifestSchema | null;
  feeds_schema: Record<string, unknown>;
  actions_schema?: Record<string, unknown> | null;
  options_schema?: DeviceManifestSchema | null;
  manifest_hash?: string | null;
}

/**
 * How a device implements a connector is the ENDPOINT's business, never the
 * contract's. Anything declared here is hashed into the manifest identity, so
 * a field naming the implementation (a native bridge, a daemon built-in) would
 * give two endpoints of the same contract two different hashes — and an
 * organization elects exactly one manifest per key, so the losing endpoint
 * silently stops being claimable. `platforms` is a compatibility set, not an
 * ownership claim; each endpoint dispatches from its own registry.
 */
export interface DeviceConnectorRuntimeInfo {
  platforms: readonly string[];
  scopes?: readonly string[];
  nix?: { readonly packages?: readonly string[] } | null;
}

export interface DeviceFeedDefinition extends DeviceManifestSchema {
  key: string;
  name: string;
  description?: string;
  userManaged?: boolean;
  operations: Array<'sync' | 'read'>;
  configSchema?: DeviceManifestSchema;
  eventKinds?: Record<string, DeviceManifestSchema>;
}

export interface DeviceActionDefinition extends DeviceManifestSchema {
  key: string;
  name: string;
  description?: string;
  requiresApproval?: boolean;
  kind?: 'read' | 'write';
  annotations?: DeviceManifestSchema;
  inputSchema?: DeviceManifestSchema;
  outputSchema?: DeviceManifestSchema;
}

export interface DeviceConnectorDefinition {
  key: string;
  version: string;
  name: string;
  description?: string;
  faviconDomain?: string;
  requiredCapability: string;
  runtime: DeviceConnectorRuntimeInfo;
  authSchema?: DeviceManifestSchema;
  feeds?: Record<string, DeviceFeedDefinition>;
  actions?: Record<string, DeviceActionDefinition>;
  optionsSchema?: DeviceManifestSchema;
}

export type DeviceConnectorSpec = DeviceConnectorDefinition;

/** Recursively sort object keys while preserving array order. */
export function sortDeviceManifestJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeviceManifestJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortDeviceManifestJson(entry)]),
  );
}

/** Return the exact compact canonical JSON used by the server manifest hash. */
export function canonicalDeviceManifestJson(manifest: DeviceConnectorManifest): string {
  const { manifest_hash: _ignored, ...payload } = manifest;
  for (const key of [
    'description',
    'favicon_domain',
    'auth_schema',
    'actions_schema',
    'options_schema',
  ] as const) {
    if (payload[key] == null) delete payload[key];
  }
  return JSON.stringify(sortDeviceManifestJson(payload));
}

/** Serialize a validated authoring definition to the server's snake_case wire shape. */
export function serializeDeviceConnector(definition: DeviceConnectorDefinition): DeviceConnectorManifest {
  const manifest: DeviceConnectorManifest = {
    key: definition.key,
    version: definition.version,
    name: definition.name,
    description: definition.description,
    favicon_domain: definition.faviconDomain,
    required_capability: definition.requiredCapability,
    runtime: {
      platforms: [...definition.runtime.platforms],
      scopes: definition.runtime.scopes ? [...definition.runtime.scopes] : undefined,
      nix: definition.runtime.nix
        ? {
            packages: definition.runtime.nix.packages
              ? [...definition.runtime.nix.packages]
              : undefined,
          }
        : definition.runtime.nix,
    },
    auth_schema: definition.authSchema ?? { methods: [{ type: 'none' }] },
    feeds_schema: definition.feeds ?? {},
    actions_schema: definition.actions,
    options_schema: definition.optionsSchema,
  };
  return removeUndefined(manifest) as DeviceConnectorManifest;
}

/** Validate and serialize one or more non-executable device definitions. */
export function defineDeviceConnector(
  specification: DeviceConnectorSpec,
): DeviceConnectorDefinition;
export function defineDeviceConnector(
  specifications: readonly DeviceConnectorSpec[],
): readonly DeviceConnectorDefinition[];
export function defineDeviceConnector(
  specification: DeviceConnectorSpec | readonly DeviceConnectorSpec[],
): DeviceConnectorDefinition | readonly DeviceConnectorDefinition[] {
  if (Array.isArray(specification)) {
    const definitions = specification.map((entry) => validateDeviceConnector(entry as DeviceConnectorSpec));
    const keys = new Set<string>();
    for (const definition of definitions) {
      if (keys.has(definition.key)) throw new Error(`duplicate device connector key '${definition.key}'`);
      keys.add(definition.key);
    }
    return definitions;
  }
  return validateDeviceConnector(specification as DeviceConnectorSpec);
}

function validateDeviceConnector(specification: DeviceConnectorSpec): DeviceConnectorDefinition {
  if (!isRecord(specification)) throw new Error('device connector definition must be an object');
  for (const key of ['key', 'version', 'name', 'requiredCapability'] as const) {
    if (typeof specification[key] !== 'string' || specification[key].trim() === '') {
      throw new Error(`${key} is required`);
    }
  }
  const runtime = specification.runtime;
  if (!isRecord(runtime) || !Array.isArray(runtime.platforms) || runtime.platforms.length === 0) {
    throw new Error('runtime.platforms is required');
  }
  if (!runtime.platforms.every((platform) => typeof platform === 'string' && platform.trim() !== '')) {
    throw new Error('runtime.platforms must contain non-empty strings');
  }
  if ('execution' in runtime) {
    throw new Error('runtime.execution is not part of a device contract; each endpoint dispatches locally');
  }
  rejectExecutableHandlers(specification);
  validateAuthSchema(specification.authSchema);
  validateFeeds(specification.feeds);
  validateActions(specification.actions);
  return specification;
}

function validateFeeds(feeds: DeviceConnectorDefinition['feeds']): void {
  if (feeds === undefined) return;
  if (!isRecord(feeds)) throw new Error('feeds must be an object');
  for (const [key, feed] of Object.entries(feeds)) {
    if (!isRecord(feed) || feed.key !== key || !nonEmptyString(feed.name)) {
      throw new Error(`invalid feed schema '${key}'`);
    }
    if (feed.configSchema !== undefined && !isRecord(feed.configSchema)) {
      throw new Error(`invalid feed configSchema '${key}'`);
    }
    if (
      !Array.isArray(feed.operations) ||
      feed.operations.length === 0 ||
      !feed.operations.every((operation) => operation === 'sync' || operation === 'read') ||
      new Set(feed.operations).size !== feed.operations.length
    ) {
      throw new Error(`invalid feed operations '${key}'`);
    }
    if (feed.eventKinds !== undefined) {
      if (!isRecord(feed.eventKinds)) throw new Error(`invalid feed eventKinds '${key}'`);
      for (const [eventKey, eventKind] of Object.entries(feed.eventKinds)) {
        if (!isRecord(eventKind)) throw new Error(`invalid event kind '${key}.${eventKey}'`);
        if (eventKind.metadataSchema !== undefined && !isRecord(eventKind.metadataSchema)) {
          throw new Error(`invalid event metadataSchema '${key}.${eventKey}'`);
        }
      }
    }
  }
}

function validateActions(actions: DeviceConnectorDefinition['actions']): void {
  if (actions === undefined) return;
  if (!isRecord(actions)) throw new Error('actions must be an object');
  for (const [key, action] of Object.entries(actions)) {
    if (!isRecord(action) || action.key !== key || !nonEmptyString(action.name)) {
      throw new Error(`invalid action schema '${key}'`);
    }
    for (const schemaKey of ['inputSchema', 'outputSchema'] as const) {
      if (action[schemaKey] !== undefined && !isRecord(action[schemaKey])) {
        throw new Error(`invalid action ${schemaKey} '${key}'`);
      }
    }
    if (action.annotations !== undefined && !isRecord(action.annotations)) {
      throw new Error(`invalid action annotations '${key}'`);
    }
  }
}

function validateAuthSchema(authSchema: DeviceManifestSchema | undefined): void {
  if (authSchema === undefined) return;
  if (!isRecord(authSchema) || !Array.isArray(authSchema.methods)) {
    throw new Error('invalid device auth schema');
  }
  if (!authSchema.methods.every((method) => isRecord(method) && method.type === 'none')) {
    throw new Error('device connectors may only use auth_schema.methods=[{type:"none"}]');
  }
}

function rejectExecutableHandlers(specification: DeviceConnectorSpec): void {
  const executableNames = [
    'sync',
    'read',
    'onDelivery',
    'execute',
    'authenticate',
    'query',
    'search',
    'registerWebhook',
    'unregisterWebhook',
  ];
  for (const key of executableNames) {
    if (typeof (specification as unknown as Record<string, unknown>)[key] === 'function') {
      throw new Error(`device connector definitions cannot contain executable handler '${key}'`);
    }
  }
  for (const [feedKey, feed] of Object.entries(specification.feeds ?? {})) {
    for (const handler of ['sync', 'read', 'onDelivery']) {
      if (typeof (feed as unknown as Record<string, unknown>)[handler] === 'function') {
        throw new Error(`device connector feed '${feedKey}' cannot contain a ${handler} handler`);
      }
    }
  }
  for (const [actionKey, action] of Object.entries(specification.actions ?? {})) {
    if (typeof (action as unknown as Record<string, unknown>).execute === 'function') {
      throw new Error(`device connector action '${actionKey}' cannot contain an execute handler`);
    }
  }
  const functionPath = findFunctionPath(specification);
  if (functionPath) {
    throw new Error(`device connector definitions cannot contain executable handler '${functionPath}'`);
  }
}

function findFunctionPath(value: unknown, path = 'definition'): string | null {
  if (typeof value === 'function') return path;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const nested = findFunctionPath(entry, `${path}[${index}]`);
      if (nested) return nested;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, entry] of Object.entries(value)) {
    const nested = findFunctionPath(entry, `${path}.${key}`);
    if (nested) return nested;
  }
  return null;
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, removeUndefined(entry)]),
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
