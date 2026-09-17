/**
 * Access-model cross-check (DB-free drift guard).
 *
 * The access tier of an action is declared in three independently-maintained
 * places with no compiler link between them:
 *   1. `tool-access.ts`     — the runtime tier map (`MEMBER_WRITE_ACTIONS` /
 *      `OWNER_ADMIN_ACTIONS` / `PUBLIC_READ_ACTIONS`), keyed by `manage_*` tool
 *      + action string. This is what `getRequiredAccessLevel` enforces on every
 *      direct tool call and SDK namespace method.
 *   2. `method-metadata.ts` — `METHOD_METADATA[<dotted path>].access`, the tier
 *      `search_sdk` / `sdkMethodVisible` use to decide what a caller may see and
 *      invoke through the SDK.
 *   3. `sdk_search.ts`      — `AGENTS_SDK_ACTION`, the `agents.*` → agent_config
 *      write-verb map that gates agent-principal visibility of the agents
 *      namespace.
 *
 * These must agree. A change to one that isn't mirrored in the others is a
 * silent authorization drift: a member could gain a write action the SDK still
 * advertises as read, or an SDK method could vanish from discovery while the
 * direct tool still accepts it. This test fails on that drift, mirroring the
 * existing `method-metadata.test.ts` guard.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import {
	getRequiredAccessLevel,
	isPublicReadable,
	MEMBER_WRITE_ACTIONS,
	OWNER_ADMIN_ACTIONS,
	PUBLIC_READ_ACTIONS,
	type ToolAccessLevel,
} from "../tool-access";
import { METHOD_METADATA } from "../../sandbox/method-metadata";
import { AGENTS_SDK_ACTION } from "../../tools/sdk_search";
import { withValidatedArgs } from "../../tools/validate-args";

/**
 * The `manage_*` tool the SDK namespace delegates to, per namespace prefix.
 * Only namespaces whose methods route through a single `manage_*` action tool
 * (so their METHOD_METADATA tier is enforceable via getRequiredAccessLevel) are
 * listed; discovery-only / bespoke namespaces (organizations, knowledge,
 * metrics, ctx, notifications) are intentionally omitted.
 */
const TIERED_NAMESPACES = [
	["entities", "manage_entity", "../../tools/admin/manage_entity", "manageEntity"],
	["entitySchema", "manage_entity_schema", "../../tools/admin/manage_entity_schema", "manageEntitySchema"],
	["connections", "manage_connections", "../../tools/admin/manage_connections", "manageConnections"],
	["authProfiles", "manage_auth_profiles", "../../tools/admin/manage_auth_profiles", "manageAuthProfiles"],
	["feeds", "manage_feeds", "../../tools/admin/manage_feeds", "manageFeeds"],
	["operations", "manage_operations", "../../tools/admin/manage_operations", "manageOperations"],
	["automations", "manage_automations", "../../tools/admin/manage_automations", "manageAutomations"],
	["classifiers", "manage_classifiers", "../../tools/admin/manage_classifiers", "manageClassifiers"],
	["views", "manage_views", "../../tools/admin/manage_views", "manageViews"],
	["catalog", "manage_catalog", "../../tools/admin/manage_catalog", "manageCatalog"],
	["agents", "manage_agents", "../../tools/admin/manage_agents", "manageAgents"],
	["schedules", "manage_schedules", "../../tools/admin/manage_schedules", "manageSchedules"],
	["conversations", "manage_conversations", "../../tools/admin/manage_conversations", "manageConversations"],
] as const;

const NAMESPACE_TOOL = Object.fromEntries(
	TIERED_NAMESPACES.map(([namespace, tool]) => [namespace, tool]),
) as Record<string, string>;

/**
 * Methods that legitimately resolve to NO (tool, action) pair, with the reason.
 *
 * This list is the whole point of the guard being fail-closed: anything in a
 * tiered namespace that is not here and does not resolve is a FAILURE, not a
 * silent skip. Adding an entry is a deliberate, reviewable act — the previous
 * `continue` swallowed 25 methods (all of feeds.*, all of authProfiles.*, all
 * 12 entitySchema.*, entities.search) without anyone noticing 11 real
 * authorization drifts hiding among them.
 */
const NO_TOOL_ACTION = new Set([
	// Bypasses the action caller entirely: delegates to the `search` tool, which
	// carries its own access gate rather than a manage_entity action.
	"entities.search",
	// Same shape: delegates to the standalone `get_automation` tool.
	"automations.get",
	// Uses the owner-scoped current MCP conversation helper, not manage_conversations.
	"conversations.setTitle",
]);

/**
 * `"<namespace>.<method>"` → internal action, captured by driving every SDK
 * namespace builder against a stub handler and recording the action payload it
 * receives.
 */
const observed = new Map<string, Record<string, unknown>>();

/**
 * Build every tiered namespace against a stub handler and invoke each method so
 * the real dispatch path records its action string.
 *
 * Invocation (rather than static parsing) is REQUIRED: `entity-schema.ts`
 * computes its action from a runtime payload field, so 12 of its methods have
 * no action literal in the source. It is also safe — the stub handler replaces
 * the real `manage_*` module, so nothing touches the DB.
 *
 * Uses vi.doMock + vi.resetModules + dynamic import rather than hoisted
 * vi.mock: this suite runs in the integration project, which shares one module
 * registry across files (`isolate: false`), where a hoisted vi.mock does not
 * reliably replace the module.
 */
async function captureActionMap(): Promise<void> {
	vi.resetModules();
	let activePath: string | null = null;
	const stub = async (payload: Record<string, unknown>) => {
		if (activePath && typeof payload.action === "string") {
			observed.set(activePath, payload);
		}
		return {};
	};
	for (const [, tool, mod, exportName] of TIERED_NAMESPACES) {
		vi.doMock(mod, () => ({
			[exportName]: withValidatedArgs(
				tool,
				Type.Object({}, { additionalProperties: true }),
				stub,
			),
		}));
	}

	const ctx = { organizationId: "o", userId: "u" } as never;
	const env = { ENVIRONMENT: "test" } as never;
	const { buildClientSDK } = await import("../../sandbox/client-sdk.js");
	const sdk = buildClientSDK(ctx, env) as unknown as Record<string, unknown>;

	// Methods take assorted arg shapes, and `idArg` throws BEFORE action() runs
	// when the shape is wrong (a bare string id vs a bare number id vs an object).
	// Try each candidate until one gets through; a method that records nothing
	// under any of them is reported by the coverage assertion below rather than
	// silently dropped.
	const candidates: unknown[] = ["probe", 1, {}, { slug: "probe" }];
	for (const [nsName] of TIERED_NAMESPACES) {
		const ns = sdk[nsName];
		for (const method of Object.keys(ns as object)) {
			if (method === "manage") continue;
			// Methods that bypass the action caller reach a REAL tool (search /
			// get_automation) that the stub handlers above do not replace, so probing
			// them would hit the database. They are declared in NO_TOOL_ACTION and
			// contribute no mapping — never invoke them.
			if (NO_TOOL_ACTION.has(`${nsName}.${method}`)) continue;
			const fn = (ns as Record<string, unknown>)[method];
			if (typeof fn !== "function") continue;
			activePath = `${nsName}.${method}`;
			for (const arg of candidates) {
				if (observed.has(activePath)) break;
				try {
					await (fn as (a: unknown) => Promise<unknown>)(arg);
				} catch {
					// Arg-shape rejections are expected while probing.
				}
			}
		}
	}

	activePath = null;
	vi.resetModules();
	for (const [, , mod] of TIERED_NAMESPACES) {
		vi.doUnmock(mod);
	}
}

beforeAll(captureActionMap);

/**
 * The runtime tier the tool-access maps assign to a (tool, action), by their
 * enforcement precedence: owner-admin → member-write → public-read. Every
 * manage_* tool checked here has an explicit policy, so an action absent from
 * all three maps falls through to read tier; return null so the test rejects
 * that implicit default.
 */
function declaredRuntimeTier(
	tool: string,
	payload: Record<string, unknown>,
): ToolAccessLevel | null {
	const action = payload.action;
	if (typeof action !== "string") return null;
	// These are deliberately authenticated reads: tool-access.ts explicitly
	// documents their read fallback. Adding them to PUBLIC_READ_ACTIONS would
	// expose conversation titles to anonymous callers, so test the distinction.
	const authenticatedConversationRead = tool === "manage_conversations" &&
		(action === "list" || action === "get");
	const isExplicitlyDeclared = authenticatedConversationRead ||
		OWNER_ADMIN_ACTIONS[tool]?.has(action) ||
		MEMBER_WRITE_ACTIONS[tool]?.has(action) ||
		PUBLIC_READ_ACTIONS[tool]?.has(action);
	if (!isExplicitlyDeclared) return null;
	// Evaluate the real payload because a shared internal action can have a
	// discriminator-specific tier (entity-type create proposes at write tier,
	// while relationship-type create still mutates at admin tier).
	return getRequiredAccessLevel(tool, payload, false);
}

describe("access-model cross-check", () => {
	it("keeps conversation reads authenticated while reporting read tier", () => {
		for (const action of ["list", "get"]) {
			expect(getRequiredAccessLevel("manage_conversations", { action }, false)).toBe("read");
			expect(isPublicReadable("manage_conversations", { action })).toBe(false);
		}
	});

	it("no manage_* action is declared in conflicting tiers", () => {
		// The three tier maps partition actions: an action that is both
		// member-write and owner-admin (or public-read) is a contradiction —
		// getRequiredAccessLevel resolves it by precedence, but the duplicate is
		// almost always a copy-paste left behind when an action moved tiers.
		const seen = new Map<string, string>();
		const record = (tier: string, map: Record<string, Set<string> | null>) => {
			const conflicts: string[] = [];
			for (const [tool, actions] of Object.entries(map)) {
				if (actions === null) continue;
				for (const action of actions) {
					const key = `${tool}.${action}`;
					const prior = seen.get(key);
					if (prior) conflicts.push(`${key}: ${prior} + ${tier}`);
					else seen.set(key, tier);
				}
			}
			return conflicts;
		};
		const conflicts = [
			...record("member-write", MEMBER_WRITE_ACTIONS),
			...record("owner-admin", OWNER_ADMIN_ACTIONS),
			...record("public-read", PUBLIC_READ_ACTIONS),
		];
		expect(conflicts).toEqual([]);
	});

	it("keeps SDK discovery tiers aligned with runtime enforcement", () => {
		// Compare the discovery tier `sdkMethodVisible` uses with the tier the
		// delegated manage_* action enforces.
		//
		// `external` splits the two: it is a side-effect marker (this method calls
		// out to an external system), not a pure tier. VISIBILITY still follows the
		// marker — `sdkMethodVisible` keeps external methods write-visible even when
		// the underlying action is admin-enforced, so an owner/admin can trigger the
		// progressive mcp:admin OAuth challenge by calling one (operations.execute /
		// feeds.trigger / connections.test all stay "external" while trigger_feed /
		// test are owner-admin).
		//
		// The tier REPORTED to callers is a separate question, and it must match
		// enforcement exactly or search_sdk sends an mcp:write caller to retry into
		// a hard admin rejection. That is what `enforcedTier` carries, and what the
		// external branch below pins against the live tier map.
		const mismatches: string[] = [];
		for (const [path, meta] of Object.entries(METHOD_METADATA)) {
			const [namespace, method] = path.split(".");
			const tool = NAMESPACE_TOOL[namespace];
			if (!tool || !method) continue;
			// `enforcedTier` disambiguates `external` only; anywhere else it is dead
			// weight that can silently contradict `access`. Checked before the
			// branches below so it covers the `.manage` wrappers too — they take the
			// `expected`-vs-`reported` path, which reads `enforcedTier` only when
			// `access` is external and so would never notice a stray one.
			if (meta.access !== "external" && meta.enforcedTier !== undefined) {
				mismatches.push(
					`${path}: enforcedTier is only meaningful with access:"external" (access=${meta.access})`,
				);
			}
			// `.manage` is the raw action-passthrough wrapper: it accepts ANY action
			// of its tool, so it carries the namespace's most-privileged tier rather
			// than one action's. That is a derivable expectation, not an exemption —
			// skipping it entirely hid half the `external` class, leaving all five
			// wrappers reporting "operate (mcp:write)" while four of them accept
			// admin actions (connections.manage({action:'delete'}) from an mcp:write
			// caller is the exact symptom this guard exists to catch).
			if (method === "manage") {
				// Only the TIER is derivable. Whether a wrapper is also `external` is
				// a property of its namespace (does it call out to an external
				// system?), so entities/entitySchema/agents/schedules/classifiers/
				// views legitimately use a plain tier instead.
				const expected = OWNER_ADMIN_ACTIONS[tool]?.size ? "admin" : "write";
				const reported =
					meta.access === "external" ? meta.enforcedTier : meta.access;
				if (reported !== expected) {
					mismatches.push(
						`${path}: reports ${reported ?? "(unset)"} but ${tool} has ${OWNER_ADMIN_ACTIONS[tool]?.size ?? 0} owner-admin action(s), so the passthrough must report "${expected}"${meta.access === "external" ? ' via enforcedTier' : ""}`,
					);
				}
				continue;
			}
			if (NO_TOOL_ACTION.has(path)) continue;
			// The action this method REALLY dispatches, recorded from the live
			// dispatch path. Never guessed: `feeds.list` dispatches `list_feeds`,
			// which the old camel→snake guess turned into `manage_feeds.list` — a
			// key present in no tier map, so the method was skipped instead of
			// checked.
			const payload = observed.get(path);
			if (!payload || typeof payload.action !== "string") {
				mismatches.push(
					`${path}: no action recorded — the SDK method is gone, renamed, or no longer routes through createActionCaller. Fix the wiring or add it to NO_TOOL_ACTION with a reason.`,
				);
				continue;
			}
			const action = payload.action;
			const runtimeTier = declaredRuntimeTier(tool, payload);
			if (runtimeTier === null) {
				mismatches.push(
					`${path}: ${tool}.${action} is in no tier map and implicitly falls through to read; declare it explicitly in tool-access.ts`,
				);
				continue;
			}
			if (meta.access === "external") {
				// External is write-visible; it must at least be enforced at
				// write-or-admin (never a read action masquerading as external).
				if (runtimeTier === "read") {
					mismatches.push(
						`${path}: SDK=external but runtime(${tool}.${action})=read`,
					);
					continue;
				}
				// `external` governs VISIBILITY, but the tier search_sdk REPORTS comes
				// from `enforcedTier`. It must state the enforced tier exactly:
				// omitting it on an admin-enforced method reported "operate
				// (mcp:write)" and sent an mcp:write caller to retry straight into
				// "requires an MCP session with admin access."; stating the wrong tier
				// is the same bug with extra confidence.
				if (meta.enforcedTier !== runtimeTier) {
					mismatches.push(
						`${path}: SDK=external enforcedTier=${meta.enforcedTier ?? "(unset)"} but runtime(${tool}.${action})=${runtimeTier} — set enforcedTier to "${runtimeTier}" in method-metadata.ts so the reported tier matches enforcement`,
					);
				}
				continue;
			}
			// `enforcedTier` disambiguates `external` only; on a plainly-tiered
			// method it is dead weight that can silently contradict `access`.
			if (meta.enforcedTier !== undefined) {
				mismatches.push(
					`${path}: enforcedTier is only meaningful with access:"external" (access=${meta.access})`,
				);
			}
			// read / write / admin must match the enforced tier exactly.
			if (meta.access !== runtimeTier) {
				mismatches.push(
					`${path}: SDK=${meta.access} runtime(${tool}.${action})=${runtimeTier}`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it("every tiered SDK method resolves to a real, tier-declared action", () => {
		const unresolved: string[] = [];
		for (const path of Object.keys(METHOD_METADATA)) {
			const [namespace, method] = path.split(".");
			if (!method || method === "manage") continue;
			if (!NAMESPACE_TOOL[namespace]) continue;
			if (NO_TOOL_ACTION.has(path)) continue;
			if (!observed.get(path)) unresolved.push(path);
		}
		expect(unresolved).toEqual([]);
	});

	it("the agents.* triple agrees (AGENTS_SDK_ACTION ↔ METHOD_METADATA ↔ manage_agents)", () => {
		// AGENTS_SDK_ACTION enumerates the agents.* SDK paths gated by
		// agent_config policy, each mapped to the agent_config verb it needs.
		// `read`-verb paths (list/get) are org-read: METHOD_METADATA tier `read`,
		// runtime declared in PUBLIC_READ_ACTIONS.manage_agents (the handler gates
		// them with requireOrgReadAccess). Write-verb paths (create/update/delete)
		// are administration: METHOD_METADATA tier `admin`, runtime owner-admin.
		// The raw `.manage` passthrough carries the namespace's
		// most-privileged tier (admin) and maps to no single action.
		const adminAgentActions = OWNER_ADMIN_ACTIONS.manage_agents;
		const readAgentActions = PUBLIC_READ_ACTIONS.manage_agents;
		expect(adminAgentActions).toBeDefined();
		expect(readAgentActions).toBeDefined();

		for (const [path, verb] of Object.entries(AGENTS_SDK_ACTION)) {
			// Index directly, not `toHaveProperty(path)`: the dotted keys
			// ("agents.list") are LITERAL keys, but toHaveProperty parses a dotted
			// string as a nested traversal (METHOD_METADATA.agents.list) — automation
			// that varies across matcher versions. Look up the literal key instead.
			expect(
				METHOD_METADATA[path],
				`${path} missing METHOD_METADATA`,
			).toBeDefined();

			// A `read` agent_config verb is an org-read method; anything else
			// (create/update/delete/any) is admin-tier administration.
			const isRead = verb === "read";
			const expectedTier = isRead ? "read" : "admin";
			expect(
				METHOD_METADATA[path]?.access,
				`${path} should be ${expectedTier} in METHOD_METADATA`,
			).toBe(expectedTier);

			const method = path.split(".")[1];
			if (method === "manage") continue;
			const action = observed.get(path)?.action;
			expect(action, `${path} dispatched no recorded action`).toBeDefined();
			if (typeof action !== "string") continue;
			if (isRead) {
				expect(
					readAgentActions?.has(action),
					`agents.${method} → manage_agents.${action} must be public-read`,
				).toBe(true);
			} else {
				expect(
					adminAgentActions?.has(action),
					`agents.${method} → manage_agents.${action} must be owner-admin`,
				).toBe(true);
			}
		}
	});
});
