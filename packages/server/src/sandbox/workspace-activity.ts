import type { AccountToolContext } from "../tools/registry";

/** Host-only: the context each built SDK client acts in. Never reaches the guest. */
const clientContexts = new WeakMap<object, AccountToolContext>();

export function bindClientContext(client: object, ctx: AccountToolContext): void {
	clientContexts.set(client, ctx);
}

/**
 * Record a completed SDK call against the workspace `client` targets. Calls on
 * an account client (no workspace selected) record nothing.
 */
export function recordWorkspaceSdkCall(client: object, path: string): void {
	const ctx = clientContexts.get(client);
	if (ctx?.organizationId) recordWorkspaceActivity(ctx, ctx.organizationId, path);
}

/** Record that `method` did work in `organizationId` for this tool invocation. */
export function recordWorkspaceActivity(
	ctx: Pick<AccountToolContext, "workspaceActivity">,
	organizationId: string,
	method: string,
): void {
	if (!ctx.workspaceActivity) return;
	const methods = ctx.workspaceActivity.get(organizationId) ?? new Set<string>();
	methods.add(method);
	ctx.workspaceActivity.set(organizationId, methods);
}
