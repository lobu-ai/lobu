/**
 * Inbound webhook ingest (#1235) — the push-source primitive.
 *
 * Three layers under test against a real Postgres:
 *
 *  1. `handleWebhookIngest` request pipeline: token auth (bearer / dedicated
 *     header / opt-in query param, constant-time, fail-closed), the 256 KB
 *     body cap, JSON validation, payload wrapping, title extraction, dedupe
 *     (configured header vs body hash), and persist-before-ack semantics.
 *  2. The `events_webhook_ingest_dedupe` partial unique index: concurrent
 *     duplicates collapse to one row at the database layer, independent of
 *     the handler's pre-check.
 *  3. `ChatInstanceManager` wiring: `platform: "webhook"` is adapterless
 *     (no instance started), auto-generates a bearer token at create,
 *     persists it as a `secret://` ref, and `handleIngestWebhook` round-trips
 *     a delivery through the real org-scoped secret store.
 */

import { createHmac } from "node:crypto";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import {
	ensureDbForGatewayTests,
	ensureEncryptionKey,
	resetTestDatabase,
	seedAgentRow,
	seedOrgMembership,
} from "./helpers/db-setup.js";
const ORG = "org-webhook";
const AGENT = "agent-webhook";
const TOKEN = "whk-test-token-0123456789abcdef";
const SIG_SECRET = "whk-sig-secret-0123456789abcdef";
const JIRA_CLIENT_SECRET = "jira-client-secret";

/** Compute a provider HMAC signature header value over the exact raw bytes. */
function sign(
	rawBody: string,
	{
		secret = SIG_SECRET,
		algorithm = "sha256",
		prefix = "",
	}: { secret?: string; algorithm?: "sha256" | "sha1"; prefix?: string } = {},
): string {
	return prefix + createHmac(algorithm, secret).update(rawBody).digest("hex");
}

/** GitHub-style signature config: prefixed sha256 in x-hub-signature-256. */
const githubSigConfig = {
	signatureHeader: "x-hub-signature-256",
	algorithm: "sha256",
	signaturePrefix: "sha256=",
	signatureSecret: SIG_SECRET,
};

function signAtlassianWebhookJwt(secret = JIRA_CLIENT_SECRET): string {
	const encodedHeader = Buffer.from(
		JSON.stringify({ alg: "HS256", typ: "JWT" }),
	).toString("base64url");
	const encodedPayload = Buffer.from(
		JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 }),
	).toString("base64url");
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const signature = createHmac("sha256", secret)
		.update(signingInput)
		.digest("base64url");
	return `${signingInput}.${signature}`;
}

beforeAll(async () => {
	await ensureDbForGatewayTests();
}, 60_000);

beforeEach(async () => {
	await resetTestDatabase();
	ensureEncryptionKey();
	const { resetRateLimiterForTests } = await import(
		"../../utils/rate-limiter.js"
	);
	resetRateLimiterForTests();
}, 30_000);

/** Plaintext-only fake; the manager-level test exercises the real store. */
const fakeSecretStore = {
	get: async () => null,
};

function storedRow(
	overrides: Partial<Record<string, unknown>> = {},
	config: Record<string, unknown> = {},
) {
	return {
		id: "whk1",
		platform: "webhook",
		agentId: AGENT,
		organizationId: ORG,
		config: { platform: "webhook", token: TOKEN, ...config },
		settings: { allowGroups: true },
		metadata: {},
		status: "active",
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	} as any;
}

function delivery(
	body: unknown,
	init: { headers?: Record<string, string>; query?: string; raw?: string } = {},
) {
	return new Request(
		`http://gateway.test/api/v1/webhooks/whk1${init.query ?? ""}`,
		{
			method: "POST",
			body: init.raw ?? JSON.stringify(body),
			headers: { "content-type": "application/json", ...(init.headers ?? {}) },
		},
	);
}

const bearer = { authorization: `Bearer ${TOKEN}` };

async function ingest(
	row: ReturnType<typeof storedRow>,
	request: Request,
	peerAddress?: string | null,
): Promise<Response> {
	const { handleWebhookIngest } = await import(
		"../connections/webhook-ingest.js"
	);
	return handleWebhookIngest(row, request, fakeSecretStore, peerAddress);
}

async function eventRows(connectionId = "whk1"): Promise<any[]> {
	const { getDb } = await import("../../db/client.js");
	return getDb()`
    SELECT * FROM events
    WHERE connector_key = ${`webhook:${connectionId}`}
    ORDER BY id
  `;
}

async function seedWebhookEventAutomation({
	connectionId,
	semanticType = "alert",
}: {
	connectionId: number;
	semanticType?: string;
}): Promise<number> {
	const { getDb } = await import("../../db/client.js");
	const sql = getDb();
	const creatorId = "webhook-automation-owner";
	await sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
		VALUES (${creatorId}, 'Webhook owner', 'webhook-owner@test.example', true, now(), now())
		ON CONFLICT (id) DO NOTHING
	`;
	return sql.begin(async (tx) => {
		const [automation] = await tx<{ id: number }>`
			WITH next_id AS (SELECT nextval('automations_id_seq')::integer AS id)
			INSERT INTO automations (
				id, automation_group_id, organization_id, managed_agent_id, created_by,
				name, slug, status, triggers
			)
			SELECT id, id, ${ORG}, ${AGENT}, ${creatorId},
			       'Webhook alert processor', 'webhook-alert-' || id, 'active',
			       ${tx.json([
								{
									kind: "event",
									source: "connector",
									connector_key: "webhook",
									connection_id: connectionId,
									event_types: ["delivery.received"],
									match: { semantic_type: semanticType },
									execution: "turn",
									active_run: "queue",
									output: "silent",
									skip_if_unchanged: true,
								},
							])}::jsonb
			FROM next_id
			RETURNING id
		`;
		const [version] = await tx<{ id: number }>`
			INSERT INTO automation_versions (
				automation_id, version, name, prompt, version_sources,
				change_notes, created_by
			) VALUES (
				${automation.id}, 1, 'Webhook alert processor',
				'Process the incoming alert.', '[]'::jsonb,
				'Test webhook activation', ${creatorId}
			)
			RETURNING id
		`;
		await tx`
			UPDATE automations SET current_version_id = ${version.id}
			WHERE id = ${automation.id}
		`;
		return Number(automation.id);
	});
}

describe("handleWebhookIngest auth", () => {
	test("accepts Authorization: Bearer and persists the event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery({ hello: "world" }, { headers: bearer }),
		);
		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(typeof body.id).toBe("number");

		const rows = await eventRows();
		expect(rows.length).toBe(1);
		expect(rows[0].payload_data).toEqual({ hello: "world" });
		expect(rows[0].payload_type).toBe("json_template");
		expect(rows[0].semantic_type).toBe("content");
		expect(rows[0].entity_ids).toBeNull();
		expect(rows[0].metadata.webhook_connection_id).toBe("whk1");
		expect(rows[0].metadata.dedupe_source).toBe("body-hash");
	});

	test("accepts the x-lobu-webhook-token header", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery({ a: 1 }, { headers: { "x-lobu-webhook-token": TOKEN } }),
		);
		expect(res.status).toBe(202);
	});

	test("rejects a wrong token and persists nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery({ a: 1 }, { headers: { authorization: "Bearer nope" } }),
		);
		expect(res.status).toBe(401);
		expect((await eventRows()).length).toBe(0);
	});

	test("rejects a missing token", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(storedRow(), delivery({ a: 1 }));
		expect(res.status).toBe(401);
	});

	test("fails closed when the connection has no resolvable token", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const row = storedRow();
		delete row.config.token;
		const res = await ingest(row, delivery({ a: 1 }, { headers: bearer }));
		expect(res.status).toBe(401);
	});

	test("query token is rejected unless allowQueryAuth is enabled", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const denied = await ingest(
			storedRow(),
			delivery({ a: 1 }, { query: `?token=${TOKEN}` }),
		);
		expect(denied.status).toBe(401);

		const allowed = await ingest(
			storedRow({}, { allowQueryAuth: true }),
			delivery({ a: 1 }, { query: `?token=${TOKEN}` }),
		);
		expect(allowed.status).toBe(202);

		// `lobu apply` configs carry strings — the string spelling counts too.
		const allowedString = await ingest(
			storedRow({ id: "whk2" }, { allowQueryAuth: "true" }),
			delivery({ b: 2 }, { query: `?token=${TOKEN}` }),
		);
		expect(allowedString.status).toBe(202);
	});

	test("refuses an org-less row", async () => {
		const res = await ingest(
			storedRow({ organizationId: undefined }),
			delivery({ a: 1 }, { headers: bearer }),
		);
		expect(res.status).toBe(500);
	});
});

describe("handleWebhookIngest signature auth (connector webhooks)", () => {
	/** A signature-only connection — GitHub/Linear/Jira sign, no bearer token. */
	function sigRow(
		config: Record<string, unknown>,
		overrides: Partial<Record<string, unknown>> = {},
	) {
		const row = storedRow(overrides, config);
		delete row.config.token; // provider authenticates by signature, not bearer
		return row;
	}

	test("GitHub-style: a valid x-hub-signature-256 lands the raw event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({
			action: "opened",
			issue: { number: 7, title: "Bug" },
		});
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw,
				headers: {
					"x-github-event": "issues",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(202);
		const rows = await eventRows();
		expect(rows.length).toBe(1);
		// EL: the raw payload lands verbatim — no transform on ingest.
		expect(rows[0].payload_data).toEqual({
			action: "opened",
			issue: { number: 7, title: "Bug" },
		});
	});

	test("Linear-style: a valid prefix-less linear-signature lands the event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({ type: "Issue", action: "create" });
		const res = await ingest(
			sigRow({
				signatureHeader: "linear-signature",
				algorithm: "sha256",
				signatureSecret: SIG_SECRET,
			}),
			delivery(null, { raw, headers: { "linear-signature": sign(raw) } }),
		);
		expect(res.status).toBe(202);
		expect((await eventRows()).length).toBe(1);
	});

	test("rejects an invalid signature and persists nothing", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({ issue: 1 });
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw,
				headers: { "x-hub-signature-256": "sha256=deadbeef" },
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows()).length).toBe(0);
	});

	test("rejects a tampered body (signature over different bytes)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const signedOver = JSON.stringify({ issue: 1 });
		const tampered = JSON.stringify({ issue: 999 });
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw: tampered,
				headers: {
					"x-hub-signature-256": sign(signedOver, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows()).length).toBe(0);
	});

	test("rejects a missing signature header", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(sigRow(githubSigConfig), delivery({ issue: 1 }));
		expect(res.status).toBe(401);
	});

	test("rejects a wrong secret", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({ issue: 1 });
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw,
				headers: {
					"x-hub-signature-256": sign(raw, {
						secret: "the-wrong-secret",
						prefix: "sha256=",
					}),
				},
			}),
		);
		expect(res.status).toBe(401);
	});

	test("rejects a right-length non-hex signature with a clean 401 (no throw)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const raw = JSON.stringify({ issue: 1 });
		// 64 chars = sha256 hex length, but non-hex → Buffer.from(hex) truncates;
		// must still be a clean 401, not a 500 from timingSafeEqual length mismatch.
		const res = await ingest(
			sigRow(githubSigConfig),
			delivery(null, {
				raw,
				headers: { "x-hub-signature-256": `sha256=${"z".repeat(64)}` },
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows()).length).toBe(0);
	});

	test("token still authenticates when both token and signature are configured", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		// Connection carries a bearer token AND signature config; a valid bearer
		// with no signature header must still pass (token short-circuits pre-body).
		const res = await ingest(
			storedRow({}, githubSigConfig),
			delivery({ a: 1 }, { headers: bearer }),
		);
		expect(res.status).toBe(202);
		expect((await eventRows()).length).toBe(1);
	});

	test("redelivery dedupes on x-github-delivery under signature auth", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const config = { ...githubSigConfig, dedupeHeader: "x-github-delivery" };
		const raw1 = JSON.stringify({ run: 1 });
		const first = await ingest(
			sigRow(config),
			delivery(null, {
				raw: raw1,
				headers: {
					"x-github-delivery": "gh-d-1",
					"x-hub-signature-256": sign(raw1, { prefix: "sha256=" }),
				},
			}),
		);
		const raw2 = JSON.stringify({ run: 2 });
		const dup = await ingest(
			sigRow(config),
			delivery(null, {
				raw: raw2,
				headers: {
					"x-github-delivery": "gh-d-1",
					"x-hub-signature-256": sign(raw2, { prefix: "sha256=" }),
				},
			}),
		);
		expect(first.status).toBe(202);
		expect((await dup.json()).duplicate).toBe(true);
		const rows = await eventRows();
		expect(rows.length).toBe(1);
		expect(rows[0].origin_id).toBe("gh-d-1");
	});
});

describe("handleWebhookIngest body handling", () => {
	test("413 on a body over the cap (Content-Length honest)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const huge = JSON.stringify({ pad: "x".repeat(300 * 1024) });
		const res = await ingest(
			storedRow(),
			delivery(null, { raw: huge, headers: bearer }),
		);
		expect(res.status).toBe(413);
		expect((await eventRows()).length).toBe(0);
	});

	test("413 when Content-Length lies (capped streaming read)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const huge = JSON.stringify({ pad: "y".repeat(300 * 1024) });
		// Hand-built stream so the runtime can't compute an honest length.
		const request = new Request("http://gateway.test/api/v1/webhooks/whk1", {
			method: "POST",
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(huge));
					controller.close();
				},
			}),
			headers: { ...bearer, "content-length": "10" },
			// @ts-expect-error duplex is required for streaming bodies in Node
			duplex: "half",
		});
		const res = await ingest(storedRow(), request);
		expect(res.status).toBe(413);
	});

	test("400 on a non-JSON body", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery(null, { raw: "not json {", headers: bearer }),
		);
		expect(res.status).toBe(400);
	});

	test("wraps array and primitive roots so payload_data stays an object", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow(),
			delivery([1, 2, 3], { headers: bearer }),
		);
		expect(res.status).toBe(202);
		const rows = await eventRows();
		expect(rows[0].payload_data).toEqual({ payload: [1, 2, 3] });
	});

	test("wraps primitive roots so payload_data stays an object", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(storedRow(), delivery(42, { headers: bearer }));
		expect(res.status).toBe(202);
		const rows = await eventRows();
		expect(rows[0].payload_data).toEqual({ payload: 42 });
	});

	test("extracts title via titlePath and stamps configured semanticType", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const res = await ingest(
			storedRow({}, { titlePath: "/event/title", semanticType: "alert" }),
			delivery(
				{ event: { title: "ZeroDivisionError in worker" } },
				{ headers: bearer },
			),
		);
		expect(res.status).toBe(202);
		const rows = await eventRows();
		expect(rows[0].title).toBe("ZeroDivisionError in worker");
		expect(rows[0].semantic_type).toBe("alert");
	});

	test("ignores non-canonical array indexes in titlePath", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const invalidEmpty = await ingest(
			storedRow({}, { titlePath: "/items/" }),
			delivery({ items: ["first"] }, { headers: bearer }),
		);
		const invalidLeadingZero = await ingest(
			storedRow({}, { titlePath: "/items/01" }),
			delivery({ items: ["first", "second"] }, { headers: bearer }),
		);

		expect(invalidEmpty.status).toBe(202);
		expect(invalidLeadingZero.status).toBe(202);
		const rows = await eventRows();
		expect(rows.map((row) => row.title)).toEqual([null, null]);
	});

	test("a missing titlePath target leaves the title null", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await ingest(
			storedRow({}, { titlePath: "/nope/missing" }),
			delivery({ event: {} }, { headers: bearer }),
		);
		const rows = await eventRows();
		expect(rows[0].title).toBeNull();
	});

	test("searchable:true renders payload_text so the row is embeddable", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await ingest(
			storedRow({}, { semanticType: "alert", searchable: true }),
			delivery(
				{ event: { title: "ZeroDivisionError", level: "error" } },
				{ headers: bearer },
			),
		);
		const rows = await eventRows();
		// Non-empty payload_text is the gate the embed-backfill keys on; the
		// flattened "path: value" projection carries searchable tokens.
		expect(rows[0].payload_text).toContain("event.title: ZeroDivisionError");
		expect(rows[0].payload_text).toContain("event.level: error");
	});

	test("default (searchable off) leaves payload_text null — store-only", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await ingest(
			storedRow({}, { semanticType: "alert" }),
			delivery({ event: { title: "ZeroDivisionError" } }, { headers: bearer }),
		);
		const rows = await eventRows();
		// No payload_text → embed-backfill skips it → never enters semantic
		// memory; the row is still reachable by Automation SQL on connector_key.
		expect(rows[0].payload_text).toBeNull();
	});
});

describe("handleWebhookIngest idempotency", () => {
	test("redelivery of an identical body is a no-op returning the original id", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const first = await ingest(
			storedRow(),
			delivery({ issue: 42 }, { headers: bearer }),
		);
		const second = await ingest(
			storedRow(),
			delivery({ issue: 42 }, { headers: bearer }),
		);
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		const a = await first.json();
		const b = await second.json();
		expect(b.id).toBe(a.id);
		expect(b.duplicate).toBe(true);
		expect((await eventRows()).length).toBe(1);
	});

	test("dedupeHeader takes precedence over the body hash", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const row = storedRow({}, { dedupeHeader: "x-github-delivery" });
		await ingest(
			row,
			delivery(
				{ run: 1 },
				{ headers: { ...bearer, "x-github-delivery": "d-1" } },
			),
		);
		// Different body, same delivery id → duplicate.
		const dup = await ingest(
			row,
			delivery(
				{ run: 2 },
				{ headers: { ...bearer, "x-github-delivery": "d-1" } },
			),
		);
		expect((await dup.json()).duplicate).toBe(true);

		const rows = await eventRows();
		expect(rows.length).toBe(1);
		expect(rows[0].origin_id).toBe("d-1");
		expect(rows[0].metadata.dedupe_source).toBe("header");
	});

	test("a configured-but-absent dedupe header falls back to the body hash", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		await ingest(
			storedRow({}, { dedupeHeader: "x-github-delivery" }),
			delivery({ run: 1 }, { headers: bearer }),
		);
		const rows = await eventRows();
		expect(rows[0].metadata.dedupe_source).toBe("body-hash");
	});

	test("concurrent identical deliveries collapse to one row, both acked", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const responses = await Promise.all(
			Array.from({ length: 5 }, () =>
				ingest(storedRow(), delivery({ burst: true }, { headers: bearer })),
			),
		);
		for (const res of responses) {
			expect(res.status).toBe(202);
		}
		expect((await eventRows()).length).toBe(1);
	});

	test("the partial unique index rejects duplicates at the database layer", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { insertEvent } = await import("../../utils/insert-event.js");
		const params = {
			entityIds: [],
			organizationId: ORG,
			originId: "same-origin",
			connectorKey: "webhook:whk1",
			semanticType: "content",
			payloadType: "json_template" as const,
			payloadData: { n: 1 },
		};
		await insertEvent(params);
		let code: string | undefined;
		try {
			await insertEvent({ ...params, payloadData: { n: 2 } });
		} catch (error) {
			code = (error as { code?: string }).code;
		}
		expect(code).toBe("23505");

		// Non-webhook connector keys stay outside the partial index.
		await insertEvent({
			...params,
			connectorKey: "github",
			payloadData: { n: 3 },
		});
		await insertEvent({
			...params,
			connectorKey: "github",
			payloadData: { n: 4 },
		});
	});
});

describe("handleWebhookIngest rate limiting", () => {
	// The limiter derives its fixed window from Date.now(), so on a slow runner
	// the 60s window can roll over mid-loop, refill the budget, and no request
	// ever 429s (#2073). Freeze the clock at a window start so every request in
	// a limit+1 loop deterministically lands in one window, regardless of how
	// long the loop takes in real time.
	beforeEach(() => {
		const nowSec = Math.floor(Date.now() / 1000);
		setSystemTime(new Date((nowSec - (nowSec % 60)) * 1000));
	});

	afterEach(() => {
		setSystemTime(); // restore real time for the rest of the process
	});

	test("429 once the authenticated per-connection budget is exhausted", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { WEBHOOK_INGEST_RATE_LIMIT } = await import(
			"../connections/webhook-ingest.js"
		);
		let limited: Response | undefined;
		for (let i = 0; i <= WEBHOOK_INGEST_RATE_LIMIT.limit; i++) {
			const res = await ingest(
				storedRow(),
				delivery({ i }, { headers: bearer }),
			);
			if (res.status === 429) {
				limited = res;
				break;
			}
		}
		expect(limited).toBeDefined();
		expect(limited!.headers.get("retry-after")).toBeTruthy();
	});

	test("unauthenticated floods cannot starve the authenticated budget", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { WEBHOOK_INGEST_RATE_LIMIT } = await import(
			"../connections/webhook-ingest.js"
		);
		// The pi-review repro: exhaust the old shared budget with bad tokens,
		// then deliver with the real one. The valid delivery must still land.
		for (let i = 0; i <= WEBHOOK_INGEST_RATE_LIMIT.limit; i++) {
			const res = await ingest(
				storedRow(),
				delivery({ i }, { headers: { authorization: "Bearer wrong" } }),
			);
			expect(res.status).toBe(401);
		}
		const valid = await ingest(
			storedRow(),
			delivery({ legit: true }, { headers: bearer }),
		);
		expect(valid.status).toBe(202);
	});

	test("a flooding source IP exhausts only its own pre-auth bucket", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { WEBHOOK_INGEST_PREAUTH_RATE_LIMIT } = await import(
			"../connections/webhook-ingest.js"
		);
		// Flood past the pre-auth budget from one source address. The source is
		// the socket peer address (getClientIP ignores X-Forwarded-For unless
		// TRUSTED_PROXY is set), so we drive it via the peerAddress arg.
		let flooderLimited = false;
		for (let i = 0; i <= WEBHOOK_INGEST_PREAUTH_RATE_LIMIT.limit; i++) {
			const res = await ingest(
				storedRow(),
				delivery({ i }, { headers: { authorization: "Bearer wrong" } }),
				"203.0.113.7",
			);
			if (res.status === 429) {
				flooderLimited = true;
				break;
			}
		}
		expect(flooderLimited).toBe(true);

		// A different source delivering with the real token is unaffected.
		const valid = await ingest(
			storedRow(),
			delivery({ legit: true }, { headers: bearer }),
			"198.51.100.9",
		);
		expect(valid.status).toBe(202);
	});
});

describe("ChatInstanceManager webhook wiring", () => {
	async function buildManager() {
		const { ChatInstanceManager } = await import(
			"../connections/chat-instance-manager.js"
		);
		const { createPostgresAgentConnectionStore } = await import(
			"../../lobu/stores/postgres-stores.js"
		);
		const { PostgresSecretStore } = await import(
			"../../lobu/stores/postgres-secret-store.js"
		);
		const { SecretStoreRegistry } = await import("../secrets/index.js");

		const connectionStore = createPostgresAgentConnectionStore();
		const postgresSecretStore = new PostgresSecretStore();
		const secretStore = new SecretStoreRegistry(postgresSecretStore, {
			secret: postgresSecretStore,
		});
		const manager = new ChatInstanceManager() as any;
		manager.services = {
			getPublicGatewayUrl: () => "",
			getSecretStore: () => secretStore,
			getConnectionStore: () => connectionStore,
			getAutomationSubscriptionService: () => ({
				resolveForConnection: async () => null,
			}),
			getCommandRegistry: () => undefined,
		};
		manager.publicGatewayUrl = "";
		manager.connectionStore = connectionStore;
		return { manager, connectionStore };
	}

	test("addConnection auto-generates a token, secretizes it, starts no instance", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { manager, connectionStore } = await buildManager();

		const created = await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection("webhook", AGENT, { platform: "webhook" }),
		);

		// Returned once in plaintext at create — strong and non-empty.
		expect(typeof created.config.token).toBe("string");
		expect(created.config.token.length).toBeGreaterThanOrEqual(32);
		// Adapterless: nothing hydrated, nothing to stop.
		expect(manager.instances.size).toBe(0);

		const stored = await orgContext.run({ organizationId: ORG }, () =>
			connectionStore.getConnection(created.id),
		);
		expect(stored.status).toBe("active");
		expect(String(stored.config.token).startsWith("secret://")).toBe(true);
	});

	test("connections.create and manageAutomations reach the public webhook path", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const ownerId = "webhook-create-owner";
		await seedOrgMembership(ORG, ownerId, "owner");
		const { manager } = await buildManager();
		const { __setChatInstanceManagerForTests } = await import(
			"../../lobu/gateway.js"
		);
		const { manageConnections } = await import(
			"../../tools/admin/manage_connections.js"
		);
		const { manageAutomations } = await import(
			"../../tools/admin/manage_automations.js"
		);
		const token = "supported-create-webhook-token-0123456789";
		const toolContext = {
			organizationId: ORG,
			userId: ownerId,
			memberRole: "owner",
			agentId: null,
			isAuthenticated: true,
			clientId: null,
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			tokenType: "oauth",
			scopedToOrg: true,
			allowCrossOrg: false,
			baseUrl: "https://gateway.test/lobu",
		} as never;
		__setChatInstanceManagerForTests(manager);
		try {
			const missingSlug = await manageConnections(
				{
					action: "create",
					connector_key: "webhook",
					display_name: "Missing slug webhook",
					config: { token },
				},
				{} as never,
				toolContext,
			);
			expect(
				"error" in missingSlug ? missingSlug.error : undefined,
			).toBeUndefined();
			if (!("connection" in missingSlug))
				throw new Error("expected connection");
			expect((missingSlug.connection as { slug: string }).slug).toMatch(
				/^agentconn-missing-slug-webhook-[0-9a-f]{6}$/,
			);

			const missingToken = await manageConnections(
				{
					action: "create",
					connector_key: "webhook",
					slug: "missing-token-webhook",
					display_name: "Missing token webhook",
				},
				{} as never,
				toolContext,
			);
			expect("error" in missingToken ? missingToken.error : "").toMatch(
				/token/i,
			);

			const numericSlug = await manageConnections(
				{
					action: "create",
					connector_key: "webhook",
					slug: "12345",
					display_name: "Numeric webhook",
					config: { token },
				},
				{} as never,
				toolContext,
			);
			expect("error" in numericSlug ? numericSlug.error : "").toMatch(
				/cannot be numeric/i,
			);

			const created = await manageConnections(
				{
					action: "create",
					connector_key: "webhook",
					slug: "supported-webhook",
					display_name: "Supported webhook",
					config: { token, semanticType: "deployment" },
				},
				{} as never,
				toolContext,
			);
			expect("error" in created ? created.error : undefined).toBeUndefined();
			if (!("connection" in created)) {
				throw new Error(
					"Webhook connection creation did not return a connection",
				);
			}
			const connectionId = Number((created.connection as { id: number }).id);
			const automation = await manageAutomations(
				{
					action: "create",
					slug: "supported-webhook-automation",
					name: "Supported webhook Automation",
					prompt: "Process the incoming deployment.",
					managed_agent_id: AGENT,
					triggers: [
						{
							kind: "event",
							source: "connector",
							connector_key: "webhook",
							connection_id: connectionId,
							event_types: ["delivery.received"],
							match: { semantic_type: "deployment" },
							execution: "turn",
							active_run: "queue",
							output: "silent",
							skip_if_unchanged: true,
						},
					],
				},
				{} as never,
				toolContext,
			);
			if (automation.action !== "create" || !("automation_id" in automation)) {
				throw new Error("Webhook Automation creation did not complete");
			}

			const response = await manager.handleIngestWebhook(
				"supported-webhook",
				new Request("http://gateway.test/api/v1/webhooks/supported-webhook", {
					method: "POST",
					body: JSON.stringify({ version: "2026.08.31" }),
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
					},
				}),
			);
			expect(response.status).toBe(202);
			const rows = await eventRows("supported-webhook");
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				semantic_type: "deployment",
				payload_data: { version: "2026.08.31" },
			});
			const { getDb } = await import("../../db/client.js");
			const [runCount] = await getDb()<{ count: number }[]>`
				SELECT count(*)::integer AS count
				FROM runs
				WHERE automation_id = ${Number(automation.automation_id)}
				  AND run_type = 'automation'
			`;
			expect(runCount?.count).toBe(1);
		} finally {
			__setChatInstanceManagerForTests(null);
		}
	});

	test("handleIngestWebhook round-trips a delivery through the real secret store", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { manager } = await buildManager();

		const created = await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection("webhook", AGENT, {
				platform: "webhook",
				allowQueryAuth: true,
				semanticType: "alert",
				titlePath: "/event/title",
			}),
		);
		const token = created.config.token as string;

		// No ambient org context — the manager must scope to the row's org.
		const res = await manager.handleIngestWebhook(
			created.id,
			new Request(
				`http://gateway.test/api/v1/webhooks/${created.id}?token=${token}`,
				{
					method: "POST",
					body: JSON.stringify({ event: { title: "Sentry issue" } }),
					headers: { "content-type": "application/json" },
				},
			),
		);
		expect(res.status).toBe(202);

		const rows = await eventRows(created.id);
		expect(rows.length).toBe(1);
		expect(rows[0].title).toBe("Sentry issue");
		expect(rows[0].semantic_type).toBe("alert");
		expect(rows[0].organization_id).toBe(ORG);
	});

	test("persists, activates, scopes, and deduplicates a generic delivery", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { runtimeConnectionIdToSlug } = await import(
			"../../lobu/stores/connections-projection.js"
		);
		const { getDb } = await import("../../db/client.js");
		const { manager } = await buildManager();

		const created = await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection("webhook", AGENT, {
				platform: "webhook",
				semanticType: "alert",
				titlePath: "/title",
			}),
		);
		const token = created.config.token as string;
		const sql = getDb();
		const [connection] = await sql<{ id: number }>`
			SELECT id FROM connections
			WHERE organization_id = ${ORG}
			  AND connector_key = 'webhook'
			  AND slug = ${runtimeConnectionIdToSlug(created.id)}
			LIMIT 1
		`;
		if (!connection)
			throw new Error("Webhook connection projection was not created");

		const automationId = await seedWebhookEventAutomation({
			connectionId: Number(connection.id),
		});

		const makeRequest = () =>
			new Request(`http://gateway.test/api/v1/webhooks/${created.id}`, {
				method: "POST",
				body: JSON.stringify({
					title: "Database unavailable",
					severity: "critical",
				}),
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
			});
		const concurrent = await Promise.all(
			Array.from({ length: 6 }, () =>
				manager.handleIngestWebhook(created.id, makeRequest()),
			),
		);
		expect(concurrent.every((response) => response.status === 202)).toBe(true);
		const concurrentBodies = (await Promise.all(
			concurrent.map((response) => response.json()),
		)) as Array<{ id: number; duplicate?: boolean }>;
		expect(new Set(concurrentBodies.map((body) => body.id)).size).toBe(1);
		expect(concurrentBodies.some((body) => body.duplicate === true)).toBe(true);
		const firstBody = concurrentBodies[0];
		if (!firstBody)
			throw new Error("Webhook delivery returned no response body");

		const runs = await sql<{
			approved_input: Record<string, unknown>;
			status: string;
		}>`
			SELECT approved_input, status FROM runs
			WHERE automation_id = ${automationId}
			  AND run_type = 'automation'
			ORDER BY id
		`;
		expect(runs).toHaveLength(1);
		expect(runs[0]?.approved_input).toMatchObject({
			dispatch_source: "event",
			trigger_execution: "turn",
			delivery_ids: [`webhook:event:${firstBody.id}`],
			trigger_signal: {
				connector_key: "webhook",
				connection_id: Number(connection.id),
				event_type: "delivery.received",
				attributes: {
					semantic_type: "alert",
				},
			},
		});
		const [event] = await sql<{ connection_id: number }>`
			SELECT connection_id FROM events WHERE id = ${firstBody.id}
		`;
		expect(Number(event?.connection_id)).toBe(Number(connection.id));

		const other = await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection("webhook", AGENT, {
				platform: "webhook",
				semanticType: "alert",
			}),
		);
		const otherResponse = await manager.handleIngestWebhook(
			other.id,
			new Request(`http://gateway.test/api/v1/webhooks/${other.id}`, {
				method: "POST",
				body: JSON.stringify({ title: "Different connection" }),
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${String(other.config.token)}`,
				},
			}),
		);
		expect(otherResponse.status).toBe(202);

		const { normalizeAutomationSources } = await import(
			"../../automations/source-refs.js"
		);
		const { executeDataSources } = await import(
			"../../utils/execute-data-sources.js"
		);
		const [source] = await normalizeAutomationSources(sql, ORG, [
			{ name: "incoming", query: `@connection:${connection.id}` },
		]);
		const readback = await executeDataSources(
			[{ name: source.name, query: source.query }],
			{ organizationId: ORG },
			sql,
		);
		expect(readback.incoming).toHaveLength(1);
		expect(readback.incoming?.[0]).toMatchObject({
			id: firstBody.id,
			connection_id: Number(connection.id),
			payload_data: {
				title: "Database unavailable",
				severity: "critical",
			},
		});

		const [{ count }] = await sql<{ count: number }>`
			SELECT count(*)::int AS count FROM runs
			WHERE automation_id = ${automationId} AND run_type = 'automation'
		`;
		expect(count).toBe(1);
	});

	test("a stopped webhook connection refuses deliveries with 404", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { manager } = await buildManager();

		const created = await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection("webhook", AGENT, { platform: "webhook" }),
		);
		const token = created.config.token as string;
		await orgContext.run({ organizationId: ORG }, () =>
			manager.stopConnection(created.id),
		);

		const res = await manager.handleIngestWebhook(
			created.id,
			new Request(`http://gateway.test/api/v1/webhooks/${created.id}`, {
				method: "POST",
				body: JSON.stringify({ dropped: true }),
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
			}),
		);
		expect(res.status).toBe(404);
		expect((await eventRows(created.id)).length).toBe(0);
	});

	test("handleIngestWebhook 404s for unknown ids and non-webhook platforms", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { manager, connectionStore } = await buildManager();

		const missing = await manager.handleIngestWebhook(
			"nope",
			new Request("http://gateway.test/api/v1/webhooks/nope", {
				method: "POST",
			}),
		);
		expect(missing.status).toBe(404);

		await orgContext.run({ organizationId: ORG }, () =>
			connectionStore.saveConnection({
				id: "tg1",
				platform: "telegram",
				agentId: AGENT,
				organizationId: ORG,
				config: { platform: "telegram", botToken: "12345:fake" },
				settings: { allowGroups: true },
				metadata: {},
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		const wrongPlatform = await manager.handleIngestWebhook(
			"tg1",
			new Request("http://gateway.test/api/v1/webhooks/tg1", {
				method: "POST",
			}),
		);
		expect(wrongPlatform.status).toBe(404);
	});

	// Full wired path: the REAL Hono route → ChatInstanceManager →
	// handleWebhookIngest → real Postgres. This is what an actual provider
	// delivery exercises (vs. the unit tests above that call the handler
	// directly). We hold the signing secret, so we compute a real GitHub-style
	// HMAC — the only thing not covered is the live-OAuth `registerWebhook` call
	// and the provider's own POST, which need real credentials + a public URL.
	async function registeredGithubConnection(
		connectionStore: any,
	): Promise<string> {
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const id = "whk-gh-e2e";
		// Simulate a connection AFTER registration stamped the scheme + secret.
		await orgContext.run({ organizationId: ORG }, () =>
			connectionStore.saveConnection({
				id,
				platform: "webhook",
				agentId: AGENT,
				organizationId: ORG,
				config: {
					platform: "webhook",
					...githubSigConfig,
					dedupeHeader: "x-github-delivery",
					semanticType: "issue",
				},
				settings: { allowGroups: true },
				metadata: {},
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
		);
		return id;
	}

	test("e2e: a signed GitHub delivery routes through the real endpoint and lands", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, connectionStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await registeredGithubConnection(connectionStore);
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({
			action: "opened",
			issue: { number: 11, title: "Prod is down" },
			repository: { full_name: "acme/api" },
		});
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-github-event": "issues",
					"x-github-delivery": "gh-e2e-1",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(202);

		const rows = await eventRows(id);
		expect(rows.length).toBe(1);
		// EL: the raw GitHub payload is what landed — untransformed.
		expect(rows[0].payload_data).toEqual({
			action: "opened",
			issue: { number: 11, title: "Prod is down" },
			repository: { full_name: "acme/api" },
		});
		expect(rows[0].origin_id).toBe("gh-e2e-1");
		expect(rows[0].semantic_type).toBe("issue");
		expect(rows[0].organization_id).toBe(ORG);
	});

	test("e2e: the real endpoint rejects a forged signature with 401", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, connectionStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await registeredGithubConnection(connectionStore);
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({ action: "opened", issue: { number: 12 } });
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-github-event": "issues",
					"x-hub-signature-256": "sha256=forged",
				},
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows(id)).length).toBe(0);
	});
});

/**
 * Two-table bridge: a CONNECTOR webhook (rows in the `connections` table, NOT
 * `agent_connections`). A connector registers a provider webhook at connect
 * time and stamps the verification scheme + a `secret://` signing-secret ref
 * onto its `connections.config`. Deliveries arrive at the SAME public route
 * (`/api/v1/webhooks/:connectionId`), miss the `agent_connections` lookup, and
 * are bridged to `handleWebhookIngest` so all the existing protections (HMAC
 * verify, size cap, rate limit, dedupe, connector_key=webhook:<id> index)
 * apply unchanged.
 */
describe("connector-connection webhook bridge (connections table)", () => {
	async function buildManager() {
		const { ChatInstanceManager } = await import(
			"../connections/chat-instance-manager.js"
		);
		const { createPostgresAgentConnectionStore } = await import(
			"../../lobu/stores/postgres-stores.js"
		);
		const { PostgresSecretStore } = await import(
			"../../lobu/stores/postgres-secret-store.js"
		);
		const { SecretStoreRegistry } = await import("../secrets/index.js");

		const connectionStore = createPostgresAgentConnectionStore();
		const postgresSecretStore = new PostgresSecretStore();
		const secretStore = new SecretStoreRegistry(postgresSecretStore, {
			secret: postgresSecretStore,
		});
		const manager = new ChatInstanceManager() as any;
		manager.services = {
			getPublicGatewayUrl: () => "",
			getSecretStore: () => secretStore,
			getConnectionStore: () => connectionStore,
			getAutomationSubscriptionService: () => ({
				resolveForConnection: async () => null,
			}),
			getCommandRegistry: () => undefined,
		};
		manager.publicGatewayUrl = "";
		manager.connectionStore = connectionStore;
		return { manager, secretStore };
	}

	/**
	 * Seed a connector `connections` row that has "registered" a GitHub webhook:
	 * the signing secret is persisted as a real `secret://` ref (under org
	 * context, the same way registerConnectorWebhook does), and the scheme +
	 * ref are stamped onto config under the `webhook_*` keys the bridge reads.
	 * Returns the generated connection id (a bigint, as a string).
	 */
	async function seedRegisteredConnectorConnection(
		secretStore: any,
		overrides: {
			status?: string;
			secret?: string | null;
			connectorKey?: string;
		} = {},
	): Promise<string> {
		const { getDb } = await import("../../db/client.js");
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { persistSecretValue } = await import("../secrets/index.js");

		const secretValue =
			overrides.secret === null ? null : (overrides.secret ?? SIG_SECRET);
		// Insert first to get the generated id, then persist the secret + stamp.
		const connectorKey = overrides.connectorKey ?? "github";
		const inserted = (await getDb()`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, ${connectorKey}, ${`${connectorKey}-${Date.now()}-${Math.random()}`},
				${overrides.status ?? "active"}, ${getDb().json({})})
			RETURNING id
		`) as Array<{ id: number }>;
		const id = String(inserted[0].id);

		const secretRef = secretValue
			? await orgContext.run({ organizationId: ORG }, () =>
					persistSecretValue(
						secretStore,
						`webhook/${id}/signature-secret`,
						secretValue,
					),
				)
			: undefined;

		const config: Record<string, unknown> = {
			webhook_external_id: "gh-hook-123",
			webhook_signature_header: "x-hub-signature-256",
			webhook_algorithm: "sha256",
			webhook_signature_prefix: "sha256=",
			webhook_dedupe_header: "x-github-delivery",
			semanticType: "issue",
			...(secretRef ? { webhook_signature_secret: secretRef } : {}),
		};
		await getDb()`
			UPDATE connections SET config = ${getDb().json(config)} WHERE id = ${id}
		`;
		return id;
	}

	async function seedRegisteredAtlassianConnection(): Promise<{ id: string }> {
		const { getDb } = await import("../../db/client.js");
		const { createAuthProfile } = await import("../../utils/auth-profiles.js");
		const { persistAuthCredentials } = await import(
			"../../utils/auth-credential-secrets.js"
		);
		const sql = getDb();
		const connectorKey = "mcp.mcp-atlassian-com";
		await sql`
			INSERT INTO connector_definitions (
				organization_id, key, name, version, status, mcp_config, feeds_schema
			) VALUES (
				${ORG}, ${connectorKey}, 'Atlassian', '1.0.0', 'active',
				${sql.json({ upstream_url: "https://mcp.atlassian.com/v1/mcp" })},
				${sql.json({ issues: { key: "issues", operations: ["read"] } })}
			)
		`;
		const appProfile = await createAuthProfile({
			organizationId: ORG,
			connectorKey: "jira",
			displayName: "Jira Webhook App",
			slug: "jira-webhook-app",
			profileKind: "oauth_app",
			status: "active",
			provider: "jira",
			createdBy: AGENT,
		});
		await persistAuthCredentials({
			organizationId: ORG,
			authProfileId: appProfile.id,
			credentials: {
				JIRA_CLIENT_ID: "jira-client-id",
				JIRA_CLIENT_SECRET,
			},
		});
		const [connection] = await sql`
			INSERT INTO connections (
				organization_id, connector_key, slug, display_name, status, config, visibility
			) VALUES (
				${ORG}, ${connectorKey}, 'atlassian-rovo', 'Atlassian', 'active',
				${sql.json({
					cloud_id: "cloud-1",
					site_cloud_id: "cloud-1",
					site_url: "https://acme.atlassian.net",
					jira_webhook_app_profile_slug: appProfile.slug,
				})},
				'org'
			)
			RETURNING id
		`;
		const id = String(connection.id);
		await sql`
			INSERT INTO feeds (
				organization_id, connection_id, feed_key, display_name, status, config
			) VALUES (
				${ORG}, ${id}, 'issues', 'Issues', 'active', '{}'::jsonb
			)
		`;
		await sql`
			UPDATE connections
			SET config = config || ${sql.json({
				webhook_external_id: "jira-hook-123",
			})}::jsonb
			WHERE id = ${id}
		`;
		return { id };
	}

	test("a signed GitHub delivery to a connector connection marks the feed due (poll-canonical)", async () => {
		// Clean-cut: OAuth/PAT GitHub webhooks do NOT raw-store under webhook:<id>.
		// They mark the matching feed due so CheckDueFeeds + poll attach
		// automation_signals — same contract as app-webhooks trigger mode.
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const { getDb } = await import("../../db/client.js");
		const id = await seedRegisteredConnectorConnection(secretStore);

		// Route map + feed the delivery should wake.
		await getDb()`
			INSERT INTO connector_definitions (
				organization_id, key, name, status, feeds_schema
			) VALUES (
				${ORG}, 'github', 'GitHub', 'active',
				${getDb().json({
					issues: {
						webhook: { events: ["issues"], mode: "trigger" },
					},
					pull_requests: {
						webhook: { events: ["pull_request"], mode: "trigger" },
					},
				})}
			)
		`;
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		await getDb()`
			INSERT INTO feeds (
					organization_id, connection_id, feed_key, status,
				config, next_run_at, created_at, updated_at
			) VALUES (
					${ORG}, ${id}, 'issues', 'active',
				${getDb().json({ repo_owner: "lobu-ai", repo_name: "lobu" })},
				${future}::timestamptz, current_timestamp, current_timestamp
			)
		`;

		const app = createConnectionWebhookRoutes(manager);
		const raw = JSON.stringify({
			action: "opened",
			issue: { number: 7, title: "Bridge works" },
			repository: {
				full_name: "lobu-ai/lobu",
				name: "lobu",
				owner: { login: "lobu-ai" },
			},
		});
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-github-event": "issues",
					"x-github-delivery": "gh-bridge-1",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(202);
		const body = (await res.json()) as { ok: boolean; triggered?: boolean };
		expect(body.ok).toBe(true);
		expect(body.triggered).toBe(true);

		// No raw webhook:<id> event — poll will produce the canonical github row.
		const rows = await eventRows(id);
		expect(rows.length).toBe(0);

		const [feed] = await getDb()`
			SELECT next_run_at FROM feeds
			WHERE connection_id = ${id} AND feed_key = 'issues'
		`;
		expect(new Date(String(feed.next_run_at)).getTime()).toBeLessThanOrEqual(
			Date.now() + 1000,
		);
	});

	test("a raw provider bridge does not emit the generic webhook Automation event", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { orgContext } = await import("../../lobu/stores/org-context.js");
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const { getDb } = await import("../../db/client.js");
		const id = await seedRegisteredConnectorConnection(secretStore, {
			connectorKey: "linear",
		});
		// Simulate a pre-guard legacy generic webhook with the same numeric runtime
		// id. Provider IDs own numeric URLs, so this row must not shadow the signed
		// connector delivery and turn it into generic bearer-token auth.
		await orgContext.run({ organizationId: ORG }, () =>
			manager.addConnection(
				"webhook",
				AGENT,
				{
					platform: "webhook",
					token: "legacy-numeric-webhook-token-0123456789",
				},
				undefined,
				undefined,
				id,
			),
		);
		const automationId = await seedWebhookEventAutomation({
			connectionId: Number(id),
			semanticType: "issue",
		});
		const app = createConnectionWebhookRoutes(manager);
		const raw = JSON.stringify({ action: "create", issue: { id: "LIN-1" } });
		const response = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-github-delivery": "linear-bridge-1",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);

		expect(response.status).toBe(202);
		const rows = await eventRows(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			connector_key: `webhook:${id}`,
			origin_id: "linear-bridge-1",
			semantic_type: "issue",
		});
		expect(rows[0].connection_id).toBeNull();
		const [{ count }] = await getDb()<{ count: number }>`
			SELECT count(*)::int AS count
			FROM runs
			WHERE automation_id = ${automationId}
			  AND run_type = 'automation'
		`;
		expect(count).toBe(0);
	});

	test("a bridged generic webhook (documented schema keys) activates delivery.received", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const { getDb } = await import("../../db/client.js");
		// Documented optionsSchema keys only (token/dedupeHeader) — no
		// webhook_* registration keys. resolveConnectionWebhookConfig must
		// accept both or ingest 404s forever (H2).
		const docToken = "bridged-doc-token-0123456789abcdef0123456789";
		const inserted = (await getDb()`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, 'webhook', ${`bridged-doc-${Date.now()}-${Math.random()}`},
				'active', ${getDb().json({ token: docToken, semanticType: "alert" })})
			RETURNING id
		`) as Array<{ id: number }>;
		const id = String(inserted[0].id);
		const automationId = await seedWebhookEventAutomation({
			connectionId: Number(id),
		});
		const app = createConnectionWebhookRoutes(manager);
		const raw = JSON.stringify({ hello: "bridged" });
		const response = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${docToken}`,
				},
			}),
		);
		expect(response.status).toBe(202);
		const rows = await eventRows(id);
		expect(rows).toHaveLength(1);
		expect(rows[0].connection_id).toBe(Number(id));
		const runs = await getDb()<{ id: number }>`
			SELECT id FROM runs
			WHERE automation_id = ${automationId}
			  AND run_type = 'automation'
		`;
		expect(runs.length).toBeGreaterThan(0);
	});

	test("a non-webhook connector storing a plain token key still 404s", async () => {
		// The documented-key fallback is gated to connector_key 'webhook': any
		// other connector with a `token` config key must not silently become a
		// bearer-auth receiver.
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const { getDb } = await import("../../db/client.js");
		const otherToken = "linear-plain-token-0123456789abcdef0123456789";
		const inserted = (await getDb()`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, 'linear', ${`linear-plain-${Date.now()}-${Math.random()}`},
				'active', ${getDb().json({ token: otherToken })})
			RETURNING id
		`) as Array<{ id: number }>;
		const id = String(inserted[0].id);
		// Guard against a vacuous pass: the row must really exist, so the 404
		// below proves the gate rejected it rather than the seed failing.
		const sql = getDb();
		const [seeded] = await sql<{ id: number }>`
			SELECT id FROM connections WHERE id = ${Number(id)}
		`;
		expect(Number(seeded?.id)).toBe(Number(id));
		const app = createConnectionWebhookRoutes(manager);
		const response = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: JSON.stringify({ hello: "nope" }),
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${otherToken}`,
				},
			}),
		);
		expect(response.status).toBe(404);
		expect(await eventRows(id)).toHaveLength(0);
	});

	test("a bridged delivery ignores an unrelated legacy numeric-stable-id projection", async () => {
		// A legacy generic webhook with numeric stable id N owns the
		// agentconn-<N> projection. A bridged connector connection that happens
		// to have connections.id N must activate its OWN automations, never
		// the legacy row's.
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const { getDb } = await import("../../db/client.js");
		const docToken = "bridged-collide-token-0123456789abcdef0123456789";
		const inserted = (await getDb()`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, 'webhook', ${`bridged-collide-${Date.now()}-${Math.random()}`},
				'active', ${getDb().json({ token: docToken, semanticType: "alert" })})
			RETURNING id
		`) as Array<{ id: number }>;
		const id = String(inserted[0].id);
		// Decoy: legacy projection slug for the same numeric string, pointing
		// at a different row.
		const [decoy] = (await getDb()`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, 'webhook', ${`agentconn-${id}`},
				'active', ${getDb().json({})})
			RETURNING id
		`) as Array<{ id: number }>;
		const bridgedAutomationId = await seedWebhookEventAutomation({
			connectionId: Number(id),
		});
		const decoyAutomationId = await seedWebhookEventAutomation({
			connectionId: Number(decoy.id),
		});
		const app = createConnectionWebhookRoutes(manager);
		const response = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: JSON.stringify({ hello: "collide" }),
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${docToken}`,
				},
			}),
		);
		expect(response.status).toBe(202);
		const rows = await eventRows(id);
		expect(rows).toHaveLength(1);
		expect(rows[0].connection_id).toBe(Number(id));
		const sql = getDb();
		const [{ count: bridgedCount }] = await sql<{ count: number }>`
			SELECT count(*)::int AS count FROM runs
			WHERE automation_id = ${bridgedAutomationId}
			  AND run_type = 'automation'
		`;
		const [{ count: decoyCount }] = await sql<{ count: number }>`
			SELECT count(*)::int AS count FROM runs
			WHERE automation_id = ${decoyAutomationId}
			  AND run_type = 'automation'
		`;
		expect(bridgedCount).toBeGreaterThan(0);
		expect(decoyCount).toBe(0);
	});

	test("query-string auth honors the connection opt-in, nothing more", async () => {
		// Documented-schema tokens must not authenticate `?token=` unless the
		// connection set allowQueryAuth — tokens leak via proxy logs and
		// browser history, so the default is Bearer-header only.
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const { getDb } = await import("../../db/client.js");
		const sql = getDb();
		async function seedDocConnection(
			name: string,
			config: Record<string, unknown>
		): Promise<string> {
			const inserted = (await sql`
				INSERT INTO connections (organization_id, connector_key, slug, status, config)
				VALUES (${ORG}, 'webhook', ${`${name}-${Date.now()}-${Math.random()}`},
					'active', ${sql.json(config)})
				RETURNING id
			`) as Array<{ id: number }>;
			return String(inserted[0].id);
		}
		const plainToken = "query-optout-token-0123456789abcdef0123456789";
		const plainId = await seedDocConnection("query-optout", {
			token: plainToken,
			semanticType: "alert",
		});
		const optInToken = "query-optin-token-0123456789abcdef0123456789";
		const optInId = await seedDocConnection("query-optin", {
			token: optInToken,
			allowQueryAuth: true,
			semanticType: "alert",
		});
		const app = createConnectionWebhookRoutes(manager);
		const queryDelivery = (id: string, token: string) =>
			app.fetch(
				new Request(
					`http://gateway.test/api/v1/webhooks/${id}?token=${token}`,
					{
						method: "POST",
						body: JSON.stringify({ hello: "query" }),
						headers: { "content-type": "application/json" },
					}
				)
			);
		// No opt-in: query token rejected even though the Bearer token is valid.
		const denied = await queryDelivery(plainId, plainToken);
		expect(denied.status).toBe(401);
		expect(await eventRows(plainId)).toHaveLength(0);
		// Opted in: query token accepted.
		const allowed = await queryDelivery(optInId, optInToken);
		expect(allowed.status).toBe(202);
		expect(await eventRows(optInId)).toHaveLength(1);
	});

	test("a grandfathered numeric stable id still resolves via its projection", async () => {
		// Pre-guard legacy rows can hold a numeric stable id. The legacy caller
		// passes no automationConnectionId, so ingest must use the
		// agentconn-<id> slug lookup — never mistake the id for a bridged
		// connections.id and 500 on `WHERE id = N`.
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { getDb } = await import("../../db/client.js");
		const { handleWebhookIngest } = await import(
			"../connections/webhook-ingest.js"
		);
		const stableId = "999983";
		const sql = getDb();
		const [projected] = (await sql`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, 'webhook', ${`agentconn-${stableId}`},
				'active', ${sql.json({})})
			RETURNING id
		`) as Array<{ id: number }>;
		const automationId = await seedWebhookEventAutomation({
			connectionId: Number(projected.id),
		});
		const row = storedRow({ id: stableId }, { semanticType: "alert" });
		const res = await handleWebhookIngest(
			row as never,
			delivery({ severity: "critical" }, { headers: bearer }),
			fakeSecretStore as never,
			null,
			{ activateGenericAutomationEvent: true }
		);
		expect(res.status).toBe(202);
		const landed = (await res.json()) as { ok: boolean; id: number };
		expect(landed.ok).toBe(true);
		const [runCount] = await sql<{ count: number }>`
			SELECT count(*)::int AS count FROM runs
			WHERE automation_id = ${automationId}
			  AND run_type = 'automation'
		`;
		expect(runCount.count).toBeGreaterThan(0);
		const rows = await eventRows(stableId);
		expect(rows).toHaveLength(1);
		expect(rows[0].connection_id).toBe(Number(projected.id));
	});

	test("an authenticated Jira delivery lands as a structured event on the Atlassian Rovo feed", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const { getDb } = await import("../../db/client.js");
		const { id } = await seedRegisteredAtlassianConnection();
		const app = createConnectionWebhookRoutes(manager);
		const raw = JSON.stringify({
			webhookEvent: "jira:issue_updated",
			issue: {
				id: "10000",
				key: "KAN-1",
				self: "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue/10000",
				fields: {
					summary: "Webhook bridge works",
					status: { name: "To Do" },
					created: "2026-08-13T10:00:00.000Z",
					updated: "2026-08-13T10:01:00.000Z",
				},
			},
		});
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${signAtlassianWebhookJwt()}`,
				},
			}),
		);
		expect(res.status).toBe(202);
		const rows = await getDb()`
			SELECT connector_key, connection_id, feed_key, origin_id, semantic_type
			FROM events
			WHERE connection_id = ${id}
			ORDER BY id
		`;
		expect(rows).toEqual([
			{
				connector_key: "mcp.mcp-atlassian-com",
				connection_id: Number(id),
				feed_key: "issues",
				origin_id: "jira_issue_10000",
				semantic_type: "issue",
			},
		]);

		const commentRaw = JSON.stringify({
			webhookEvent: "comment_created",
			issue: { id: "10000", key: "KAN-1", fields: {} },
			comment: {
				id: "20000",
				body: {
					type: "doc",
					content: [
						{
							type: "paragraph",
							content: [{ type: "text", text: "Webhook comment" }],
						},
					],
				},
				author: { displayName: "Jira User" },
				created: "2026-08-13T10:02:00.000Z",
			},
		});
		const commentRes = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: commentRaw,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${signAtlassianWebhookJwt()}`,
				},
			}),
		);
		expect(commentRes.status).toBe(202);
		const [comment] = await getDb()`
			SELECT origin_id, origin_parent_id, semantic_type, payload_text
			FROM events
			WHERE connection_id = ${id} AND origin_id = 'jira_comment_20000'
		`;
		expect(comment).toMatchObject({
			origin_id: "jira_comment_20000",
			origin_parent_id: "jira_issue_10000",
			semantic_type: "comment",
			payload_text: "Webhook comment",
		});

		const forged = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: commentRaw,
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${signAtlassianWebhookJwt("forged-secret")}`,
				},
			}),
		);
		expect(forged.status).toBe(401);
	});

	test("a forged signature to a connector connection is rejected with 401", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await seedRegisteredConnectorConnection(secretStore);
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({ action: "opened", issue: { number: 8 } });
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-hub-signature-256": "sha256=deadbeef",
				},
			}),
		);
		expect(res.status).toBe(401);
		expect((await eventRows(id)).length).toBe(0);
	});

	test("a redelivery is idempotent (marks feed due, never raw-stores)", async () => {
		// GitHub connector webhooks are poll-canonical: redeliveries re-stamp
		// next_run_at and never accumulate webhook:<id> event rows.
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const { getDb } = await import("../../db/client.js");
		const id = await seedRegisteredConnectorConnection(secretStore);
		await getDb()`
			INSERT INTO connector_definitions (
				organization_id, key, name, status, feeds_schema
			) VALUES (
				${ORG}, 'github', 'GitHub', 'active',
				${getDb().json({
					issues: { webhook: { events: ["issues"], mode: "trigger" } },
				})}
			)
		`;
		await getDb()`
			INSERT INTO feeds (
					organization_id, connection_id, feed_key, status,
				config, next_run_at, created_at, updated_at
			) VALUES (
					${ORG}, ${id}, 'issues', 'active',
				${getDb().json({ repo_owner: "acme", repo_name: "api" })},
				current_timestamp + interval '1 hour',
				current_timestamp, current_timestamp
			)
		`;
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({
			action: "edited",
			issue: { number: 9 },
			repository: {
				full_name: "acme/api",
				name: "api",
				owner: { login: "acme" },
			},
		});
		const headers = {
			"content-type": "application/json",
			"x-github-event": "issues",
			"x-github-delivery": "gh-dupe-1",
			"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
		};
		const first = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers,
			}),
		);
		const second = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers,
			}),
		);
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect((await eventRows(id)).length).toBe(0);
	});

	test("a connector connection with no registered webhook 404s (no blind accept)", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager } = await buildManager();
		const { getDb } = await import("../../db/client.js");
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		// A connector connection that NEVER registered a webhook (no webhook_* keys).
		const inserted = (await getDb()`
			INSERT INTO connections (organization_id, connector_key, slug, status, config)
			VALUES (${ORG}, ${"github"}, ${`github-nohook-${Date.now()}`}, ${"active"},
				${getDb().json({ repo_owner: "acme", repo_name: "api" })})
			RETURNING id
		`) as Array<{ id: number }>;
		const id = String(inserted[0].id);
		const app = createConnectionWebhookRoutes(manager);

		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: JSON.stringify({ action: "opened" }),
				headers: { "content-type": "application/json" },
			}),
		);
		expect(res.status).toBe(404);
		expect((await eventRows(id)).length).toBe(0);
	});

	test("a paused connector connection refuses deliveries with 404", async () => {
		await seedAgentRow(AGENT, { organizationId: ORG });
		const { manager, secretStore } = await buildManager();
		const { createConnectionWebhookRoutes } = await import(
			"../routes/public/connections.js"
		);
		const id = await seedRegisteredConnectorConnection(secretStore, {
			status: "paused",
		});
		const app = createConnectionWebhookRoutes(manager);

		const raw = JSON.stringify({ action: "opened" });
		const res = await app.fetch(
			new Request(`http://gateway.test/api/v1/webhooks/${id}`, {
				method: "POST",
				body: raw,
				headers: {
					"content-type": "application/json",
					"x-hub-signature-256": sign(raw, { prefix: "sha256=" }),
				},
			}),
		);
		expect(res.status).toBe(404);
		expect((await eventRows(id)).length).toBe(0);
	});
});
