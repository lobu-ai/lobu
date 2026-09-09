/**
 * Connector-contributed credentials for one sandbox command.
 *
 * A connector that declares `credential: 'lease'` — the GitHub connector's
 * `GH_TOKEN` — promises the agent an authenticated CLI. The retired subprocess
 * lane kept that promise by baking the lease into the worker's environment at
 * spawn. There is no worker process on the isolate lane, so the lease is minted
 * here and attached to the command the gateway is about to run.
 *
 * Per-command minting is a better fit than the design it replaces, not a
 * workaround for it. A process reads its env once at start, so the subprocess
 * lane had to hold a recycle margin and retire a warm worker before its
 * credential lapsed (`credential-lease.ts`); that whole class of staleness is
 * gone when the mint happens on the request that uses it. `mintFor` caches
 * with a TTL floor, so this does not become a provider call per command.
 *
 * The credential is assembled GATEWAY-side and never round-trips through the
 * worker, which is the same rule the exec route already applies to
 * `allowedDomains` and `nixPackages`: the worker is the sandbox-ee, so it must
 * not be able to name its own credentials.
 */

import { createLogger } from "@lobu/core";
import { getCredentialLeaseRegistry } from "./registry.js";
import { resolveAgentTooling } from "./resolver.js";

const logger = createLogger("exec-credentials");

/**
 * Mint the leases this org's connectors declare, as env vars for one command.
 *
 * Failure is always "contribute nothing", the rule `resolveAgentTooling`
 * already applies per connection and this function extends to the whole
 * lookup: a command that runs with an unauthenticated `gh` reports something
 * the user can act on, while a turn that dies on a credential lookup reports
 * nothing. A DB or provider fault must not take the agent's shell down with it.
 */
export async function resolveLeasedExecEnv(params: {
	agentId: string;
	organizationId: string;
	conversationId: string;
	runId?: number;
}): Promise<Record<string, string>> {
	try {
		const resolved = await resolveAgentTooling({
			agentId: params.agentId,
			organizationId: params.organizationId,
			// Not a worker deployment name any more: nothing is deployed. The scope
			// hint exists to make the lease audit line say WHO a credential was
			// minted for, so it names the conversation the command belongs to.
			deploymentName: `agent-turn:${params.conversationId}`,
			leaseRegistry: getCredentialLeaseRegistry(),
			runId: params.runId,
		});
		return resolved.env;
	} catch (error) {
		logger.warn(
			{
				agent_id: params.agentId,
				organization_id: params.organizationId,
				error: error instanceof Error ? error.message : String(error),
			},
			"Could not resolve connector credentials for this command; it runs without them",
		);
		return {};
	}
}
