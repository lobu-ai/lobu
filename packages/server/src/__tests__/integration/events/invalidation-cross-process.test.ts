/**
 * Content invalidations must reach every replica's SSE stream, not only the
 * process that wrote the event. A browser's invalidation stream lives on one
 * replica; the event can be written by any other (a connector run, an
 * Automation, save_memory on a different pod). Delivery goes through Postgres
 * LISTEN/NOTIFY, so these tests write from a SEPARATE Node process sharing the
 * test database and read the stream in this one.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { executeTool, type AuthContext } from "../../../tools/execute";
import { insertEvent } from "../../../utils/insert-event";
import { initWorkspaceProvider } from "../../../workspace";
import { streamInvalidationEvents } from "../../../events/sse";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

interface OpenStream {
	frames: string[];
	waitFor: (predicate: (frame: string) => boolean, timeoutMs?: number, from?: number) => Promise<string | null>;
	close: () => void;
}

/** Open the real SSE handler and resolve once its `connected` frame arrived. */
async function openStream(organizationId: string): Promise<OpenStream> {
	const ctrl = new AbortController();
	const ctx = {
		req: { raw: { signal: ctrl.signal } },
		header: () => {},
		body: (stream: ReadableStream) => new Response(stream),
	};
	const response = streamInvalidationEvents(
		ctx as unknown as Parameters<typeof streamInvalidationEvents>[0],
		organizationId,
	);
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	const frames: string[] = [];
	const waiters = new Set<() => void>();
	let buffer = "";
	void (async () => {
		for (;;) {
			const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
			if (chunk.done) return;
			buffer += decoder.decode(chunk.value, { stream: true });
			let end = buffer.indexOf("\n\n");
			while (end >= 0) {
				frames.push(buffer.slice(0, end));
				buffer = buffer.slice(end + 2);
				end = buffer.indexOf("\n\n");
			}
			for (const wake of waiters) wake();
		}
	})();

	const waitFor = (predicate: (frame: string) => boolean, timeoutMs = 5_000, from = 0) =>
		new Promise<string | null>((resolve) => {
			let seen = from;
			const check = () => {
				for (; seen < frames.length; seen++) {
					if (predicate(frames[seen])) {
						cleanup();
						resolve(frames[seen]);
						return;
					}
				}
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve(null);
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				waiters.delete(check);
			};
			waiters.add(check);
			check();
		});

	const connected = await waitFor((frame) => frame.startsWith("event: connected"));
	expect(connected).not.toBeNull();
	return { frames, waitFor, close: () => ctrl.abort() };
}

const isContentInvalidation = (frame: string) =>
	frame.startsWith("event: invalidate") && frame.includes('"contents-filtered"');

/** Write one event from a separate Node process through the canonical insert path. */
async function insertEventInOtherProcess(organizationId: string, originId: string) {
	const script = `
import { insertEvent } from './src/utils/insert-event.ts';
import { closeDbSingleton } from './src/db/client.ts';
const input = JSON.parse(process.env.INVALIDATION_TEST_INPUT);
const row = await insertEvent({ entityIds: [], organizationId: input.organizationId, originId: input.originId, semanticType: 'note', title: 'cross-process write', content: 'x' });
console.log('INSERTED=' + row.id);
await closeDbSingleton();
process.exit(0);`;
	const { stdout } = await promisify(execFile)(
		process.execPath,
		["--import", "tsx", "--input-type=module", "--eval", script],
		{
			cwd: process.cwd(),
			env: { ...process.env, INVALIDATION_TEST_INPUT: JSON.stringify({ organizationId, originId }) },
			timeout: 30_000,
		},
	);
	expect(stdout).toContain("INSERTED=");
}

describe("cross-replica content invalidation", () => {
	beforeAll(async () => {
		await getTestDb()`SELECT 1`;
		await initWorkspaceProvider();
	});
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("delivers an event written in another process to this process's stream, scoped by org", async () => {
		const org = await createTestOrganization({ name: "Invalidation Org" });
		const other = await createTestOrganization({ name: "Invalidation Other Org" });
		const stream = await openStream(org.id);
		const otherStream = await openStream(other.id);
		try {
			await insertEventInOtherProcess(org.id, `cross-process-${Date.now()}`);
			expect(await stream.waitFor(isContentInvalidation)).not.toBeNull();
			// Tenant isolation: the other org's stream never hears about it.
			expect(await otherStream.waitFor(isContentInvalidation, 500)).toBeNull();
		} finally {
			stream.close();
			otherStream.close();
		}
	}, 60_000);

	it("publishes on commit and drops the notification when the write rolls back", async () => {
		const org = await createTestOrganization({ name: "Invalidation Tx Org" });
		const stream = await openStream(org.id);
		try {
			await getTestDb()
				.begin(async (tx) => {
					await insertEvent(
						{ entityIds: [], organizationId: org.id, originId: "rolled-back", semanticType: "note", title: "rolled back" },
						{ sql: tx as never },
					);
					throw new Error("rollback");
				})
				.catch(() => undefined);
			expect(await stream.waitFor(isContentInvalidation, 1_000)).toBeNull();

			await getTestDb().begin(async (tx) => {
				await insertEvent(
					{ entityIds: [], organizationId: org.id, originId: "committed", semanticType: "note", title: "committed" },
					{ sql: tx as never },
				);
			});
			expect(await stream.waitFor(isContentInvalidation)).not.toBeNull();
		} finally {
			stream.close();
		}
	}, 30_000);

	it("tells connected clients to refetch after the listener connection drops", async () => {
		const org = await createTestOrganization({ name: "Invalidation Gap Org" });
		const stream = await openStream(org.id);
		try {
			const before = stream.frames.length;
			// Kill this process's LISTEN backend: NOTIFYs sent before it
			// re-subscribes are lost, so clients must re-read durable state.
			await getTestDb()`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = current_database()
				  AND pid <> pg_backend_pid()
				  AND query ILIKE 'listen%'
			`;
			const resync = await stream.waitFor((frame) => frame.startsWith("event: connected"), 10_000, before);
			expect(resync).not.toBeNull();

			// And delivery works again over the re-established subscription.
			await insertEventInOtherProcess(org.id, `after-gap-${Date.now()}`);
			expect(await stream.waitFor(isContentInvalidation)).not.toBeNull();
		} finally {
			stream.close();
		}
	}, 60_000);

	it("does not invalidate content for the audit row a read writes, so a refetch cannot loop", async () => {
		// Every tool call, reads included, appends a tool-invocation audit event.
		// If that row invalidated content, each refetch would trigger the next.
		const org = await createTestOrganization({ name: "Invalidation Read Org" });
		const user = await createTestUser({ email: "invalidation-read@test.com" });
		await addUserToOrganization(user.id, org.id, "owner");
		const ctx: AuthContext = {
			organizationId: org.id,
			tokenOrganizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			agentId: null,
			requestedAgentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			requestUrl: `http://localhost/api/${org.id}`,
			baseUrl: "",
			scopedToOrg: true,
			allowCrossOrg: false,
		};
		const env = { ENVIRONMENT: "test", DATABASE_URL: process.env.DATABASE_URL } as Env;
		const stream = await openStream(org.id);
		try {
			await executeTool("read_knowledge", { limit: 5 }, env, ctx);
			const audits = await getTestDb()`
				SELECT id FROM events
				WHERE organization_id = ${org.id} AND origin_type = 'tool_invocation'
			`;
			expect(audits.length).toBeGreaterThan(0);
			expect(await stream.waitFor(isContentInvalidation, 1_000)).toBeNull();
		} finally {
			stream.close();
		}
	}, 30_000);
});
