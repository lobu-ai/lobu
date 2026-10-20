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
	 * A completed turn as the completion route leaves it: an agent_turn run whose
	 * envelope names the agent and conversation, plus the transcript snapshot
	 * committed with its terminal. Run ids come from the real sequence, so the
	 * ordering under test is the genuine monotonic one. `snapshot: false` is a
	 * turn still waiting to complete.
	 */
	async function seedTurn(
		convo = conversationId,
		options: { agentId?: string; snapshot?: boolean } = {},
	): Promise<number> {
		const sql = getTestDb();
		const agentId = options.agentId ?? "suggest-agent";
		const runRows = (await sql`
			INSERT INTO public.runs (organization_id, run_type, status, action_input)
			VALUES (${orgId}, 'agent_turn', 'completed',
				${sql.json({ turn: { agent_id: agentId, conversation_id: convo } })})
			RETURNING id
		`) as Array<{ id: number }>;
		const runId = Number(runRows[0].id);
		if (options.snapshot !== false) {
			await sql`
				INSERT INTO public.agent_transcript_snapshot
					(organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
				VALUES (${orgId}, ${agentId}, ${convo}, ${runId}, '', 0, 'completed')
			`;
		}
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
		turnRunId: number,
		turnMessageIds: string[],
		prompts: Array<{ title: string; message: string }>,
		convo = conversationId,
	) {
		return finalizeTurnSuggestions({
			organizationId: orgId,
			conversationId: convo,
			turnMessageIds,
			turnRunId,
			prompts,
		});
	}

	it("sets a current suggestion set readable by conversation", async () => {
		await finalize(await seedTurn(), ["msg-1"], [{ title: "Ship it", message: "Ship the PR" }]);

		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.prompts).toEqual([{ title: "Ship it", message: "Ship the PR" }]);
		expect(current?.turnMessageId).toBe("msg-1");
		expect(await currentCount()).toBe(1);
	});

	it("supersedes the prior set — exactly one current row after a second turn", async () => {
		await finalize(await seedTurn(), ["msg-2"], [{ title: "Next", message: "What's next?" }]);
		// The stack-forever bug would leave 2 current rows here.
		expect(await currentCount()).toBe(1);
		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.prompts).toEqual([{ title: "Next", message: "What's next?" }]);
		expect(current?.turnMessageId).toBe("msg-2");
	});

	it("a re-delivered terminal finds its own set and writes nothing", async () => {
		const turn = await seedTurn();
		await finalize(turn, ["msg-3"], [{ title: "Next", message: "What's next?" }]);
		const before = await readCurrentSuggestion(orgId, conversationId);
		await finalize(turn, ["extra-inbound", "msg-3"], [{ title: "Next", message: "What's next?" }]);
		const after = await readCurrentSuggestion(orgId, conversationId);
		expect(after?.id).toBe(before?.id);
		expect(await liveCount(conversationId)).toBe(1);
	});

	it("a turn that proposed no chips clears the prior set", async () => {
		await finalize(await seedTurn(), ["msg-9"], []);
		expect(await currentCount()).toBe(0);
		expect(await readCurrentSuggestion(orgId, conversationId)).toBeNull();
	});

	it("is a no-op when nothing is current and the turn proposed none", async () => {
		const before = await liveCount(conversationId);
		await finalize(await seedTurn(), ["msg-10"], []);
		expect(await liveCount(conversationId)).toBe(before);
	});

	it("leaves exactly one live row across repeated set→clear cycles", async () => {
		// `current_event_records` keeps a row live until something supersedes it,
		// whatever its status. If a write searched only 'current' rows it would
		// never supersede a clear marker, stranding one immortal row per cycle in
		// an append-only table. currentCount() applies that same status filter,
		// so only the status-agnostic liveCount() can see the leak.
		const cycles = "api:conv-cycles";
		for (let i = 0; i < 3; i++) {
			await finalize(await seedTurn(cycles), [`cycle-${i}`], [{ title: `T${i}`, message: `M${i}` }], cycles);
			await finalize(await seedTurn(cycles), [`other-${i}`], [], cycles);
		}
		expect(await liveCount(cycles)).toBe(1);
	});

	it("a DELAYED terminal does not clear a newer turn's set", async () => {
		// Turn A, then turn B completed and published (B is the set the user
		// sees). A's terminal renders only now — it waited out SSE-owner
		// re-queues — and must leave B's chips alone.
		const a = await seedTurn();
		const b = await seedTurn();
		await finalize(b, ["msg-B"], [{ title: "B", message: "from turn B" }]);
		const idB = (await readCurrentSuggestion(orgId, conversationId))?.id;

		await finalize(a, ["msg-A"], []);

		const current = await readCurrentSuggestion(orgId, conversationId);
		expect(current?.id).toBe(idB);
		expect(current?.prompts).toEqual([{ title: "B", message: "from turn B" }]);
	});

	it("a delayed terminal cannot replace a LATER turn's set with its own chips", async () => {
		const convo = "api:conv-late-chips";
		const g = await seedTurn(convo);
		const h = await seedTurn(convo);
		await finalize(h, ["msg-H"], [{ title: "H", message: "from turn H" }], convo);
		const idH = (await readCurrentSuggestion(orgId, convo))?.id;

		await finalize(g, ["msg-G"], [{ title: "G", message: "stale chips" }], convo);

		const current = await readCurrentSuggestion(orgId, convo);
		expect(current?.id).toBe(idH);
		expect(current?.prompts).toEqual([{ title: "H", message: "from turn H" }]);
	});

	it("a delayed terminal cannot resurrect chips over a LATER turn's clear", async () => {
		const convo = "api:conv-late-clear";
		const j = await seedTurn(convo);
		await finalize(j, ["msg-J"], [{ title: "J", message: "from turn J" }], convo);
		await finalize(await seedTurn(convo), ["msg-K"], [], convo);
		expect(await readCurrentSuggestion(orgId, convo)).toBeNull();

		await finalize(j, ["msg-J"], [{ title: "J-late", message: "stale chips" }], convo);

		expect(await readCurrentSuggestion(orgId, convo)).toBeNull();
	});

	it("a newer CHIP-LESS turn fences an earlier turn's late chips with no row to read", async () => {
		// The newer turn offered nothing and nothing was visible, so it wrote no
		// suggestion row at all; its completed transcript is what fences A.
		const convo = "api:conv-first-empty";
		const a = await seedTurn(convo);
		const b = await seedTurn(convo);
		await finalize(b, ["msg-new"], [], convo);
		expect(await liveCount(convo)).toBe(0);

		await finalize(a, ["msg-old"], [{ title: "Old", message: "Stale" }], convo);

		expect(await readCurrentSuggestion(orgId, convo)).toBeNull();
		expect(await liveCount(convo)).toBe(0);
	});

	it("orders only against THIS conversation and agent", async () => {
		// Newer completed turns elsewhere — another conversation, or another agent
		// sharing the conversation id — must not fence this one.
		const convo = "api:conv-scoped";
		const turn = await seedTurn(convo);
		await seedTurn("api:conv-elsewhere");
		await seedTurn(convo, { agentId: "other-agent" });

		await finalize(turn, ["msg-scoped"], [{ title: "Mine", message: "Mine" }], convo);

		expect((await readCurrentSuggestion(orgId, convo))?.prompts).toEqual([{ title: "Mine", message: "Mine" }]);
	});

	it("an IN-ORDER turn is not fenced by a newer turn still running", async () => {
		// Only a COMPLETED newer turn (its snapshot) means the user saw a newer reply.
		const convo = "api:conv-running";
		const turn = await seedTurn(convo);
		await seedTurn(convo, { snapshot: false });

		await finalize(turn, ["msg-in-order"], [{ title: "Now", message: "Now" }], convo);

		expect((await readCurrentSuggestion(orgId, convo))?.prompts).toEqual([{ title: "Now", message: "Now" }]);
	});
});
