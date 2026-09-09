/**
 * Connector-contributed agent tooling — deployment-time resolution.
 *
 * A connection whose connector declares `agentTooling` contributes three things
 * to the agent's sandbox: nix packages (so the CLI is on PATH), env vars (so it
 * is authenticated), and egress domains (so it can reach the provider). This
 * module turns the org's connection rows into that contribution; the deployment
 * manager applies it to the worker environment.
 *
 * The declaration is read from `connector_definitions.agent_tooling` — the
 * database, never connector code. Nothing here loads or executes a connector.
 */

import { createHash } from "node:crypto";
import {
  createLogger,
  isValidDomainPattern,
  normalizeDomainPattern,
  parseJsonObject,
} from "@lobu/core";
import type {
  ConnectorAgentTooling,
  ConnectorAgentToolingEnv,
} from "@lobu/connector-sdk";
import { nixPackageAttrRef } from "@lobu/connector-sdk/nix-package";
import { resolveBundledAgentToolingMetadata } from "../../utils/connector-catalog";
import { isCloudMode } from "../../utils/cloud-mode";
import { getDb } from "../../db/client.js";
import {
  getAppInstallationAuthMethods,
  normalizeConnectorAuthSchema,
} from "../../utils/connector-auth.js";
import type {
  CredentialLeaseRegistry,
  LeaseScopeHints,
  LeaseSubject,
} from "./credential-lease.js";

const logger = createLogger("agent-tooling-resolver");

/**
 * A lease minted with less life than this is reported, because a provider
 * handing out a nearly-dead credential is a fault worth a log line even when
 * the command it is attached to will finish long before it lapses.
 *
 * No longer a recycle trigger: it mirrored the subprocess lane's
 * `DeploymentManager.LEASE_RECYCLE_MARGIN_MS`, which decided when to retire a
 * warm worker that had read its env at startup. Nothing is warm now, so this
 * is a reporting threshold only.
 */
const SHORT_LEASE_WARN_MS = 5 * 60_000;

function isShortLivedLease(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() <= SHORT_LEASE_WARN_MS;
}

/** The sandbox contribution of every eligible connection, already unioned. */
export interface ResolvedAgentTooling {
  /** Nix packages to union into the agent's `nixConfig.packages`. */
  packages: string[];
  /** Env vars to set in the worker environment. */
  env: Record<string, string>;
  /** Domains to grant on the worker's egress allowlist. */
  domains: string[];
  /**
   * Earliest expiry across every minted lease, or null when nothing minted (or
   * no provider reported one). The deployment stores this so the warm path can
   * recycle the worker before its credential lapses.
   */
  leaseExpiresAt: Date | null;
  /** See {@link ResolvedAgentToolingDeclaration.fingerprint}. */
  fingerprint: string;
}

/**
 * The contribution of an org that has no eligible connections: nothing to put
 * on PATH, nothing to authenticate with, and the zero-row fingerprint.
 *
 * Exported because a payload with no org is the same *known* state, not an
 * ambiguous failure: with no org there are no connection rows to read, so the
 * empty digest is the correct answer rather than a guess.
 */
export const EMPTY_AGENT_TOOLING: ResolvedAgentTooling = {
  packages: [],
  env: {},
  domains: [],
  leaseExpiresAt: null,
  // Must equal what `resolveAgentToolingDeclaration` digests for zero rows, or
  // an org with no tooling connections would look "changed" on every turn and
  // recycle its worker forever.
  fingerprint: toolingFingerprint([]),
};

/**
 * Env var names a connector may never contribute. A consumer that builds a base
 * environment and merges a contribution over it would let an unguarded name
 * REPLACE gateway-owned runtime state:
 * `WORKER_TOKEN` is the signed gateway credential (a contributed one would also
 * inherit the lease exemption from placeholder injection, so the worker would
 * authenticate with an attacker-chosen token), `HTTP_PROXY`/`HTTPS_PROXY`/
 * `NO_PROXY` route egress through the filtering proxy, and `PATH`/`HOME`/
 * `WORKSPACE_DIR`/`DISPATCHER_URL`/`NODE_OPTIONS`/`BUN_OPTIONS`/`NIX_*` decide
 * what code the sandbox executes and where.
 *
 * Enforced here rather than only at the merge site so a hostile declaration
 * never reaches an env map at all.
 */
const RESERVED_ENV_NAMES = new Set([
  "WORKER_TOKEN",
  "DISPATCHER_URL",
  "WORKSPACE_DIR",
  "PATH",
  "HOME",
  "NODE_ENV",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
]);

/**
 * True when a connector must not be allowed to set `name`. Compared
 * case-insensitively: `http_proxy` is honored by curl/git exactly like
 * `HTTP_PROXY`, so reserving only one spelling would reserve nothing.
 */
export function isReservedAgentToolingEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  // The whole NIX_ family steers package resolution for the sandbox.
  return RESERVED_ENV_NAMES.has(upper) || upper.startsWith("NIX_");
}

/** A connection row joined to its connector's declaration. */
interface ToolingConnectionRow {
  connection_id: string | number;
  connector_key: string;
  config: Record<string, unknown> | null;
  agent_tooling: unknown;
  auth_schema: unknown;
  /** Install state, fingerprint-only — see the query comment. */
  installation_status: string | null;
  installation_provider: string | null;
  installation_provider_instance: string | null;
  installation_app_id: string | null;
  installation_tenant: string | null;
  definition_version: string;
}

/**
 * Validate a persisted `agent_tooling` value. The column is jsonb written by the
 * connector install path, so it is structurally untrusted at read time — a
 * malformed declaration must contribute nothing rather than inject a
 * non-string into the worker environment or the nix command line.
 *
 * Returns null when the value carries no usable contribution.
 */
export function parseAgentTooling(value: unknown): ConnectorAgentTooling | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const packages = Array.isArray((raw.nix as Record<string, unknown>)?.packages)
    ? ((raw.nix as Record<string, unknown>).packages as unknown[]).filter(
        (pkg): pkg is string => {
          if (typeof pkg !== "string") return false;
          try {
            nixPackageAttrRef(pkg);
            return true;
          } catch {
            return false;
          }
        }
      )
    : [];

  const env: ConnectorAgentToolingEnv[] = Array.isArray(raw.env)
    ? (raw.env as unknown[]).flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const { name, credential } = entry as Record<string, unknown>;
        if (
          typeof name !== "string" ||
          name === "__proto__" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
          isReservedAgentToolingEnvName(name)
        ) {
          return [];
        }
        // 'lease' is the only tier. Anything else is dropped, not defaulted:
        // the worker egress proxy raw-tunnels HTTPS CONNECT traffic, so an
        // opaque placeholder in a CLI env var would be sent to the provider
        // verbatim — there is no relay that could swap it inside TLS. A static
        // credential tier can only exist once a credential-aware relay does.
        if (credential !== "lease") return [];
        return [{ name, credential }];
      })
    : [];

  // A domain lands straight on the worker's deny-by-default egress allowlist,
  // so it gets the same shape check the operator-facing settings API applies —
  // `"*"`, `"*.com"`, `"https://evil.com/x"` and `"a.com, b.com"` must widen
  // egress by nothing rather than by everything.
  //
  // Accepted entries are normalized to the form grants are stored and matched
  // in, so a declaration spelling it `GitHub.COM` or `*.GitHub.COM` joins the
  // existing `github.com`/`.github.com` grant instead of adding a second row
  // for the same host — and the fingerprint (which digests this declaration)
  // stops treating a re-cased spelling as a tooling change.
  const domains = Array.isArray(raw.domains)
    ? (raw.domains as unknown[])
        .filter(isValidDomainPattern)
        .map(normalizeDomainPattern)
    : [];

  if (packages.length === 0 && env.length === 0 && domains.length === 0) {
    return null;
  }
  return {
    ...(packages.length > 0 ? { nix: { packages } } : {}),
    ...(env.length > 0 ? { env } : {}),
    ...(domains.length > 0 ? { domains } : {}),
  };
}

async function loadToolingConnections(
  organizationId: string
): Promise<ToolingConnectionRow[]> {
  const sql = getDb();
  return (await sql`
    SELECT c.id AS connection_id,
           c.connector_key,
           c.config,
           cd.agent_tooling,
           cd.auth_schema,
           cd.version AS definition_version,
           -- Lease AUTHORITY, joined only for the fingerprint: revoking or
           -- transferring an installation must invalidate a warm worker that
           -- is still holding a token minted under it. These fields do not
           -- change the declared packages/domains, so nothing else reads them.
           ai.status AS installation_status,
           ai.provider AS installation_provider,
           ai.provider_instance AS installation_provider_instance,
           ai.provider_app_id AS installation_app_id,
           ai.external_tenant_id AS installation_tenant
    FROM connections c
    JOIN connector_definitions cd
      ON cd.key = c.connector_key
     AND cd.organization_id = c.organization_id
     AND cd.status = 'active'
    LEFT JOIN app_installations ai
      -- connections.config is a jsonb blob written by the install path, not a
      -- typed column, so a malformed installation_ref is representable. A bare
      -- ::bigint cast can raise on non-digits OR an out-of-range digit string,
      -- aborting this whole query; resolution failures PROPAGATE to the
      -- enqueue/build/dispatch callers (fail closed), so one malformed row
      -- would fail every turn in the org. Normalize leading zeroes and cast
      -- only a positive safe integer; anything else joins to NULL like an
      -- absent ref.
      ON ai.id = (
           CASE
             WHEN (
                c.config->>'installation_ref' ~ '^0*[1-9][0-9]{0,14}$'
                OR (
                  c.config->>'installation_ref' ~ '^0*[1-9][0-9]{15}$'
                  AND ltrim(c.config->>'installation_ref', '0') <= '9007199254740991'
                )
              )
               THEN ltrim(c.config->>'installation_ref', '0')::bigint
           END
         )
     AND ai.organization_id = c.organization_id
    WHERE c.organization_id = ${organizationId}
      AND c.deleted_at IS NULL
      AND c.status = 'active'
      AND cd.agent_tooling IS NOT NULL
    ORDER BY c.id
  `) as unknown as ToolingConnectionRow[];
}

/**
 * One connection's contribution to the tooling fingerprint: which connection,
 * which installation, and what it declares. Shared by both resolvers so the
 * cold and warm paths can never disagree about whether tooling changed.
 */
function toolingIdentityEntry(
  row: ToolingConnectionRow,
  tooling: ConnectorAgentTooling | null,
  authSchema: unknown,
): string {
  const installationRef = parseJsonObject(row.config).installation_ref;
  const method = getAppInstallationAuthMethods(
    normalizeConnectorAuthSchema(authSchema)
  )[0];
  return JSON.stringify([
    String(row.connection_id),
    row.connector_key,
    installationRef == null ? null : String(installationRef),
    method
      ? [
          method.provider,
          method.providerInstance ?? null,
          method.appIdKey ?? null,
          method.privateKeyKey ?? null,
        ]
      : null,
    row.installation_status,
    row.installation_provider,
    row.installation_provider_instance,
    row.installation_app_id,
    row.installation_tenant,
    tooling,
  ]);
}

type TrustedToolingMetadata = {
  tooling: ConnectorAgentTooling | null;
  authSchema: unknown;
};

async function resolveToolingMetadata(
  row: ToolingConnectionRow,
): Promise<TrustedToolingMetadata | null> {
  if (!isCloudMode()) {
    return { tooling: parseAgentTooling(row.agent_tooling), authSchema: row.auth_schema };
  }

  // Cloud never trusts connector_definitions JSON: the packages, domains and
  // auth method an agent runs under come from the image file itself, resolved
  // below. The stored declaration is never a fallback.
  //
  // Resolution is pinned to an exact key@version: a near-miss here would widen
  // a worker's egress allowlist to another version's domains. Contributing
  // nothing until the definition re-syncs is the safe direction; a wrong
  // declaration is not.
  try {
    const metadata = await resolveBundledAgentToolingMetadata(
      row.connector_key,
      row.definition_version,
    );
    if (!metadata) return null;
    return { tooling: metadata.agentTooling, authSchema: metadata.authSchema };
  } catch (error) {
    logger.warn(
      { connector_key: row.connector_key, version: row.definition_version, error },
      "Ignoring Cloud agent tooling after bundled metadata resolution failed",
    );
    return null;
  }
}

/** Digest the per-connection identity entries into a stable fingerprint. */
function toolingFingerprint(entries: string[]): string {
  return createHash("sha256")
    .update(entries.join("\n"))
    .digest("hex")
    .slice(0, 32);
}

/** The declaration-only half of the contribution: no credential is minted. */
export interface ResolvedAgentToolingDeclaration {
  packages: string[];
  domains: string[];
  /**
   * Stable digest of WHICH connections contribute and WHAT they declare —
   * connection id, its `installation_ref`, and the validated declaration.
   *
   * A worker reads its env once at process start, so a warm deployment keeps
   * whatever tooling it was born with. Comparing this across turns is how the
   * warm path notices that a connection was added, removed, or repointed at a
   * different installation, and recycles instead of serving an agent that is
   * missing a CLI or still authenticating as the previous identity.
   */
  fingerprint: string;
}

/**
 * Resolve the declaration-only contribution before minting a per-run worker
 * token. Credentials remain deployment-only and never enter the queue payload.
 *
 * Packages are returned alongside domains because the warm path reconciles
 * egress grants against this payload: `syncNetworkConfigGrants` derives the nix
 * binary-cache hosts from `nixConfig.packages`, so a caller that folded domains
 * but not packages would revoke the substituter hosts that the contributed
 * packages need — including out from under an in-flight first-deploy download.
 */
export async function resolveAgentToolingDeclaration(params: {
  organizationId: string;
}): Promise<ResolvedAgentToolingDeclaration> {
  const packages = new Set<string>();
  const domains = new Set<string>();
  const identity: string[] = [];
  // `loadToolingConnections` is ORDER BY c.id, so the digest is stable across
  // turns and replicas without sorting here.
  for (const row of await loadToolingConnections(params.organizationId)) {
    const trusted = await resolveToolingMetadata(row);
    if (!trusted) continue;
    const { tooling, authSchema } = trusted;
    for (const pkg of tooling?.nix?.packages ?? []) packages.add(pkg);
    for (const domain of tooling?.domains ?? []) domains.add(domain);

    // Identity, not just capability: two connections can declare identical
    // tooling while pointing at different installations, and swapping between
    // them changes WHO the agent is. The installation ref therefore has to be
    // in the digest even though it contributes nothing to packages/domains.
    identity.push(toolingIdentityEntry(row, tooling, authSchema));
  }
  // NOTE: packages and domains only — deliberately NO env, and no lease is
  // minted here. This path runs at DISPATCH, to decide what the sandbox needs
  // on PATH and which hosts it may reach; a credential minted at dispatch
  // would start ageing before the agent ran its first command.
  //
  // Leases are minted per command instead, by `resolveLeasedExecEnv` on the
  // exec route, which calls `resolveAgentTooling` below. Keeping the two apart
  // is what lets the declaration be cached per turn while the credential stays
  // as young as the command that uses it.
  return {
    packages: [...packages],
    domains: [...domains],
    fingerprint: toolingFingerprint(identity),
  };
}

/**
 * Resolve every eligible connection's sandbox contribution for one deployment,
 * minting the short-lived provider leases its env vars name.
 *
 * Called per sandbox command by `resolveLeasedExecEnv` (the exec route), which
 * is the delivery boundary: the env it returns is attached to that one command
 * gateway-side and never round-trips through the worker.
 *
 * The `leaseExpiresAt` it reports is vestigial on this path. It existed so a
 * warm subprocess worker could be recycled before the credential it read at
 * startup lapsed; a per-command mint has no such window. It stays on the
 * result because the value is a true fact about the leases minted, and the
 * caller is free to ignore it.
 *
 * Eligibility (v1): every ACTIVE, non-deleted connection in the agent's org
 * whose connector declares `agent_tooling`. `connections.agent_id` is not an
 * attachment boundary for data connectors; it is the fallback agent for chat
 * connections, so it must not scope this resolver.
 *
 * Failure is always "contribute nothing": a connection whose lease cannot be
 * minted drops its env var and the deployment proceeds. A sandbox with no
 * GH_TOKEN reports itself unauthenticated; a sandbox that failed to deploy tells
 * the user nothing.
 */
export async function resolveAgentTooling(params: {
  agentId: string;
  organizationId: string;
  deploymentName: string;
  leaseRegistry: CredentialLeaseRegistry;
  runId?: number;
}): Promise<ResolvedAgentTooling> {
  const { agentId, organizationId } = params;
  const rows = await loadToolingConnections(organizationId);

  if (rows.length === 0) return EMPTY_AGENT_TOOLING;

  const packages = new Set<string>();
  const domains = new Set<string>();
  const env: Record<string, string> = {};
  /** env name → the connection whose lease is in `env`, for collision logging. */
  const envSource = new Map<string, number>();
  const identity: string[] = [];
  let leaseExpiresAt: Date | null = null;

  for (const row of rows) {
    const trusted = await resolveToolingMetadata(row);
    if (!trusted) continue;
    const { tooling, authSchema } = trusted;
    // Recorded for every trusted row, including ones that contribute nothing:
    // removing a malformed connection still changes the org's tooling identity.
    // Cloud-untrusted rows are skipped on the declaration side too, so the two
    // fingerprints stay in agreement.
    identity.push(toolingIdentityEntry(row, tooling, authSchema));
    if (!tooling) {
      // Covers both a structurally malformed value and one whose every entry
      // was filtered out (an unknown credential tier, an invalid package name,
      // a domain that would have widened egress). Either way it contributes
      // nothing, and the connector key is what identifies which to go look at.
      logger.warn(
        { connector_key: row.connector_key },
        "Ignoring agent_tooling declaration with no usable contribution"
      );
      continue;
    }

    // Packages and domains are declaration-only: they describe what the CLI
    // needs to run at all, so they apply whether or not the credential resolves.
    // A `gh` on PATH that reports "not logged in" is a better failure than a
    // missing binary.
    for (const pkg of tooling.nix?.packages ?? []) packages.add(pkg);
    for (const domain of tooling.domains ?? []) domains.add(domain);

    if (!tooling.env?.length) continue;

    const connectionId = Number(row.connection_id);
    const scope: LeaseScopeHints = {
      agentId,
      deploymentName: params.deploymentName,
      runId: params.runId,
    };

    for (const entry of tooling.env) {
      // One env var, one credential: a sandbox has a single $GH_TOKEN, so when
      // two connections of the same connector (two GitHub installations, say)
      // both claim it, someone loses. Lowest connection id wins — arbitrary,
      // but STABLE, so the agent does not silently swap identity between turns
      // as rows are added.
      //
      // This is a real limitation, not a resolved case: the agent can only see
      // what the winning installation can see, so a repo that lives only under
      // the other one is invisible to it. Logged at WARN with both connection
      // ids because the symptom an operator hits ("gh says 404 on a repo I can
      // see in the browser") is otherwise undiagnosable from the sandbox.
      // Fixing it properly means per-connection env naming or repo-aware
      // selection, which is a contract change, not a patch.
      // Own properties only: `env` is a plain object literal, so `in` would
      // report `toString`/`constructor`/`valueOf` as already claimed before
      // anything is minted — all of them pass the identifier check and none is
      // reserved, so such an entry would be dropped with a bogus collision WARN
      // naming an undefined `using_connection_id`.
      if (Object.hasOwn(env, entry.name)) {
        logger.warn(
          {
            env_name: entry.name,
            connector_key: row.connector_key,
            connection_id: connectionId,
            using_connection_id: envSource.get(entry.name),
            organization_id: organizationId,
            agent_id: agentId,
          },
          "Two connections claim the same agent-tooling env var; keeping the lower connection id. Repositories reachable only by the skipped connection will not be visible to the agent."
        );
        continue;
      }

      const subject = buildLeaseSubject(
        row,
        connectionId,
        organizationId,
        authSchema,
      );
      const lease = await params.leaseRegistry.mintFor(subject, scope);
      if (!lease) continue;
      env[entry.name] = lease.token;
      envSource.set(entry.name, connectionId);
      // Earliest wins: the reported expiry is the FIRST credential to lapse,
      // not the last.
      //
      // A freshly minted token that is already near expiry means the provider
      // is issuing short-lived credentials (clock skew, or a fault). It is
      // still delivered — a short life beats none, and the command it is
      // attached to runs now.
      if (lease.expiresAt && isShortLivedLease(lease.expiresAt)) {
        logger.warn(
          {
            env_name: entry.name,
            connector_key: row.connector_key,
            connection_id: connectionId,
            expires_at: lease.expiresAt.toISOString(),
          },
          "Provider issued a lease that is already near expiry; the sandbox may lose this credential mid-conversation"
        );
      }
      if (
        lease.expiresAt &&
        (!leaseExpiresAt || lease.expiresAt < leaseExpiresAt)
      ) {
        leaseExpiresAt = lease.expiresAt;
      }
    }
  }

  return {
    packages: [...packages],
    env,
    domains: [...domains],
    leaseExpiresAt,
    fingerprint: toolingFingerprint(identity),
  };
}

/**
 * Build the lease subject from a connection row: its App-installation binding
 * (`config.installation_ref`) plus the connector method's declared provider and
 * gateway env-var NAMES. Never reads a credential.
 */
function buildLeaseSubject(
  row: ToolingConnectionRow,
  connectionId: number,
  organizationId: string,
  trustedAuthSchema: unknown,
): LeaseSubject {
  const config = parseJsonObject(row.config);
  const rawRef = config.installation_ref;
  const parsedRef =
    typeof rawRef === "number"
      ? rawRef
      : typeof rawRef === "string" && /^[0-9]+$/.test(rawRef)
        ? Number(rawRef)
        : null;
  const installationRef =
    parsedRef != null && Number.isSafeInteger(parsedRef) && parsedRef > 0
      ? parsedRef
      : null;

  const method = getAppInstallationAuthMethods(
    normalizeConnectorAuthSchema(trustedAuthSchema)
  )[0];

  return {
    connectionId,
    organizationId,
    connectorKey: row.connector_key,
    installationRef,
    provider: method?.provider ?? null,
    providerInstance: method?.providerInstance ?? null,
    appIdKey: method?.appIdKey ?? null,
    privateKeyKey: method?.privateKeyKey ?? null,
  };
}
