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
	if (!ctx?.organizationId || !ctx.workspaceActivity) return;
	const paths = ctx.workspaceActivity.get(ctx.organizationId) ?? new Set<string>();
	paths.add(path);
	ctx.workspaceActivity.set(ctx.organizationId, paths);
}
