import { listOrgModelProviderSlugs } from '../../lobu/model-config';
import { ToolUserError } from '../../utils/errors';
import { isAdminOrOwnerRole } from '../access-control';
import type { AutomationExecutionConfig, AutomationScriptExecutor } from '@lobu/core/contracts/tools/manage-automations';
export function automationScriptExecutor(config: unknown): AutomationScriptExecutor | undefined {
  return (config as AutomationExecutionConfig | null | undefined)?.executor;
}

/**
 * execution_config keys that are SERVER-ONLY and must never reach a
 * device-worker — its strict payload decode (`additionalProperties: false`)
 * would reject an unknown field and brick every run of that automation. Stripped
 * at the device boundary (worker-api/poll.ts) via stripServerOnlyExecutionConfig.
 */
export const SERVER_ONLY_EXECUTION_CONFIG_KEYS = ['finalize_nudges', 'executor'] as const;

/**
 * Remove SERVER_ONLY_EXECUTION_CONFIG_KEYS from an execution_config before it
 * is handed to a device-worker. Returns null for an absent config, or one that
 * is left empty after stripping (so an automation configured with ONLY server-only
 * keys sends the device `null`, i.e. "use defaults", rather than `{}`).
 */
export function stripServerOnlyExecutionConfig(
  config: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!config) return null;
  const serverOnly = SERVER_ONLY_EXECUTION_CONFIG_KEYS as readonly string[];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!serverOnly.includes(key)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Permission modes that let the spawned agent act unattended without prompting.
// Restricted to org owner/admin: a member-write actor can pin an automation to
// another user's device, so allowing them to set these would be a privilege
// escalation (unattended privileged execution on the device owner's machine).
const ELEVATED_PERMISSION_MODES = new Set(['bypassPermissions', 'dontAsk']);

/** Minimal caller identity needed to authorize elevated permission modes. */
export interface ExecutionConfigCaller {
  memberRole: string | null;
  userId: string | null;
  isAuthenticated: boolean;
}

/**
 * Authorize an incoming `execution_config`. `undefined` = unchanged, `null` =
 * clear — both pass. Shape/type/range validation happens at the tool boundary
 * (AutomationExecutionConfigSchema is embedded in ManageAutomationsSchema); this
 * gate only enforces the role policy, which a schema cannot express.
 */
export function assertValidExecutionConfig(value: unknown, caller: ExecutionConfigCaller): void {
  if (value === undefined || value === null) return;
  const mode = (value as { permission_mode?: string }).permission_mode;
  // System/internal callers (apply, automation) carry no
  // memberRole and already bypass action-access enforcement; don't block them.
  const isSystem = caller.isAuthenticated && caller.userId === null && caller.memberRole === null;
  const isOwnerOrAdmin = isAdminOrOwnerRole(caller.memberRole);
  if (mode && ELEVATED_PERMISSION_MODES.has(mode) && !isSystem && !isOwnerOrAdmin) {
    throw new ToolUserError(
      `execution_config.permission_mode '${mode}' requires an owner or admin role; members may use: default, plan, auto, acceptEdits.`
    );
  }
}

/**
 * Reject a model ref that names a provider this org has not registered.
 *
 * `execution_config.model` is ONE stored field with TWO resolution namespaces
 * (see `getAutomationInferenceOverrides` in automations/automation.ts). A
 * device-pinned Automation passes the ref verbatim to a local CLI as `--model`,
 * so it must name a provider THAT CLI has registered; a server-dispatched one
 * resolves it against the org's model providers — registry modules with a
 * system key UNION its own `inference_providers` rows, which is exactly the set
 * `listOrgModelProviderSlugs` returns and the same one the agent `models`
 * allow-list is validated against. A server-lane ref is `<provider slug>/<model>`
 * (`modelRefFromDefaultRow` builds it that way).
 *
 * Only the server lane is policed, because only its registry lives here — the
 * CLI's provider list is on the user's machine and the server cannot see it.
 * Left unchecked, a CLI-namespace ref on the server lane is accepted at the
 * write and then fails on every scheduled run: prod Automation #5 took an
 * `opencode-go/…` ref and answered `OpenRouter 400: not a valid model ID`.
 *
 * Deliberately narrow, so the check can only fire on a ref it fully understands:
 * an absent/blank model, `auto`, and an unqualified id (no `/`) all pass. The
 * org's registered providers are a human declaration, not a heuristic — the
 * only thing being asserted is that the named one exists.
 *
 * `lobu apply` is exempt, and that is a soundness limit rather than a courtesy:
 * apply writes Automations at phase 6 and org-owned inference providers at
 * phase 10b, so a config declaring BOTH a provider and an Automation on that
 * provider's model reaches this check four phases before the provider row
 * exists. Rejecting there would fail a config that is internally consistent —
 * and against a CLI already published to npm. Closing that hole means moving
 * apply's provider phase ahead of its Automation phase first.
 */
export async function assertServerLaneModelResolves(params: {
  executionConfig: unknown;
  organizationId: string;
  /** Effective pin AFTER the patch — a set device_worker_id means the device lane. */
  isDevicePinned: boolean;
  /** `ctx.applyId` — non-null only for a `lobu apply` run. */
  applyId?: string | null;
}): Promise<void> {
  const { executionConfig, organizationId, isDevicePinned, applyId } = params;
  if (executionConfig === undefined || executionConfig === null) return;
  if (applyId != null) return;
  if (isDevicePinned) return;
  const raw = (executionConfig as { model?: unknown }).model;
  if (typeof raw !== 'string') return;
  const model = raw.trim();
  if (model === '' || model === 'auto') return;
  const slash = model.indexOf('/');
  if (slash <= 0) return;
  const slug = model.slice(0, slash);
  if ((await listOrgModelProviderSlugs(organizationId)).has(slug)) return;
  throw new ToolUserError(
    `execution_config.model '${model}' names model provider '${slug}', which this organization cannot route to. ` +
      `Register it under Providers, use a model from a provider you have, or pass 'auto'. ` +
      `Note: a device-pinned Automation (device_worker_id set) instead resolves this ref against the local CLI's own providers, which are not interchangeable with these.`,
    400
  );
}
