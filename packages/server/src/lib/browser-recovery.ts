import { sourceReadRecoveryAllowed } from '../authz/operation-run-policy';
import { createHash, randomUUID } from 'node:crypto';
import { BrowserInterruptionError, type BrowserRecovery } from '@lobu/core';
import type { AuthzScope } from '../authz/scope';
import { browserBindingSnapshot, connectionBrowserResource } from '../connectors/browser-resource';
import { getDb, type DbClient } from '../db/client';

export const BROWSER_RECOVERY_KEY = 'browser_recovery';
const TTL_MS = 5 * 60_000;
const RECOVERY_OBSERVATIONS = new Set(['screenshot', 'get_accessibility_tree']);
const RECOVERY_ACTIONS = new Set(['click_ref', 'focus_tab']);
export interface SourceBrowserLease {
  recovery_id: string;
  run_id: number;
  state: 'reading' | 'ready' | 'consumed' | 'closed';
  expires_at: string;
  source_connection_id: number;
  connector_version: string;
  chrome_connection_id?: number;
  request_hash: string;
  origins: string[];
  owner: { principal: string | null; agent_id: string | null; automation_id: number | null; flow_id: string | null };
  binding: { device_worker_id: string | null; auth_profile_id: number | null; account_id: string | null };
  tab?: { tab_id: number; target_id: string; window_id: number };
  resumed?: boolean;
}
export const recoveryUnavailable = (message: string) => new BrowserInterruptionError('recovery_unavailable', message);
export function sourceRecoveryHash(request: Record<string, unknown>): string {
  // Call sites construct this fixed-key record; no source content or credentials are persisted.
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
function runIdFromRecovery(id: string): number {
  const match = /^([1-9][0-9]*)\.([0-9a-f-]{36})$/.exec(id);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw recoveryUnavailable('Invalid browser recovery ID.');
  return Number(match[1]);
}
export function assertRecoveryOwner(lease: SourceBrowserLease, scope: AuthzScope, automationId?: number | null, flowId?: string) {
  if (lease.owner.principal !== scope.principal || lease.owner.agent_id !== (scope.agentId ?? null)
    || lease.owner.automation_id !== (automationId ?? null) || lease.owner.flow_id !== (flowId ?? null)) throw recoveryUnavailable('Browser recovery belongs to a different requester.');
}
export function assertReadyRecovery(lease: SourceBrowserLease | undefined, id: string, now = Date.now()): asserts lease is SourceBrowserLease {
  if (!lease || lease.recovery_id !== id || lease.state !== 'ready' || !lease.tab
    || !Number.isFinite(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at) <= now) {
    throw recoveryUnavailable('Browser recovery is expired, consumed, closed, or unavailable. Start a new authorized read after human recovery.');
  }
}
async function readRecovery(id: string, org: string, sql: DbClient) {
  const [row] = await sql`SELECT run_metadata FROM runs WHERE id = ${runIdFromRecovery(id)} AND organization_id = ${org}`;
  const lease = row?.run_metadata?.[BROWSER_RECOVERY_KEY] as SourceBrowserLease | undefined;
  assertReadyRecovery(lease, id);
  return lease;
}
async function saveLease(lease: SourceBrowserLease, org: string, sql: DbClient) {
  await sql`UPDATE runs SET run_metadata = COALESCE(run_metadata, '{}'::jsonb) || ${sql.json({ [BROWSER_RECOVERY_KEY]: lease })}
    WHERE id = ${lease.run_id} AND organization_id = ${org}`;
}
/** One existing profile row serializes readers across replicas. No process-local lease authority. */
export async function claimSourceBrowser(params: {
  runId: number; connectionId: number; version: string | null; requestHash: string;
  scope: AuthzScope; automationId?: number | null; flowId?: string; deadlineAt: number; recoveryId?: string;
}, sql: DbClient): Promise<SourceBrowserLease | undefined> {
  const { scope } = params;
  const resource = await connectionBrowserResource(scope.organizationId, params.connectionId, params.version, sql);
  if (!params.version || !resource?.supportsRecovery || !resource.live || !resource.authProfileId || !resource.accountId || resource.status !== 'active' || resource.profileStatus !== 'active') {
    if (params.recoveryId) throw recoveryUnavailable('This browser does not support exact-tab recovery.');
    return undefined;
  }
  const [profile] = await sql`SELECT metadata FROM auth_profiles WHERE id = ${resource.authProfileId}
    AND organization_id = ${scope.organizationId} FOR UPDATE`;
  const held = profile?.metadata?.[BROWSER_RECOVERY_KEY] as { run_id: number; expires_at: string } | undefined;
  let previous: SourceBrowserLease | undefined;
  if (params.recoveryId) {
    previous = await readRecovery(params.recoveryId, scope.organizationId, sql);
    assertRecoveryOwner(previous, scope, params.automationId, params.flowId);
    if (previous.connector_version !== params.version || previous.source_connection_id !== params.connectionId || previous.request_hash !== params.requestHash
      || JSON.stringify([...resource.requirement.origins].sort()) !== JSON.stringify(previous.origins)
      || Object.entries(browserBindingSnapshot(resource)).some(([key, value]) => previous!.binding[key as keyof SourceBrowserLease['binding']] !== value) || held?.run_id !== previous.run_id) {
      throw recoveryUnavailable('Recovery source request, account, or browser binding changed.');
    }
  } else if (held && Date.parse(held.expires_at) > Date.now()) {
    throw recoveryUnavailable('This browser account already has an active read or recovery. Finish that work first.');
  }
  const lease: SourceBrowserLease = {
    recovery_id: previous?.recovery_id ?? `${params.runId}.${randomUUID()}`, run_id: params.runId,
    state: 'reading', expires_at: new Date(params.deadlineAt).toISOString(),
    source_connection_id: params.connectionId, connector_version: params.version, request_hash: params.requestHash, origins: [...resource.requirement.origins].sort(),
    owner: { principal: scope.principal, agent_id: scope.agentId ?? null, automation_id: params.automationId ?? null, flow_id: params.flowId ?? null },
    binding: browserBindingSnapshot(resource), ...(previous ? { tab: previous.tab, resumed: true } : {}),
  };
  if (previous) await saveLease({ ...previous, state: 'consumed' }, scope.organizationId, sql);
  await sql`UPDATE auth_profiles SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({ [BROWSER_RECOVERY_KEY]: { run_id: lease.run_id, expires_at: lease.expires_at } })}
    WHERE id = ${resource.authProfileId} AND organization_id = ${scope.organizationId}`;
  await saveLease(lease, scope.organizationId, sql);
  return lease;
}
export async function sourceBrowserLease(org: string, runId: number, sql: DbClient = getDb()): Promise<SourceBrowserLease | undefined> {
  const [row] = await sql`SELECT run_metadata FROM runs WHERE id = ${runId} AND organization_id = ${org}`;
  return row?.run_metadata?.[BROWSER_RECOVERY_KEY];
}
export async function saveSourceBrowserTab(org: string, runId: number, output: Record<string, unknown>, chromeConnectionId: number) {
  const tab = output.browser_tab as SourceBrowserLease['tab'];
  if (!tab || !Number.isInteger(tab.tab_id) || typeof tab.target_id !== 'string' || !Number.isInteger(tab.window_id)) return;
  const sql = getDb();
  await sql.begin(async tx => {
    const [row] = await tx`SELECT run_metadata FROM runs WHERE id = ${runId} AND organization_id = ${org} AND status = 'running' FOR UPDATE`;
    const lease = row?.run_metadata?.[BROWSER_RECOVERY_KEY] as SourceBrowserLease | undefined;
    if (!lease) return;
    if (lease.tab && Object.entries(tab).some(([key, value]) => lease.tab![key as keyof typeof tab] !== value)) throw recoveryUnavailable('The source browser target changed.');
    await saveLease({ ...lease, tab, chrome_connection_id: chromeConnectionId }, org, tx);
  });
}
export async function finishSourceBrowser(org: string, runId: number, retained: boolean, cleanupAcknowledged = false): Promise<BrowserRecovery | undefined> {
  const sql = getDb();
  return sql.begin(async tx => {
    const initial = await sourceBrowserLease(org, runId, tx);
    if (!initial) return undefined;
    // Match claimSourceBrowser's profile-before-run lock order. A dispatch may
    // save its exact tab while we wait, so reload the lease under the run lock.
    const [profile] = await tx`SELECT metadata FROM auth_profiles WHERE id = ${initial.binding.auth_profile_id}
      AND organization_id = ${org} FOR UPDATE`;
    if (profile?.metadata?.[BROWSER_RECOVERY_KEY]?.run_id !== runId) throw recoveryUnavailable('Browser recovery ownership changed.');
    const [row] = await tx`SELECT run_metadata FROM runs WHERE id = ${runId} AND organization_id = ${org} FOR UPDATE`;
    const lease = row?.run_metadata?.[BROWSER_RECOVERY_KEY] as SourceBrowserLease | undefined;
    if (!lease || lease.state !== 'reading' || lease.binding.auth_profile_id !== initial.binding.auth_profile_id) throw recoveryUnavailable('Browser recovery lease changed.');
    const ready = retained && !!lease.owner.flow_id && !lease.resumed && !!lease.tab && !!lease.chrome_connection_id;
    const hold = ready || (!!lease.tab && !cleanupAcknowledged);
    const expires_at = hold ? new Date(Date.now() + TTL_MS).toISOString() : lease.expires_at;
    await saveLease({ ...lease, expires_at, state: ready ? 'ready' : 'closed' }, org, tx);
    await tx`UPDATE auth_profiles SET metadata = ${hold
      ? tx`COALESCE(metadata, '{}'::jsonb) || ${tx.json({ [BROWSER_RECOVERY_KEY]: { run_id: runId, expires_at } })}`
      : tx`COALESCE(metadata, '{}'::jsonb) - ${BROWSER_RECOVERY_KEY}`}
      WHERE id = ${lease.binding.auth_profile_id} AND organization_id = ${org}`;
    if (ready) return { recovery_id: lease.recovery_id, expires_at, ...lease.tab!,
      device_worker_id: lease.binding.device_worker_id!, chrome_connection_id: lease.chrome_connection_id! };
    return undefined;
  });
}
/** Server-stamped descriptor. Raw public recovery/observation IDs confer no device authority. */
export function browserRecoveryControl(lease: SourceBrowserLease, mode: 'read' | 'retain' | 'observe' | 'act' = 'read') {
  return { ...lease.tab, recovery_id: lease.recovery_id, owner_run_id: lease.run_id, mode,
    expires_at: mode === 'retain' ? new Date(Date.now() + TTL_MS).toISOString() : lease.expires_at,
    resumed: lease.resumed === true };
}
export async function authorizeRecoveryAction(params: {
  scope: AuthzScope; automationId?: number | null; flowId?: string; connectionId: number; action: string; input: Record<string, unknown>;
}) {
  if (params.input.recovery_id === undefined) return undefined;
  if (typeof params.input.recovery_id !== 'string') throw recoveryUnavailable('Invalid recovery ID.');
  const lease = await readRecovery(params.input.recovery_id, params.scope.organizationId, getDb());
  assertRecoveryOwner(lease, params.scope, params.automationId, params.flowId);
  if (params.connectionId !== lease.chrome_connection_id || params.input.tab_id !== lease.tab?.tab_id) throw recoveryUnavailable('Recovery must use its exact Chrome connection and tab.');
  const observe = RECOVERY_OBSERVATIONS.has(params.action);
  if (!observe && (!RECOVERY_ACTIONS.has(params.action) || typeof params.input.observation_id !== 'string')) {
    throw recoveryUnavailable('Recovery permits bounded observations and actions with a fresh observation ID; otherwise ask the browser owner for help.');
  }
  await validateRecoveryBinding(lease, params.scope.organizationId);
  return browserRecoveryControl(lease, observe ? 'observe' : 'act');
}
async function validateRecoveryBinding(lease: SourceBrowserLease, org: string) {
  if (!await sourceReadRecoveryAllowed(org, lease.run_id)) throw recoveryUnavailable('The source is no longer readable by this requester.');
  const resource = await connectionBrowserResource(org, lease.source_connection_id, lease.connector_version);
  if (!resource?.supportsRecovery || !resource.live || resource.status !== 'active' || resource.profileStatus !== 'active'
    || JSON.stringify([...resource.requirement.origins].sort()) !== JSON.stringify(lease.origins)
    || Object.entries(browserBindingSnapshot(resource)).some(([key, value]) => lease.binding[key as keyof typeof lease.binding] !== value)) throw recoveryUnavailable('Recovery browser account binding is no longer active.');
  const [chrome] = await getDb()`SELECT device_worker_id FROM connections WHERE id = ${lease.chrome_connection_id!}
    AND organization_id = ${org} AND connector_key = 'chrome' AND status = 'active' AND deleted_at IS NULL`;
  if (chrome?.device_worker_id !== lease.binding.device_worker_id) throw recoveryUnavailable('Recovery Chrome connection moved to another device.');
}
export async function validateRecoveryDispatch(org: string, descriptor: Record<string, unknown>) {
  if (descriptor.mode !== 'observe' && descriptor.mode !== 'act') return;
  const lease = await readRecovery(String(descriptor.recovery_id), org, getDb());
  if (lease.run_id !== descriptor.owner_run_id) throw recoveryUnavailable('Recovery owner changed before dispatch.');
  await validateRecoveryBinding(lease, org);
}
