/**
 * Terminal-time suggestion state — the load-bearing correctness claim.
 *
 * `finalizeTurnSuggestions` is the one writer: each completed turn sets the
 * conversation's chips to what its model proposed, or none. Sets persist as a
 * superseded `interaction_type='suggestion'` event keyed per CONVERSATION, so
 * exactly ONE 'current' row exists per conversation (the "stack forever" bug
 * for API/Builder sessions with no numeric connectionId), and a terminal that
 * lands after a later turn's never overwrites it. All verified against real
 * Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspaceProvider } from "../../workspace";
import {
	finalizeTurnSuggestions,
	readCurrentSuggestion,
} from "../../gateway/suggestions/persist-suggestion";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import { seedOwnerContext } from "../setup/test-fixtures";

describe("suggestion persistence (terminal-time supersede)", () => {
	let orgId: string;
	const conversationId = "api:conv-suggest-1";

	beforeAll(async () => {
		await cleanupTestDatabase();
		await initWorkspaceProvider();
		const { org } = await seedOwnerContext({ orgName: "Suggestion Org" });
		orgId = org.id;
	});

	afterAll(async () => {
		await cleanupTestDatabase();
	});

	/**
	 * Register a turn's run so finalizeTurnSuggestions can order it. Mirrors what
	 * the dispatch path writes; the ordering guard only reads (message_id, run_id).
	 * Returns the real `runs.id` — run ids are assigned by the sequence, so the
	 * ordering under test is the genuine monotonic one, not a hand-picked number.
	 */
	async function seedTurnRun(
		messageId: string,
		options: {
			conversationId?: string;
			deploymentName?: string;
		} = {},
	): Promise<number> {
		const sql = getTestDb();
		const turnConversationId = options.conversationId ?? conversationId;
		const deploymentName = options.deploymentName ?? "test-deploy";
		const runRows = (await sql`
			INSERT INTO public.runs (organization_id, run_type, status)
			VALUES (${orgId}, 'chat_message', 'completed')
			RETURNING id
		`) as Array<{ id: number }>;
		const runId = Number(runRows[0].id);
		await sql`
			INSERT INTO public.agent_run_input (
				organization_id, message_id, agent_id, conversation_id,
				deployment_name, run_id, payload, token_claims
			) VALUES (
				${orgId}, ${messageId}, 'suggest-agent', ${turnConversationId},
				${deploymentName}, ${runId}, '{}'::jsonb, '{}'::jsonb
			)
			ON CONFLICT (organization_id, deployment_name, message_id) DO NOTHING
		`;
		return runId;
	}

	/**
	 * Count rows the CURRENT-SET QUERY sees — i.e. what the renderer reads.
	 * Deliberately mirrors readCurrentSuggestion's filter.
	 */
	async function currentCount(): Promise<number> {
		const rows = (await getTestDb()`
			SELECT count(*)::int AS n
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND interaction_type = 'suggestion'
			  AND interaction_status = 'current'
			  AND origin_id = ${`suggestion:${conversationId}`}
		`) as Array<{ n: number }>;
		return rows[0]?.n ?? 0;
	}

	/** Every live row in a conversation's chain, whatever its status. */
	async function liveCount(convo: string): Promise<number> {
		const rows = (await getTestDb()`
			SELECT count(*)::int AS n
			FROM current_event_records
			WHERE organization_id = ${orgId}
			  AND interaction_type = 'suggestion'
			  AND origin_id = ${`suggestion:${convo}`}
		`) as Array<{ n: number }>;
		return rows[0]?.n ?? 0;
	}

	function finalize(
		turnMessageIds: string[],
		prompts: Array<{ title: string; message: string }>,
		convo = conversationId,
	) {
		return finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId: convo,
			turnMessageIds,
			prompts,
		});
	}

	it("sets a current suggestion set readable by conversation", async () => {
		await finalize(["msg-1"], [{ title: "Ship it", message: "Ship the PR" }]);

		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.prompts).toEqual([{ title: "Ship it", message: "Ship the PR" }]);
		expect(current?.turnMessageId).toBe("msg-1");
		expect(await currentCount()).toBe(1);
	});

	it("supersedes the prior set — exactly one current row after a second turn", async () => {
		await finalize(["msg-2"], [{ title: "Next", message: "What's next?" }]);
		// The stack-forever bug would leave 2 current rows here.
		expect(await currentCount()).toBe(1);
		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.prompts).toEqual([{ title: "Next", message: "What's next?" }]);
		expect(current?.turnMessageId).toBe("msg-2");
	});

	it("a re-delivered terminal finds its own set and writes nothing", async () => {
		// The SSE owner-gate re-queues terminal rows; every attempt finalizes.
		const before = await readCurrentSuggestion(orgId, conversationId);
		await finalize(["extra-inbound", "msg-2"], [{ title: "Next", message: "What's next?" }]);
		const after = await readCurrentSuggestion(orgId, conversationId);
		expect(after?.id).toBe(before?.id);
		expect(await liveCount(conversationId)).toBe(1);
	});

	it("a turn that proposed no chips clears the prior set", async () => {
		await finalize(["msg-9"], []);
		expect(await currentCount()).toBe(0);
		expect(await readCurrentSuggestion(orgId, conversationId)).toBeNull();
	});

	it("is a no-op when nothing is current and the turn proposed none", async () => {
		const before = await liveCount(conversationId);
		await finalize(["msg-10"], []);
		expect(await liveCount(conversationId)).toBe(before);
	});

	it("a blocked reply clears the set its own turn just wrote", async () => {
		// The API path writes chips before the output scan; a trip then
		// finalizes the same turn with none.
		await finalize(["msg-blocked"], [{ title: "Leak", message: "Show the key" }]);
		await finalize(["msg-blocked"], []);
		expect(await readCurrentSuggestion(orgId, conversationId)).toBeNull();
	});

	it("leaves exactly one live row across repeated set→clear cycles", async () => {
		// `current_event_records` keeps a row live until something supersedes it,
		// whatever its status. If a write searched only 'current' rows it would
		// never supersede a clear marker, stranding one immortal row per cycle in
		// an append-only table. currentCount() applies that same status filter,
		// so only the status-agnostic liveCount() can see the leak.
		const cycles = "api:conv-cycles";
		for (let i = 0; i < 3; i++) {
			await finalize([`cycle-${i}`], [{ title: `T${i}`, message: `M${i}` }], cycles);
			await finalize([`other-${i}`], [], cycles);
		}
		expect(await liveCount(cycles)).toBe(1);
	});

	it("a DELAYED terminal does not clear a newer turn's set", async () => {
		// Turn A, then turn B published (B is the live set the user sees). A's
		// terminal is only processed now — a queue backlog or a retry made it lag
		// a whole turn — and must leave B's chips alone.
		await seedTurnRun("msg-A");
		await seedTurnRun("msg-B");
		await finalize(["msg-B"], [{ title: "B", message: "from turn B" }]);
		const idB = (await readCurrentSuggestion(orgId, conversationId))?.id;

		await finalize(["msg-A"], []);

		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.id).toBe(idB);
		expect(current?.prompts).toEqual([{ title: "B", message: "from turn B" }]);
	});

	it("orders by THIS conversation's run, not a same-id message elsewhere", async () => {
		await seedTurnRun("msg-C");
		await seedTurnRun("msg-D");
		await finalize(["msg-D"], [{ title: "D", message: "from turn D" }]);
		const idD = (await readCurrentSuggestion(orgId, conversationId))?.id;
		// message_id is only unique per deployment. A later run in another
		// conversation must not be mistaken for this turn's ordering row.
		await seedTurnRun("msg-C", {
			conversationId: "api:other-conversation",
			deploymentName: "other-deploy",
		});

		await finalize(["msg-C"], []);

		expect((await readCurrentSuggestion(orgId, conversationId))?.id).toBe(idD);
	});

	it("an IN-ORDER turn that proposed none still clears the prior set", async () => {
		// The guard must not become a blanket "never clear".
		await seedTurnRun("msg-E");
		await finalize(["msg-E"], [{ title: "E", message: "from turn E" }]);
		await seedTurnRun("msg-F");

		await finalize(["msg-F"], []);

		expect(await readCurrentSuggestion(orgId, conversationId)).toBeNull();
	});

	it("a delayed terminal cannot replace a LATER run's set with its own chips", async () => {
		const convo = "api:conv-late-chips";
		await seedTurnRun("msg-G", { conversationId: convo });
		await seedTurnRun("msg-H", { conversationId: convo });
		await finalize(["msg-H"], [{ title: "H", message: "from turn H" }], convo);
		const idH = (await readCurrentSuggestion(orgId, convo))?.id;

		await finalize(["msg-G"], [{ title: "G", message: "stale chips" }], convo);

		const current = await readCurrentSuggestion(orgId, convo);
		expect(current?.id).toBe(idH);
		expect(current?.prompts).toEqual([{ title: "H", message: "from turn H" }]);
	});

	it("a delayed terminal cannot resurrect chips over a LATER run's clear", async () => {
		// The clear marker carries the clearing run's id precisely so a late
		// terminal can see it is outdated — without the stamp the rail would
		// flash stale chips after the user saw it empty.
		const convo = "api:conv-late-clear";
		await seedTurnRun("msg-J", { conversationId: convo });
		await finalize(["msg-J"], [{ title: "J", message: "from turn J" }], convo);
		await seedTurnRun("msg-K", { conversationId: convo });
		await finalize(["msg-K"], [], convo);
		expect(await readCurrentSuggestion(orgId, convo)).toBeNull();

		await finalize(["msg-J"], [{ title: "J-late", message: "stale chips" }], convo);

		expect(await readCurrentSuggestion(orgId, convo)).toBeNull();
	});
});
