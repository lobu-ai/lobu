import type { AuthzScope } from '../authz/scope';
import type { Env } from '../index';
import { handleExecute } from '../tools/admin/manage_operations/handlers/execute';

/**
 * `ctx.operations.read` for a running connector.
 *
 * The connection is bound by the host — the run's own connection — so a guest
 * can name an operation but never the connection it runs against. Everything
 * else is the ordinary `operations.execute` path: input validation, required
 * OAuth scopes, per-connection action modes, and a run row per read.
 *
 * The synthetic context deliberately carries the run's creator as its
 * principal, so connection visibility is decided exactly as it would be for
 * that person calling `operations.execute`. The worker bridge resolves an
 * active scheduled feed to its connection owner; headless action runs retain
 * their stamped Automation for the existing author-visibility check. `tokenType: 'pat'` keeps approval human-only: a
 * composed read that needs approval fails rather than self-approving.
 */
export function connectorOperationReader(scope: AuthzScope & { actingAutomationId?: number }, connectionId: number, signal?: AbortSignal) {
  return async (operationKey: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (signal?.aborted) throw new Error('Connector execution canceled');
    const result = await handleExecute(
      { action: 'execute', connection_id: connectionId, operation_key: operationKey, input },
      {
        organizationId: scope.organizationId,
        userId: scope.principal,
        agentId: scope.agentId,
        actingAutomationId: scope.actingAutomationId,
        memberRole: null,
        isAuthenticated: scope.principal !== null,
        tokenType: 'pat',
        scopedToOrg: true,
        allowCrossOrg: false,
        grantedOrganizationIds: null,
        directSearchFederation: false,
        abortSignal: signal,
      },
      // handleExecute takes its dependencies from the request context, not Env.
      {} as Env,
      { importedReadOnly: true }
    );
    if (!('status' in result) || result.status !== 'completed') {
      const reason =
        ('error' in result && result.error) ||
        ('error_message' in result && result.error_message) ||
        ('status' in result ? `Imported read is ${result.status}` : 'Imported read did not complete');
      throw new Error(String(reason));
    }
    const output = 'output' in result ? result.output : undefined;
    return output && typeof output === 'object' ? (output as Record<string, unknown>) : {};
  };
}
