// Seed an OVERSIZE native session (with a compaction) as the latest completed
// snapshot of one conversation, so the next turn hydrates it and the completion
// has to bound it. Usage: node seed-trim.mjs <dbUrl> <orgId> <agentId> <convId>
import postgres from "postgres";

const [dbUrl, orgId, agentId, convId] = process.argv.slice(2);
const sql = postgres(dbUrl, { max: 1 });
const at = new Date(Date.now() - 60_000).toISOString();
const message = (id, parentId, role, text) => ({
	type: "message",
	id,
	parentId,
	timestamp: at,
	message: { role, content: [{ type: "text", text }], timestamp: 1 },
});
const before = Array.from({ length: 10 }, (_v, i) => [
	message(
		`u${i}`,
		i === 0 ? null : `a${i - 1}`,
		"user",
		i === 3 ? "x".repeat(4 * 1024 * 1024 + 4096) : `question ${i}`,
	),
	message(`a${i}`, `u${i}`, "assistant", `answer ${i}`),
]).flat();
const compaction = {
	type: "compaction",
	id: "c1",
	parentId: "a9",
	timestamp: at,
	summary:
		"The first eight exchanges were small talk about TRIM_E2E_SUMMARY_MARKER.",
	firstKeptEntryId: "u8",
	tokensBefore: 90_000,
};
const lines = [
	{
		type: "session",
		version: 3,
		id: "e2e-trim-session",
		timestamp: at,
		cwd: "/workspace",
	},
	...before,
	compaction,
];
const snapshot = `${lines.map((e) => JSON.stringify(e)).join("\n")}\n`;

const [run] = await sql`
  INSERT INTO runs (run_type, status, organization_id, created_at, completed_at, run_at)
  VALUES ('chat_message', 'completed', ${orgId}, now(), now(), now()) RETURNING id`;
await sql`
  INSERT INTO agent_transcript_snapshot
    (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status)
  VALUES (${orgId}, ${agentId}, ${convId}, ${run.id}, ${snapshot}, ${Buffer.byteLength(snapshot)}, 'completed')`;
console.log(
	JSON.stringify({
		seededRunId: Number(run.id),
		bytes: Buffer.byteLength(snapshot),
	}),
);
await sql.end();
