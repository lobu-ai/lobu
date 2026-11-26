import type { DbClient } from "../db/client";

// This lookup index is created in the same transaction as the legacy backfill.
export const LOOP_POLICY_CUTOVER_INDEX = "public.write_approval_policies_loop_lookup";

export async function loopPolicyCutoverComplete(sql: DbClient): Promise<boolean> {
	const [cutover] = await sql<{ active: boolean }>`SELECT to_regclass(${LOOP_POLICY_CUTOVER_INDEX}) IS NOT NULL AS active`;
	return cutover.active;
}

export const POLICY_HOOKS = ["operation", "message_in", "reply_out", "tool_call"] as const;

export type PolicyHook = (typeof POLICY_HOOKS)[number];
export type LoopPolicyHook = Exclude<PolicyHook, "operation">;

export function isPolicyHook(value: unknown): value is PolicyHook {
	return POLICY_HOOKS.some(hook => hook === value);
}

// MCP tool names use letters, digits, underscores, hyphens and dots. The
// only wildcard is a literal namespace followed by "__*".
const TOOL_PATTERN = /^(?:[A-Za-z0-9._-]+|[A-Za-z0-9._-]+__\*)$/;

export function parsePolicyToolPatterns(hook: PolicyHook, input: unknown): string[] | null {
	if (input == null) return null;
	if (hook !== "tool_call") throw new Error("tools is only accepted on a tool_call rule.");
	if (!Array.isArray(input) || input.length < 1 || input.length > 50) {
		throw new Error("tools must list 1–50 exact names or namespace wildcards.");
	}
	for (const pattern of input) {
		if (typeof pattern !== "string" || pattern.length > 128 || !TOOL_PATTERN.test(pattern)) {
			throw new Error("Each tool pattern must be an exact name or a namespace wildcard such as github__*.");
		}
	}
	return [...new Set<string>(input)].sort();
}

export function policyToolMatches(patterns: readonly string[] | null, toolNames: readonly string[]): boolean {
  return patterns === null || patterns.some(pattern => toolNames.some(name =>
    pattern === name || (pattern.endsWith("__*") && name.startsWith(pattern.slice(0, -1)))
  ));
}
