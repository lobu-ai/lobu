import { type DbClient, getDb } from "../../db/client.js";

/**
 * Soft cap for a stored snapshot. Production p99 is 1.3 KB; the largest row
 * we've seen across 2050 real session.jsonl entries is 633 KB. 4 MB leaves
 * comfortable headroom for one or two future LLM context-window expansions
 * before we have to introduce R2 spill.
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** Read the latest completed transcript snapshot for one conversation. */
export async function readSnapshotJsonl(args: {
	agentId: string;
	organizationId: string | undefined;
	conversationId: string;
	/** Exclude this source run and later snapshots when restoring a shadow. */
	beforeRunId?: number;
	/** Keep completion read + append on the caller's transaction snapshot. */
	client?: DbClient;
}): Promise<string | null> {
	const { agentId, organizationId, conversationId } = args;
	if (!organizationId) return null;
	const sql = args.client ?? getDb();
	const rows = await sql<{ snapshot_jsonl: string }>`
    SELECT snapshot_jsonl
    FROM public.agent_transcript_snapshot
    WHERE organization_id = ${organizationId}
      AND agent_id = ${agentId}
      AND conversation_id = ${conversationId}
      AND terminal_status = 'completed'
      ${args.beforeRunId === undefined ? sql`` : sql`AND run_id < ${args.beforeRunId}`}
    ORDER BY run_id DESC
    LIMIT 1
  `;
	return rows[0]?.snapshot_jsonl ?? null;
}

/** Flatten a transcript's string or block-array content for isolate history. */
export function transcriptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part &&
			typeof part === "object" &&
			(part as Record<string, unknown>).type === "text"
				? String((part as Record<string, unknown>).text ?? "")
				: ""
		)
		.filter(Boolean)
		.join("\n");
}
