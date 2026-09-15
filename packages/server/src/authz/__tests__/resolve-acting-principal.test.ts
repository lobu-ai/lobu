import { describe, expect, it } from "vitest";
import type { DbClient } from "../../db/client";
import { resolveActingPrincipal, resolveWriteCreatorUserId } from "../entity-policy";

/**
 * The single seam every write surface resolves identity through. The stub
 * models the two independent facts the production query returns: whether the
 * Automation row exists and whether its optional managed agent still exists.
 */
function stubSql(
	ownerAgentId: string | null,
	agentExists = true,
	automationExists = true,
): DbClient {
	const sql = (strings: TemplateStringsArray) => {
		const text = strings.join(" ");
		if (text.includes("FROM automations")) {
			if (!automationExists) return Promise.resolve([]);
			return Promise.resolve([
				{
					managed_agent_id: ownerAgentId,
					owner_resolved: ownerAgentId == null ? true : agentExists,
				},
			]);
		}
		// Direct-agent existence probe: SELECT 1 AS one FROM agents ...
		return Promise.resolve(agentExists ? [{ one: 1 }] : []);
	};
	return sql as unknown as DbClient;
}

/** A stub where the Automation row itself is gone. */
function stubSqlNoAutomation(): DbClient {
	return stubSql(null, true, false);
}

const ORG = "org-1";

describe("resolveActingPrincipal", () => {
	it("the trusted session automation wins over the agent id AND a caller tag", async () => {
		// The session automation is stamped by the executor (trusted), so it binds even
		// with an agentId and a different explicit tag present. It folds its owner.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitAutomationId: 7,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			// The trusted SESSION automation (9) wins over the caller-supplied tag (7).
			id: "automation:9",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("an authed agent's caller-supplied tag for a FOREIGN automation is ignored", async () => {
		// The exploit: a restricted agent tags an automation owned by someone else (or a
		// nonexistent id) to null out ownerAgentId and skip its own deny rows. The
		// explicit tag must NOT override the authenticated agent identity.
		const actor = await resolveActingPrincipal(stubSql("other-owner"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitAutomationId: 7,
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "agent-1",
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("an authed agent cannot tag an agentless Automation to shed its own policy", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitAutomationId: 7,
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "agent-1",
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("an authed agent tagging its OWN automation is honored (owner matches)", async () => {
		const actor = await resolveActingPrincipal(stubSql("agent-1"), {
			organizationId: ORG,
			agentId: "agent-1",
			explicitAutomationId: 7,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:7",
			ownerAgentId: "agent-1",
			ownerResolved: true,
		});
	});

	it("an explicit automation_source binds the automation + folds its owning agent", async () => {
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			explicitAutomationId: 7,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:7",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("the reaction SESSION automation binds even with no explicit automation_source", async () => {
		// This is the reaction root fix: a script that omits automation_source still
		// acts as its automation, so its agent's envelope binds.
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:9",
			ownerAgentId: "owner-agent",
			ownerResolved: true,
		});
	});

	it("the trusted session automation wins over an explicit tag (no retag to dodge policy)", async () => {
		const actor = await resolveActingPrincipal(stubSql("owner-agent"), {
			organizationId: ORG,
			explicitAutomationId: 7,
			sessionAutomationId: 9,
		});
		expect(actor.id).toBe("automation:9");
	});

	it("an agentless session Automation remains a resolved Automation principal", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:9",
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("an invalid empty-string agent assignment fails closed", async () => {
		const actor = await resolveActingPrincipal(stubSql("", false), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:9",
			ownerAgentId: "",
			ownerResolved: false,
		});
	});

	it("a plain user turn has no owner to fold", async () => {
		const actor = await resolveActingPrincipal(stubSql(null), {
			organizationId: ORG,
			userId: "user-1",
		});
		expect(actor).toEqual({
			kind: "user",
			id: null,
			ownerAgentId: null,
			ownerResolved: true,
		});
	});

	it("a session automation whose row is GONE resolves ownerResolved=false (gate fails closed)", async () => {
		// The reaction's automation was hard-deleted mid-flight. We still act as the
		// automation, but the owner lookup fails → ownerResolved=false, so the gate must
		// deny rather than run the write against the looser org default.
		const actor = await resolveActingPrincipal(stubSqlNoAutomation(), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor).toEqual({
			kind: "automation",
			id: "automation:9",
			ownerAgentId: null,
			ownerResolved: false,
		});
	});

	it("a bound agent DELETED out from under a live session resolves ownerResolved=false", async () => {
		// The fail-open r16 opened: an admin deletes agent A, its delete trigger
		// cascades A's deny/approval rows, but A's still-live session keeps its bound
		// agentId. Without an existence check the gate finds no A-specific rows and
		// falls back to the (looser) org default — connector_action → auto. The
		// resolver must mark A unresolved so every gate denies.
		const actor = await resolveActingPrincipal(stubSql(null, false), {
			organizationId: ORG,
			agentId: "deleted-agent",
		});
		expect(actor).toEqual({
			kind: "agent",
			id: "deleted-agent",
			ownerAgentId: null,
			ownerResolved: false,
		});
	});

	it("a session automation whose OWNING AGENT was deleted resolves ownerResolved=false", async () => {
		// There is no automation→agent FK, so an in-flight automation's agent_id can dangle
		// after the owner is deleted. The owner JOIN requires the agent row, so the
		// lookup returns no rows → ownerResolved=false → gate denies. (stubSql(null)
		// models the JOIN finding nothing because the agent side is gone.)
		const actor = await resolveActingPrincipal(stubSql("deleted-owner", false), {
			organizationId: ORG,
			sessionAutomationId: 9,
		});
		expect(actor.ownerResolved).toBe(false);
		expect(actor.kind).toBe("automation");
	});
});

/**
 * A stub for the created_by lookups. `automationOwner` models the
 * `automations JOIN "user"` result (a string is a resolved human owner; null means
 * the JOIN found nothing — no automation row, or its created_by is not a real user).
 * `orgAdmin` models the resolveEntityCreator fallback (`FROM "member"`). Captures the
 * queried automation id so a test can assert WHICH automation was read.
 */
function stubCreatorSql(
	automationOwner: string | null,
	orgAdmin: string | null = null,
): DbClient & { queriedIds: number[] } {
	const queriedIds: number[] = [];
	const sql = (strings: TemplateStringsArray, ...vals: unknown[]) => {
		const text = strings.join(" ");
		if (text.includes("FROM automations")) {
			for (const v of vals) if (typeof v === "number") queriedIds.push(v);
			return Promise.resolve(
				automationOwner == null ? [] : [{ created_by: automationOwner }],
			);
		}
		if (text.includes('FROM "member"')) {
			return Promise.resolve(orgAdmin == null ? [] : [{ userId: orgAdmin }]);
		}
		return Promise.resolve([]);
	};
	(sql as unknown as { queriedIds: number[] }).queriedIds = queriedIds;
	return sql as unknown as DbClient & { queriedIds: number[] };
}

describe("resolveWriteCreatorUserId", () => {
	it("a real user is used as-is and never queries an automation", async () => {
		const sql = stubCreatorSql("should-not-read");
		const creator = await resolveWriteCreatorUserId(sql, {
			organizationId: ORG,
			userId: "user-1",
			sessionAutomationId: 9,
		});
		expect(creator).toBe("user-1");
		expect(sql.queriedIds).toEqual([]);
	});

	it("a HEADLESS session automation attributes to the automation's human owner", async () => {
		// The script-executor path: userId is null, so created_by falls to the acting
		// automation's owner — the fix for the entities_created_by_fkey violation.
		const sql = stubCreatorSql("owner-human", "org-admin");
		const creator = await resolveWriteCreatorUserId(sql, {
			organizationId: ORG,
			userId: null,
			sessionAutomationId: 9,
		});
		expect(creator).toBe("owner-human");
		expect(sql.queriedIds).toEqual([9]);
	});

	it("no session automation falls back to the org owner/admin (never 'system')", async () => {
		const sql = stubCreatorSql(null, "org-admin");
		const creator = await resolveWriteCreatorUserId(sql, {
			organizationId: ORG,
			userId: null,
		});
		expect(creator).toBe("org-admin");
		expect(sql.queriedIds).toEqual([]);
	});

	it("an automation owner that is not a real user (JOIN empty) falls back to the org admin", async () => {
		// automations.created_by has no FK of its own, so it can be a deleted user or a
		// historical "system"/agent value. The JOIN to "user" filters those out, then
		// resolveEntityCreator supplies a real org owner/admin — so a valid FK target is
		// always stamped, never the "system" sentinel.
		const creator = await resolveWriteCreatorUserId(stubCreatorSql(null, "org-admin"), {
			organizationId: ORG,
			userId: null,
			sessionAutomationId: 9,
		});
		expect(creator).toBe("org-admin");
	});

	it("an org with no members at all returns null (caller keeps its 'system' last resort)", async () => {
		const creator = await resolveWriteCreatorUserId(stubCreatorSql(null, null), {
			organizationId: ORG,
			userId: null,
			sessionAutomationId: 9,
		});
		expect(creator).toBeNull();
	});
});
