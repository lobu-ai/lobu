import { sourceReadRecoveryAllowed } from "../authz/operation-run-policy";
import { createHash, randomUUID } from "node:crypto";
import { BrowserInterruptionError, type BrowserRecovery } from "@lobu/core";
import type { AuthzScope } from "../authz/scope";
import {
  browserBindingSnapshot,
  connectionBrowserResource,
} from "../connectors/browser-resource";
import { getDb, type DbClient } from "../db/client";
import { stableJson } from "../utils/insert-event";

const BROWSER_RECOVERY_KEY = "browser_recovery";
export const SOURCE_BROWSER_RETENTION_MS = 5 * 60_000;
const RECOVERY_OBSERVATIONS = new Set(["screenshot", "get_accessibility_tree"]);
const RECOVERY_ACTIONS = new Set(["click_ref", "focus_tab"]);
type BrowserResource = NonNullable<
  Awaited<ReturnType<typeof connectionBrowserResource>>
>;
interface SourceBrowserLease {
  recovery_id: string;
  run_id: number;
  state: "reading" | "ready" | "consumed" | "closed";
  expires_at: string;
  source_connection_id: number;
  connector_version: string;
  chrome_connection_id?: number;
  request_hash: string;
  origins: string[];
  owner: {
    principal: string | null;
    agent_id: string | null;
    automation_id: number | null;
    flow_id: string | null;
  };
  binding: {
    device_worker_id: string | null;
    auth_profile_id: number | null;
    account_id: string | null;
  };
  tab?: { tab_id: number; target_id: string; window_id: number };
  resumed?: boolean;
}
const recoveryUnavailable = (message: string) =>
  new BrowserInterruptionError("recovery_unavailable", message);
export function sourceRecoveryHash(request: Record<string, unknown>): string {
  // Key order inside sort/window/match is caller-controlled, so hash a stable form.
  // No source content or credentials are persisted.
  return createHash("sha256").update(stableJson(request)).digest("hex");
}
function matchesBrowserResource(
  lease: SourceBrowserLease,
  resource: BrowserResource,
): boolean {
  const binding = browserBindingSnapshot(resource);
  return (
    lease.binding.device_worker_id === binding.device_worker_id &&
    lease.binding.auth_profile_id === binding.auth_profile_id &&
    lease.binding.account_id === binding.account_id &&
    JSON.stringify(lease.origins) ===
      JSON.stringify([...resource.requirement.origins].sort())
  );
}
// The full ID is compared exactly against the stored lease, so only the run
// prefix needs validating here.
function runIdFromRecovery(id: string): number {
  const dot = id.indexOf(".");
  const runId = Number(id.slice(0, dot));
  if (dot < 1 || !Number.isSafeInteger(runId) || runId < 1)
    throw recoveryUnavailable("Invalid browser recovery ID.");
  return runId;
}
function assertRecoveryOwner(
  lease: SourceBrowserLease,
  scope: AuthzScope,
  automationId?: number | null,
  flowId?: string,
) {
  if (
    lease.owner.principal !== scope.principal ||
    lease.owner.agent_id !== (scope.agentId ?? null) ||
    lease.owner.automation_id !== (automationId ?? null) ||
    lease.owner.flow_id !== (flowId ?? null)
  )
    throw recoveryUnavailable(
      "Browser recovery belongs to a different requester.",
    );
}
/** Loads a ready, unexpired recovery lease by its public ID. */
async function readRecovery(
  id: string,
  org: string,
  sql: DbClient,
): Promise<SourceBrowserLease> {
  // A cancelled/timed-out source can keep metadata for expiry cleanup, but that
  // metadata must not authorize a continuation or browser observations.
  const [row] =
    await sql`SELECT run_metadata FROM runs WHERE id = ${runIdFromRecovery(id)} AND organization_id = ${org}
      AND status = 'failed'`;
  const lease = row?.run_metadata?.[BROWSER_RECOVERY_KEY] as
    | SourceBrowserLease
    | undefined;
  if (
    !lease ||
    lease.recovery_id !== id ||
    lease.state !== "ready" ||
    !lease.tab ||
    !Number.isFinite(Date.parse(lease.expires_at)) ||
    Date.parse(lease.expires_at) <= Date.now()
  ) {
    throw recoveryUnavailable(
      "Browser recovery is expired, consumed, closed, or unavailable. Start a new authorized read after human recovery.",
    );
  }
  return lease;
}
async function saveLease(
  lease: SourceBrowserLease,
  org: string,
  sql: DbClient,
) {
  await sql`UPDATE runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${sql.json({ [BROWSER_RECOVERY_KEY]: lease })}
    WHERE id = ${lease.run_id} AND organization_id = ${org}`;
}
/** One existing profile row serializes readers across replicas. No process-local lease authority. */
export async function claimSourceBrowser(
  params: {
    runId: number;
    connectionId: number;
    version: string | null;
    requestHash: string;
    scope: AuthzScope;
    automationId?: number | null;
    flowId?: string;
    deadlineAt: number;
    recoveryId?: string;
  },
  sql: DbClient,
): Promise<boolean> {
  const { scope } = params;
  const resource = await connectionBrowserResource(
    scope.organizationId,
    params.connectionId,
    params.version,
    sql,
  );
  if (
    !params.version ||
    !resource?.supportsRecovery ||
    !resource.live ||
    !resource.authProfileId ||
    !resource.accountId ||
    resource.status !== "active" ||
    resource.profileStatus !== "active"
  ) {
    if (params.recoveryId)
      throw recoveryUnavailable(
        "This browser does not support exact-tab recovery.",
      );
    return false;
  }
  const [profile] =
    await sql`SELECT metadata FROM auth_profiles WHERE id = ${resource.authProfileId}
    AND organization_id = ${scope.organizationId} FOR UPDATE`;
  const held = profile?.metadata?.[BROWSER_RECOVERY_KEY] as
    | { run_id: number; expires_at: string }
    | undefined;
  let previous: SourceBrowserLease | undefined;
  if (params.recoveryId) {
    previous = await readRecovery(params.recoveryId, scope.organizationId, sql);
    assertRecoveryOwner(previous, scope, params.automationId, params.flowId);
    if (
      previous.connector_version !== params.version ||
      previous.source_connection_id !== params.connectionId ||
      previous.request_hash !== params.requestHash ||
      !matchesBrowserResource(previous, resource) ||
      held?.run_id !== previous.run_id
    ) {
      throw recoveryUnavailable(
        "Recovery source request, account, or browser binding changed.",
      );
    }
  } else if (held && Date.parse(held.expires_at) > Date.now()) {
    throw recoveryUnavailable(
      "This browser account already has an active read or recovery. Finish that work first.",
    );
  }
  const lease: SourceBrowserLease = {
    recovery_id: previous?.recovery_id ?? `${params.runId}.${randomUUID()}`,
    run_id: params.runId,
    state: "reading",
    expires_at: new Date(params.deadlineAt).toISOString(),
    source_connection_id: params.connectionId,
    connector_version: params.version,
    request_hash: params.requestHash,
    origins: [...resource.requirement.origins].sort(),
    owner: {
      principal: scope.principal,
      agent_id: scope.agentId ?? null,
      automation_id: params.automationId ?? null,
      flow_id: params.flowId ?? null,
    },
    binding: browserBindingSnapshot(resource),
    ...(previous ? { tab: previous.tab, resumed: true } : {}),
  };
  if (previous)
    await saveLease(
      { ...previous, state: "consumed" },
      scope.organizationId,
      sql,
    );
  await sql`UPDATE auth_profiles SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({ [BROWSER_RECOVERY_KEY]: { run_id: lease.run_id, expires_at: lease.expires_at } })}
    WHERE id = ${resource.authProfileId} AND organization_id = ${scope.organizationId}`;
  await saveLease(lease, scope.organizationId, sql);
  return true;
}
export async function sourceBrowserLease(
  org: string,
  runId: number,
  sql: DbClient = getDb(),
): Promise<SourceBrowserLease | undefined> {
  const [row] =
    await sql`SELECT run_metadata FROM runs WHERE id = ${runId} AND organization_id = ${org}`;
  return row?.run_metadata?.[BROWSER_RECOVERY_KEY];
}
/** True while another run's unexpired read or recovery holds this browser account. */
export async function browserAccountHeldByOtherRun(
  org: string,
  authProfileId: number,
  runId: number,
): Promise<boolean> {
  const [profile] =
    await getDb()`SELECT metadata FROM auth_profiles WHERE id = ${authProfileId} AND organization_id = ${org}`;
  const held = profile?.metadata?.[BROWSER_RECOVERY_KEY];
  return (
    !!held && Date.parse(held.expires_at) > Date.now() && held.run_id !== runId
  );
}
export async function saveSourceBrowserTab(
  org: string,
  runId: number,
  output: Record<string, unknown>,
  chromeConnectionId: number,
) {
  const tab = output.browser_tab as SourceBrowserLease["tab"];
  if (
    !tab ||
    !Number.isInteger(tab.tab_id) ||
    typeof tab.target_id !== "string" ||
    !Number.isInteger(tab.window_id)
  )
    return;
  const sql = getDb();
  await sql.begin(async (tx) => {
    const [row] =
      await tx`SELECT run_metadata FROM runs WHERE id = ${runId} AND organization_id = ${org} AND status = 'running' FOR UPDATE`;
    const lease = row?.run_metadata?.[BROWSER_RECOVERY_KEY] as
      | SourceBrowserLease
      | undefined;
    if (!lease) return;
    if (
      lease.tab &&
      Object.entries(tab).some(
        ([key, value]) => lease.tab![key as keyof typeof tab] !== value,
      )
    )
      throw recoveryUnavailable("The source browser target changed.");
    await saveLease(
      { ...lease, tab, chrome_connection_id: chromeConnectionId },
      org,
      tx,
    );
  });
}
export type SourceBrowserCleanup =
  | { kind: "retained"; expiresAt: string }
  | { kind: "closed" | "unacknowledged" };

export function canRetainSourceBrowser(lease: SourceBrowserLease): boolean {
  return (
    !!lease.owner.flow_id &&
    !lease.resumed &&
    !!lease.tab &&
    !!lease.chrome_connection_id
  );
}

export async function finishSourceBrowser(
  org: string,
  runId: number,
  cleanup: SourceBrowserCleanup,
): Promise<BrowserRecovery | undefined> {
  const sql = getDb();
  return sql.begin(async (tx) => {
    const initial = await sourceBrowserLease(org, runId, tx);
    if (!initial) return undefined;
    // Match claimSourceBrowser's profile-before-run lock order. A dispatch may
    // save its exact tab while we wait, so reload the lease under the run lock.
    const [profile] =
      await tx`SELECT metadata FROM auth_profiles WHERE id = ${initial.binding.auth_profile_id}
      AND organization_id = ${org} FOR UPDATE`;
    if (profile?.metadata?.[BROWSER_RECOVERY_KEY]?.run_id !== runId)
      throw recoveryUnavailable("Browser recovery ownership changed.");
    const [row] =
      await tx`SELECT run_metadata FROM runs WHERE id = ${runId} AND organization_id = ${org} FOR UPDATE`;
    const lease = row?.run_metadata?.[BROWSER_RECOVERY_KEY] as
      | SourceBrowserLease
      | undefined;
    if (
      !lease ||
      lease.state !== "reading" ||
      lease.binding.auth_profile_id !== initial.binding.auth_profile_id
    )
      throw recoveryUnavailable("Browser recovery lease changed.");
    const ready =
      cleanup.kind === "retained" &&
      Date.parse(cleanup.expiresAt) > Date.now() &&
      canRetainSourceBrowser(lease);
    const hold = ready || (!!lease.tab && cleanup.kind === "unacknowledged");
    const expires_at = !hold
      ? lease.expires_at
      : cleanup.kind === "retained"
        ? cleanup.expiresAt
        : new Date(Date.now() + SOURCE_BROWSER_RETENTION_MS).toISOString();
    await saveLease(
      { ...lease, expires_at, state: ready ? "ready" : "closed" },
      org,
      tx,
    );
    await tx`UPDATE auth_profiles SET metadata = ${
      hold
        ? tx`COALESCE(metadata, '{}'::jsonb) || ${tx.json({ [BROWSER_RECOVERY_KEY]: { run_id: runId, expires_at } })}`
        : tx`COALESCE(metadata, '{}'::jsonb) - ${BROWSER_RECOVERY_KEY}`
    }
      WHERE id = ${lease.binding.auth_profile_id} AND organization_id = ${org}`;
    if (ready)
      return {
        recovery_id: lease.recovery_id,
        expires_at,
        ...lease.tab!,
        device_worker_id: lease.binding.device_worker_id!,
        chrome_connection_id: lease.chrome_connection_id!,
      };
    return undefined;
  });
}
/** Server-stamped descriptor. Raw public recovery/observation IDs confer no device authority. */
export function browserRecoveryControl(
  lease: SourceBrowserLease,
  mode: "read" | "retain" | "observe" | "act",
  expiresAt = lease.expires_at,
) {
  return {
    ...lease.tab,
    recovery_id: lease.recovery_id,
    owner_run_id: lease.run_id,
    mode,
    expires_at: expiresAt,
    resumed: lease.resumed === true,
  };
}
export async function authorizeRecoveryAction(params: {
  scope: AuthzScope;
  automationId?: number | null;
  flowId?: string;
  connectionId: number;
  action: string;
  input: Record<string, unknown>;
}) {
  if (params.input.recovery_id === undefined) return undefined;
  if (typeof params.input.recovery_id !== "string")
    throw recoveryUnavailable("Invalid recovery ID.");
  const lease = await readRecovery(
    params.input.recovery_id,
    params.scope.organizationId,
    getDb(),
  );
  assertRecoveryOwner(lease, params.scope, params.automationId, params.flowId);
  if (
    params.connectionId !== lease.chrome_connection_id ||
    params.input.tab_id !== lease.tab?.tab_id
  )
    throw recoveryUnavailable(
      "Recovery must use its exact Chrome connection and tab.",
    );
  const observe = RECOVERY_OBSERVATIONS.has(params.action);
  if (
    !observe &&
    (!RECOVERY_ACTIONS.has(params.action) ||
      typeof params.input.observation_id !== "string")
  ) {
    throw recoveryUnavailable(
      "Recovery permits bounded observations and actions with a fresh observation ID; otherwise ask the browser owner for help.",
    );
  }
  await validateRecoveryBinding(lease, params.scope.organizationId);
  return browserRecoveryControl(lease, observe ? "observe" : "act");
}
async function validateRecoveryBinding(lease: SourceBrowserLease, org: string) {
  if (!(await sourceReadRecoveryAllowed(org, lease.run_id)))
    throw recoveryUnavailable(
      "The source is no longer readable by this requester.",
    );
  const resource = await connectionBrowserResource(
    org,
    lease.source_connection_id,
    lease.connector_version,
  );
  if (
    !resource?.supportsRecovery ||
    !resource.live ||
    resource.status !== "active" ||
    resource.profileStatus !== "active" ||
    !matchesBrowserResource(lease, resource)
  )
    throw recoveryUnavailable(
      "Recovery browser account binding is no longer active.",
    );
  const [chrome] =
    await getDb()`SELECT device_worker_id FROM connections WHERE id = ${lease.chrome_connection_id!}
    AND organization_id = ${org} AND connector_key = 'chrome' AND status = 'active' AND deleted_at IS NULL`;
  if (chrome?.device_worker_id !== lease.binding.device_worker_id)
    throw recoveryUnavailable(
      "Recovery Chrome connection moved to another device.",
    );
}
export async function validateRecoveryDispatch(
  org: string,
  descriptor: Record<string, unknown>,
) {
  if (descriptor.mode !== "observe" && descriptor.mode !== "act") return;
  const lease = await readRecovery(
    String(descriptor.recovery_id),
    org,
    getDb(),
  );
  if (lease.run_id !== descriptor.owner_run_id)
    throw recoveryUnavailable("Recovery owner changed before dispatch.");
  await validateRecoveryBinding(lease, org);
}
