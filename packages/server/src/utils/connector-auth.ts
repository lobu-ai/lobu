import type {
  ConnectorAuthAppInstallation,
  ConnectorAuthEnvField,
  ConnectorAuthEnvKeys,
  ConnectorAuthMethod,
  ConnectorAuthOAuth,
  ConnectorAuthSchema,
} from '@lobu/connector-sdk';

export type ConnectorAuthOAuthMethod = ConnectorAuthOAuth & {
  userinfoUrl?: string;
  authParams?: Record<string, string>;
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic' | 'none';
  usePkce?: boolean;
  loginScopes?: string[];
  optionalScopes?: string[];
  resource?: string;
  loginProvisioning?: {
    autoCreateConnection?: boolean;
  };
};

const DEFAULT_AUTH_SCHEMA: ConnectorAuthSchema = {
  methods: [{ type: 'none' }],
};

/** Managed OAuth keeps the account grant in the named cloud organization. */
export function getManagedByOrg(config: Record<string, unknown> | null | undefined): string | null {
  const managedBy = config?.managedBy;
  if (!managedBy || typeof managedBy !== 'object' || Array.isArray(managedBy)) return null;
  const org = (managedBy as Record<string, unknown>).org;
  return typeof org === 'string' && org.trim() ? org.trim() : null;
}

function isLikelySecretKey(key: string): boolean {
  return /(secret|token|password|api_key|apikey|private_key|client_secret)/i.test(key);
}

function parseLoginProvisioning(
  raw: unknown
): ConnectorAuthOAuthMethod['loginProvisioning'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const result: NonNullable<ConnectorAuthOAuthMethod['loginProvisioning']> = {};
  if (typeof obj.autoCreateConnection === 'boolean') {
    result.autoCreateConnection = obj.autoCreateConnection;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeConnectorAuthSchema(value: unknown): ConnectorAuthSchema {
  if (typeof value === 'string') {
    try {
      return normalizeConnectorAuthSchema(JSON.parse(value));
    } catch {
      return DEFAULT_AUTH_SCHEMA;
    }
  }

  if (!value || typeof value !== 'object') {
    return DEFAULT_AUTH_SCHEMA;
  }

  const rawMethods = (value as { methods?: unknown }).methods;
  if (!Array.isArray(rawMethods) || rawMethods.length === 0) {
    return DEFAULT_AUTH_SCHEMA;
  }

  const methods: ConnectorAuthMethod[] = [];

  for (const rawMethod of rawMethods) {
    if (!rawMethod || typeof rawMethod !== 'object') continue;
    const method = rawMethod as Record<string, unknown>;
    const type = method.type;

    if (type === 'none') {
      methods.push({ type: 'none' });
      continue;
    }

    if (type === 'env_keys') {
      const rawFields = Array.isArray(method.fields) ? method.fields : [];
      const fields: ConnectorAuthEnvField[] = rawFields
        .filter((field) => field && typeof field === 'object')
        .map((field) => {
          const f = field as Record<string, unknown>;
          const key = typeof f.key === 'string' ? f.key.trim() : '';
          return {
            key,
            label: typeof f.label === 'string' ? f.label : undefined,
            description: typeof f.description === 'string' ? f.description : undefined,
            example: typeof f.example === 'string' ? f.example : undefined,
            required: typeof f.required === 'boolean' ? f.required : undefined,
            secret: typeof f.secret === 'boolean' ? f.secret : isLikelySecretKey(key),
          };
        })
        .filter((field) => field.key.length > 0);

      if (fields.length > 0) {
        methods.push({
          type: 'env_keys',
          required: typeof method.required === 'boolean' ? method.required : true,
          scope:
            method.scope === 'connection' || method.scope === 'organization'
              ? method.scope
              : 'connection',
          description: typeof method.description === 'string' ? method.description : undefined,
          fields,
        });
      }
      continue;
    }

    if (type === 'app_installation') {
      const provider = typeof method.provider === 'string' ? method.provider.trim() : '';
      if (!provider) continue;

      const stringArray = (raw: unknown): string[] | undefined =>
        Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === 'string')
          : undefined;
      const permissions = stringArray(method.permissions);
      const events = stringArray(method.events);

      methods.push({
        type: 'app_installation',
        provider,
        providerInstance:
          typeof method.providerInstance === 'string' ? method.providerInstance : undefined,
        installShape:
          method.installShape === 'oauth-code-exchange' || method.installShape === 'github-app'
            ? method.installShape
            : undefined,
        authorizeUrl: typeof method.authorizeUrl === 'string' ? method.authorizeUrl : undefined,
        tokenUrl: typeof method.tokenUrl === 'string' ? method.tokenUrl : undefined,
        appIdKey: typeof method.appIdKey === 'string' ? method.appIdKey : undefined,
        privateKeyKey:
          typeof method.privateKeyKey === 'string' ? method.privateKeyKey : undefined,
        appSlugKey: typeof method.appSlugKey === 'string' ? method.appSlugKey : undefined,
        clientIdKey: typeof method.clientIdKey === 'string' ? method.clientIdKey : undefined,
        clientSecretKey:
          typeof method.clientSecretKey === 'string' ? method.clientSecretKey : undefined,
        webhookSecretKey:
          typeof method.webhookSecretKey === 'string' ? method.webhookSecretKey : undefined,
        installUrlTemplate:
          typeof method.installUrlTemplate === 'string' ? method.installUrlTemplate : undefined,
        ...(permissions && permissions.length > 0 ? { permissions } : {}),
        ...(events && events.length > 0 ? { events } : {}),
        required: typeof method.required === 'boolean' ? method.required : undefined,
        description: typeof method.description === 'string' ? method.description : undefined,
      });
      continue;
    }

    if (type === 'oauth') {
      const provider = typeof method.provider === 'string' ? method.provider.trim() : '';
      if (!provider) continue;

      const requiredScopes = Array.isArray(method.requiredScopes)
        ? method.requiredScopes.filter((scope): scope is string => typeof scope === 'string')
        : [];

      const authParams: Record<string, string> | undefined =
        method.authParams && typeof method.authParams === 'object'
          ? Object.fromEntries(
              Object.entries(method.authParams as Record<string, unknown>).filter(
                ([, value]) => typeof value === 'string'
              ) as Array<[string, string]>
            )
          : undefined;
      const loginScopes = Array.isArray(method.loginScopes)
        ? method.loginScopes.filter((scope): scope is string => typeof scope === 'string')
        : undefined;
      const optionalScopes = Array.isArray(method.optionalScopes)
        ? method.optionalScopes.filter((scope): scope is string => typeof scope === 'string')
        : undefined;
      const loginProvisioning = parseLoginProvisioning(method.loginProvisioning);

      methods.push({
        type: 'oauth',
        provider,
        requiredScopes,
        required: typeof method.required === 'boolean' ? method.required : false,
        scope:
          method.scope === 'connection' || method.scope === 'organization'
            ? method.scope
            : 'connection',
        description: typeof method.description === 'string' ? method.description : undefined,
        authorizationUrl:
          typeof method.authorizationUrl === 'string' ? method.authorizationUrl : undefined,
        tokenUrl: typeof method.tokenUrl === 'string' ? method.tokenUrl : undefined,
        userinfoUrl: typeof method.userinfoUrl === 'string' ? method.userinfoUrl : undefined,
        ...(authParams && Object.keys(authParams).length > 0 ? { authParams } : {}),
        tokenEndpointAuthMethod:
          method.tokenEndpointAuthMethod === 'client_secret_basic' ||
          method.tokenEndpointAuthMethod === 'client_secret_post' ||
          method.tokenEndpointAuthMethod === 'none'
            ? method.tokenEndpointAuthMethod
            : undefined,
        usePkce: typeof method.usePkce === 'boolean' ? method.usePkce : undefined,
        ...(loginScopes && loginScopes.length > 0 ? { loginScopes } : {}),
        ...(optionalScopes && optionalScopes.length > 0 ? { optionalScopes } : {}),
        clientIdKey: typeof method.clientIdKey === 'string' ? method.clientIdKey : undefined,
        clientSecretKey:
          typeof method.clientSecretKey === 'string' ? method.clientSecretKey : undefined,
        setupInstructions:
          typeof method.setupInstructions === 'string' ? method.setupInstructions : undefined,
        ...(loginProvisioning && Object.keys(loginProvisioning).length > 0
          ? { loginProvisioning }
          : {}),
      });
    }
  }

  return methods.length > 0 ? { methods } : DEFAULT_AUTH_SCHEMA;
}

function getEnvAuthMethods(authSchema: ConnectorAuthSchema): ConnectorAuthEnvKeys[] {
  return authSchema.methods.filter(
    (method): method is ConnectorAuthEnvKeys => method.type === 'env_keys'
  );
}

/** Every env-key field key the connector declares (across all env_keys methods). */
export function getEnvAuthFieldKeys(authSchema: ConnectorAuthSchema): string[] {
  return getEnvAuthMethods(authSchema).flatMap((method) =>
    method.fields.map((field) => field.key)
  );
}

export function getOAuthAuthMethods(authSchema: ConnectorAuthSchema): ConnectorAuthOAuthMethod[] {
  return authSchema.methods.filter(
    (method): method is ConnectorAuthOAuthMethod => method.type === 'oauth'
  );
}

export function getAppInstallationAuthMethods(
  authSchema: ConnectorAuthSchema
): ConnectorAuthAppInstallation[] {
  return authSchema.methods.filter(
    (method): method is ConnectorAuthAppInstallation => method.type === 'app_installation'
  );
}

/**
 * Whether the connector's PRIMARY (highest-precedence) auth method is
 * `app_installation` — i.e. the first declared method that actually carries
 * credentials (`none` is a no-op and skipped). When true, a connection for this
 * connector is meant to be created ONLY by the App install callback (which sets
 * `config.installation_ref`); a direct create with no `installation_ref` would be
 * a dead, unbound connection. Connector-agnostic (keys on the method type, not
 * on `github`) so it covers any future app_installation connector.
 */
export function isPrimaryAuthMethodAppInstallation(
  authSchema: ConnectorAuthSchema
): boolean {
  const primary = authSchema.methods.find((method) => method.type !== 'none');
  return primary?.type === 'app_installation';
}
