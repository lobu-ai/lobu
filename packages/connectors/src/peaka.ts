/**
 * Peaka connector.
 *
 * Peaka is a data gateway: a project exposes external catalogs (ServiceTitan,
 * Stripe, …), internal "Peaka Tables", saved queries, and API & Webhook flows.
 *
 * Design:
 *  - Reads go through the documented Partner API
 *    (`POST /data/projects/:project/queries/execute?format=SIMPLE`). The
 *    connector refuses anything that is not a single read-only statement; the
 *    API itself rejects DML as well.
 *  - Inserts go through `POST /data/projects/:project/table/:table/import`
 *    (CSV multipart). Peaka appends, so `upsert_record` reads the key first and
 *    only imports when the row is absent; an existing row is a no-op when its
 *    values match, and otherwise needs a user-configured Peaka API/Webhook flow
 *    because the documented API has no row-update primitive.
 *  - `invoke_flow` POSTs to a configured Peaka API & Webhook endpoint. The URL
 *    is configuration (never action input) and must be a `*.peaka.studio` host,
 *    so an agent cannot turn this connector into an SSRF primitive.
 *  - Inbound webhooks: Peaka has no webhook-registration API. `registerWebhook`
 *    therefore returns a manual setup descriptor plus a signing secret; a relay
 *    (or a Peaka flow that can compute an HMAC) delivers to the normal Lobu
 *    connection webhook route. `unregisterWebhook` is a no-op for the same
 *    reason. Until that relay exists, use a Lobu `webhook` connection fed by a
 *    Peaka HTTP Request node — token auth is already supported there.
 *  - Binary audio is deliberately not fetched here: Peaka's documented response
 *    surface is JSON/text, and the ServiceTitan recording endpoint needs the
 *    ST-App-Key held inside Peaka. Advertising a byte-unsafe download would be
 *    worse than the explicit gap; see docs/peaka-connector.md.
 */

import {
	type ActionContext,
	type ActionResult,
	ConnectorRuntime,
	type EventEnvelope,
	type QueryContext,
	type QueryResult,
	type RuntimeConnectorDefinition,
	type SyncContext,
	type SyncResult,
	type WebhookRegistration,
	type WebhookRegistrationContext,
	createHttpClient,
} from "@lobu/connector-sdk";

const DEFAULT_BASE_URL = "https://partner.peaka.studio/api/v1";
const DEFAULT_MAX_ROWS = 200;
const MAX_ROWS = 1000;
const MAX_FETCHED_ROWS = 10_000;
const MAX_IDENTIFIER = 120;

interface PeakaCheckpoint {
	last_timestamp?: string;
	last_id?: string;
}

interface PeakaFeedConfig {
	query: string;
	id_column?: string;
	timestamp_column?: string;
	max_rows?: number;
	PEAKA_API_KEY?: string;
	PEAKA_PROJECT_ID?: string;
	PEAKA_BASE_URL?: string;
}

interface PeakaConfig {
	PEAKA_API_KEY?: string;
	PEAKA_PROJECT_ID?: string;
	PEAKA_BASE_URL?: string;
	PEAKA_UPSERT_FLOW_URL?: string;
	PEAKA_FLOW_TOKEN?: string;
}

interface QueryResponse {
	columns?: Array<{ columnName?: string; name?: string }>;
	data?: Array<Record<string, unknown>>;
}

interface ImportJob {
	id?: string;
	status?: string;
	progress?: number;
	result?: { processed?: number };
}

function configString(config: Record<string, unknown>, key: string): string | undefined {
	const value = config[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function projectId(config: Record<string, unknown>): string {
	const value = configString(config, "PEAKA_PROJECT_ID");
	if (!value) throw new Error("Peaka connection is missing PEAKA_PROJECT_ID");
	return value;
}

function baseUrl(config: Record<string, unknown>): string {
	const raw = configString(config, "PEAKA_BASE_URL") ?? DEFAULT_BASE_URL;
	const url = new URL(raw);
	if (url.protocol !== "https:") throw new Error("Peaka API base URL must use https");
	if (url.hostname !== "peaka.studio" && !url.hostname.endsWith(".peaka.studio")) {
		throw new Error(`Refusing non-Peaka API host: ${url.hostname}`);
	}
	return url.toString().replace(/\/+$/, "");
}

function apiClient(config: Record<string, unknown>) {
	const token = configString(config, "PEAKA_API_KEY");
	if (!token) throw new Error("Peaka connection is missing PEAKA_API_KEY");
	return createHttpClient({ token, errorPrefix: "Peaka API", retry: { operation: "peaka" } });
}

/** Quote a SQL identifier for Peaka's Trino dialect. */
function quoteIdentifier(value: string): string {
	if (value.length > MAX_IDENTIFIER || /[\u0000-\u001f]/.test(value)) {
		throw new Error("Invalid Peaka identifier");
	}
	return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Structural read-only SQL guard. Peaka itself rejects DML, but an agent-facing
 * action should fail before sending anything that is not a query.
 */
export function assertReadOnlySql(sql: string): string {
	const trimmed = sql
		.replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, "")
		.trim();
	if (!/^(select|with|show|describe|explain)\b/i.test(trimmed)) {
		throw new Error("Peaka connector only runs read-only SQL (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN)");
	}
	const single = trimmed.replace(/;\s*$/, "");
	if (single.includes(";")) throw new Error("Peaka connector accepts one statement per call");
	return single;
}

function csvCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	const text = typeof value === "object" ? JSON.stringify(value) : String(value);
	if (!/[",\r\n]/.test(text)) return text;
	return `"${text.replace(/"/g, '""')}"`;
}

export function buildCsv(columns: string[], record: Record<string, unknown>): string {
	return `${columns.map(csvCell).join(",")}\n${columns
		.map((column) => csvCell(record[column]))
		.join(",")}\n`;
}

function asRows(response: QueryResponse): Array<Record<string, unknown>> {
	if (!Array.isArray(response.data)) return [];
	return response.data.filter(
		(row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row),
	);
}

function columnNames(response: QueryResponse): string[] {
	return (response.columns ?? [])
		.map((column) => column.columnName ?? column.name)
		.filter((name): name is string => typeof name === "string" && name.length > 0);
}

function normalise(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

/** Stable tie-break for rows that share the checkpoint timestamp. */
function compareIds(a: string, b: string): number {
	const na = Number(a);
	const nb = Number(b);
	if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
	return a.localeCompare(b);
}

function sameRecord(
	existing: Record<string, unknown>,
	record: Record<string, unknown>,
): boolean {
	return Object.entries(record).every(([key, value]) => normalise(existing[key]) === normalise(value));
}

function requireTable(input: Record<string, unknown>): string {
	const table = input.table;
	if (typeof table !== "string" || !table.trim()) throw new Error("`table` is required");
	return table.trim();
}

function keyColumns(input: Record<string, unknown>): string[] {
	const raw = input.key_columns;
	if (raw === undefined) return ["idempotency_key"];
	if (!Array.isArray(raw) || raw.length === 0 || raw.some((v) => typeof v !== "string")) {
		throw new Error("`key_columns` must be a non-empty array of column names");
	}
	return raw as string[];
}

/**
 * Peaka API/Webhook endpoints live on `*.api.peaka.studio`. The URL comes from
 * connection config, so this is defence in depth against a misconfigured host,
 * not an agent-controlled SSRF surface.
 */
export function assertPeakaFlowUrl(raw: string): string {
	const url = new URL(raw);
	if (url.protocol !== "https:") throw new Error("Peaka flow URL must use https");
	if (url.hostname !== "peaka.studio" && !url.hostname.endsWith(".peaka.studio")) {
		throw new Error(`Refusing non-Peaka flow host: ${url.hostname}`);
	}
	return url.toString();
}

export default class PeakaConnector extends ConnectorRuntime<PeakaCheckpoint, PeakaFeedConfig> {
	readonly definition: RuntimeConnectorDefinition<PeakaCheckpoint, PeakaFeedConfig> = {
		key: "peaka",
		name: "Peaka",
		description:
			"Query Peaka projects, sync Peaka-backed rows, invoke API & Webhook flows, and import records into Peaka tables.",
		version: "1.0.0",
		faviconDomain: "peaka.studio",
		authSchema: {
			methods: [
				{
					type: "env_keys",
					required: true,
					scope: "connection",
					description:
						"A Peaka project API key. Create it in Peaka Studio → Project Settings → API Keys; it is scoped to one project.",
					fields: [
						{
							key: "PEAKA_API_KEY",
							label: "Peaka project API key",
							description: "Project-scoped key used as a Bearer token against the Peaka Partner API.",
							example: "xxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
							secret: true,
							required: true,
						},
						{
							key: "PEAKA_PROJECT_ID",
							label: "Project ID",
							description: "Peaka project ID (Project Settings → API Keys shows it next to the base URL).",
							example: "LePnbVBt",
							required: true,
						},
						{
							key: "PEAKA_BASE_URL",
							label: "API base URL",
							description: "Optional US/EU override. Defaults to https://partner.peaka.studio/api/v1.",
							example: "https://partner.peaka.studio/api/v1",
							required: false,
						},
						{
							key: "PEAKA_UPSERT_FLOW_URL",
							label: "Upsert flow URL",
							description:
								"Optional Peaka API & Webhook flow used to update an existing row. The documented API cannot update rows in place.",
							secret: false,
							required: false,
						},
						{
							key: "PEAKA_FLOW_TOKEN",
							label: "Flow token",
							description: "Optional bearer token sent to the configured Peaka flow endpoints.",
							secret: true,
							required: false,
						},
					],
				},
			],
		},
		feeds: {
			calls: {
				key: "calls",
				name: "Peaka rows",
				description:
					"Runs a user-authored read-only Peaka SQL query on a schedule and emits one event per row.",
				userManaged: true,
				sync: (ctx) => this.syncFeed(ctx),
				configSchema: {
					type: "object",
					required: ["query"],
					properties: {
						query: {
							type: "string",
							title: "Read-only SQL",
							description:
								"A single SELECT/WITH statement against the project (for example servicetitan.telecom.calls).",
						},
						id_column: {
							type: "string",
							title: "Primary key column",
							description: "Stable source id column used for origin_id dedupe.",
							default: "id",
						},
						timestamp_column: {
							type: "string",
							title: "Activity timestamp column",
							description:
								"Column used for the incremental checkpoint (ISO-8601/timestamp). Defaults to createdon.",
							default: "createdon",
						},
						max_rows: {
							type: "integer",
							title: "Rows per sync",
							minimum: 1,
							maximum: MAX_ROWS,
							default: DEFAULT_MAX_ROWS,
						},
					},
					additionalProperties: false,
				},
				eventKinds: {
					call: {
						description: "A Peaka-backed call row (new or changed).",
						metadataSchema: {
							type: "object",
							properties: {
								call_id: { type: "string" },
								duration: { type: "string" },
								status: { type: "string" },
								recording_url: { type: "string" },
								project_id: { type: "string" },
							},
							additionalProperties: true,
						},
					},
				},
			},
		},
		actions: {
			query: {
				key: "query",
				name: "Run read-only SQL",
				description: "Execute one read-only Peaka SQL statement and return its rows.",
				kind: "read",
				annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
				inputSchema: {
					type: "object",
					required: ["sql"],
					properties: {
						sql: { type: "string", description: "A single SELECT/WITH/SHOW/DESCRIBE statement." },
						limit: { type: "integer", minimum: 1, maximum: MAX_ROWS },
					},
					additionalProperties: false,
				},
			},
			list_tables: {
				key: "list_tables",
				name: "List tables",
				description: "List Peaka internal tables, or tables in a catalog/schema.",
				kind: "read",
				annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
				inputSchema: {
					type: "object",
					properties: {
						catalog_id: { type: "string" },
						schema_name: { type: "string" },
					},
					additionalProperties: false,
				},
			},
			add_record: {
				key: "add_record",
				name: "Add record",
				description:
					"Append one row to a Peaka internal table via the documented CSV import endpoint. Appends — use upsert_record for idempotent writes.",
				kind: "write",
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
				inputSchema: {
					type: "object",
					required: ["table", "record"],
					properties: {
						table: { type: "string" },
						record: { type: "object", additionalProperties: true },
					},
					additionalProperties: false,
				},
			},
			upsert_record: {
				key: "upsert_record",
				name: "Upsert record",
				description:
					"Write one row through the configured Peaka upsert flow: no-op when unchanged, otherwise call the flow and verify the read-back. Peaka Tables have no enforced uniqueness, so the flow owns atomic insert-or-update.",
				kind: "write",
				annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
				inputSchema: {
					type: "object",
					required: ["table", "record"],
					properties: {
						table: { type: "string" },
						record: { type: "object", additionalProperties: true },
						key_columns: {
							type: "array",
							items: { type: "string" },
							description: "Columns that identify the row. Defaults to [idempotency_key].",
						},
					},
					additionalProperties: false,
				},
			},
			invoke_flow: {
				key: "invoke_flow",
				name: "Invoke API flow",
				description:
					"POST a JSON payload to the configured Peaka API & Webhook flow (PEAKA_UPSERT_FLOW_URL).",
				kind: "write",
				annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
				inputSchema: {
					type: "object",
					required: ["payload"],
					properties: { payload: { type: "object", additionalProperties: true } },
					additionalProperties: false,
				},
			},
		},
		webhook: {
			signatureHeader: "x-peaka-signature",
			algorithm: "sha256",
			dedupeHeader: "x-peaka-delivery",
		},
	};

	private http(config: Record<string, unknown>) {
		return apiClient(config);
	}

	private async executeSql(
		config: Record<string, unknown>,
		sql: string,
		format: "SIMPLE" | "CELL_TYPED" = "SIMPLE",
	): Promise<QueryResponse> {
		const statement = assertReadOnlySql(sql);
		return this.http(config).post<QueryResponse>(
			`${baseUrl(config)}/data/projects/${encodeURIComponent(projectId(config))}/queries/execute?format=${format}`,
			{ statement },
		);
	}

	async query(ctx: QueryContext<PeakaFeedConfig>): Promise<QueryResult> {
		const response = await this.executeSql(
			ctx.config as unknown as Record<string, unknown>,
			ctx.query,
		);
		const rows = asRows(response);
		const limited =
			typeof ctx.limit === "number" && ctx.limit > 0 ? rows.slice(0, ctx.limit) : rows;
		return {
			rows: limited,
			columns: columnNames(response).map((name) => ({ name, type: "unknown" })),
			total: limited.length,
		};
	}

	async syncFeed(ctx: SyncContext<PeakaCheckpoint, PeakaFeedConfig>): Promise<SyncResult> {
		const config = ctx.config as unknown as Record<string, unknown> & PeakaFeedConfig;
		const rawQuery = typeof config.query === "string" ? config.query.trim() : "";
		if (!rawQuery) throw new Error("Peaka calls feed requires a read-only `query`");
		const idColumn = config.id_column?.trim() || "id";
		const timestampColumn = config.timestamp_column?.trim() || "createdon";
		const maxRows = Math.min(Math.max(Number(config.max_rows) || DEFAULT_MAX_ROWS, 1), MAX_ROWS);

		const response = await this.executeSql(config, rawQuery);
		const allRows = asRows(response);
		if (allRows.length > MAX_FETCHED_ROWS) {
			throw new Error(
				`Peaka feed query returned ${allRows.length} rows; add ORDER BY + LIMIT (max ${MAX_FETCHED_ROWS}) so the checkpoint can page deterministically`,
			);
		}

		const parsed = allRows
			.map((row) => {
				const id = normalise(row[idColumn]);
				if (!id) return null;
				const occurredAtRaw = normalise(row[timestampColumn]);
				const occurredAt = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
				const occurredMs = Number.isNaN(occurredAt.getTime()) ? Date.now() : occurredAt.getTime();
				return { row, id, occurredMs };
			})
			.filter((entry): entry is { row: Record<string, unknown>; id: string; occurredMs: number } =>
				entry !== null,
			)
			.sort((a, b) => a.occurredMs - b.occurredMs || compareIds(a.id, b.id));

		const checkpoint = ctx.checkpoint ?? {};
		const cutoff = checkpoint.last_timestamp ? Date.parse(checkpoint.last_timestamp) : null;
		const lastId = checkpoint.last_id ?? null;
		const eligible = parsed.filter(({ id, occurredMs }) => {
			if (cutoff === null || Number.isNaN(cutoff)) return true;
			if (occurredMs > cutoff) return true;
			if (occurredMs < cutoff) return false;
			return lastId !== null && compareIds(id, lastId) > 0;
		});
		const page = eligible.slice(0, maxRows);

		const events: EventEnvelope[] = page.map(({ row, id, occurredMs }) => ({
			origin_id: `peaka-call:${projectId(config)}:${id}`,
			origin_type: "call",
			payload_type: "text",
			title: `Call ${id}`,
			payload_text: [
				`Peaka call ${id}`,
				row.duration ? `duration ${normalise(row.duration)}` : undefined,
				row.status ? `status ${normalise(row.status)}` : undefined,
				row.recordingurl ? `recording ${normalise(row.recordingurl)}` : undefined,
			]
				.filter(Boolean)
				.join(" · "),
			occurred_at: new Date(occurredMs),
			semantic_type: "call",
			metadata: {
				call_id: id,
				duration: normalise(row.duration) || undefined,
				status: normalise(row.status) || undefined,
				recording_url: normalise(row.recordingurl) || undefined,
				project_id: projectId(config),
			},
		}));

		const last = page.at(-1);
		const nextCheckpoint: PeakaCheckpoint = {
			last_timestamp: last ? new Date(last.occurredMs).toISOString() : checkpoint.last_timestamp,
			last_id: last ? last.id : checkpoint.last_id,
		};
		await ctx.commit(events, nextCheckpoint);
		return {
			status: eligible.length > page.length ? "more" : "complete",
			metadata: { items_found: events.length, items_pending: eligible.length - page.length },
		};
	}

	async execute(ctx: ActionContext): Promise<ActionResult> {
		const config = ctx.config;
		try {
			switch (ctx.actionKey) {
				case "query":
					return await this.runQuery(config, ctx.input);
				case "list_tables":
					return await this.listTables(config, ctx.input);
				case "add_record":
					return await this.addRecord(config, ctx.input);
				case "upsert_record":
					return await this.upsertRecord(config, ctx.input);
				case "invoke_flow":
					return await this.invokeFlow(config, ctx.input);
				default:
					return { success: false, error: `Unknown Peaka action: ${ctx.actionKey}` };
			}
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async runQuery(
		config: Record<string, unknown>,
		input: Record<string, unknown>,
	): Promise<ActionResult> {
		const sql = typeof input.sql === "string" ? input.sql : "";
		if (!sql) throw new Error("`sql` is required");
		const response = await this.executeSql(config, sql);
		let rows = asRows(response);
		if (typeof input.limit === "number" && input.limit > 0) {
			rows = rows.slice(0, Math.min(input.limit, MAX_ROWS));
		}
		return {
			success: true,
			output: { rows, columns: columnNames(response), row_count: rows.length },
		};
	}

	private async listTables(
		config: Record<string, unknown>,
		input: Record<string, unknown>,
	): Promise<ActionResult> {
		const project = encodeURIComponent(projectId(config));
		const catalogId = typeof input.catalog_id === "string" ? input.catalog_id.trim() : "";
		const schemaName = typeof input.schema_name === "string" ? input.schema_name.trim() : "";
		const url = catalogId
			? `${baseUrl(config)}/data/projects/${project}/catalogs/${encodeURIComponent(catalogId)}/schemas/${encodeURIComponent(schemaName || "public")}/tables`
			: `${baseUrl(config)}/data/projects/${project}/table`;
		const tables = await this.http(config).get<unknown>(url);
		return { success: true, output: { tables } };
	}

	private async addRecord(
		config: Record<string, unknown>,
		input: Record<string, unknown>,
	): Promise<ActionResult> {
		const table = requireTable(input);
		const record = input.record;
		if (!record || typeof record !== "object" || Array.isArray(record)) {
			throw new Error("`record` must be an object");
		}
		const job = await this.importRow(config, table, record as Record<string, unknown>);
		return { success: true, output: { action: "added", table, job } };
	}

	private async upsertRecord(
		config: Record<string, unknown>,
		input: Record<string, unknown>,
	): Promise<ActionResult> {
		const table = requireTable(input);
		const record = input.record;
		if (!record || typeof record !== "object" || Array.isArray(record)) {
			throw new Error("`record` must be an object");
		}
		const row = record as Record<string, unknown>;
		const keys = keyColumns(input);
		const existing = await this.findByKey(config, table, keys, row);
		if (existing && sameRecord(existing, row)) {
			return {
				success: true,
				output: { action: "noop", table, key_columns: keys, row: existing },
			};
		}

		const flowUrl = configString(config, "PEAKA_UPSERT_FLOW_URL");
		if (!flowUrl) {
			return {
				success: false,
				error:
					"Peaka Tables do not enforce unique constraints, so the connector cannot make a read-then-insert upsert safe across replicas. Configure PEAKA_UPSERT_FLOW_URL with a Peaka flow that owns the atomic insert-or-update by key.",
				output: { code: "peaka_upsert_requires_flow", table, key_columns: keys },
			};
		}

		const flowResult = await this.callFlow(config, flowUrl, {
			action: existing ? "update" : "insert",
			table,
			key_columns: keys,
			record: row,
			existing,
		});
		const verified = await this.findByKey(config, table, keys, row);
		if (!verified || !sameRecord(verified, row)) {
			return {
				success: false,
				error: `Peaka flow completed but the row did not read back with the written values (${keys.join(", ")})`,
				output: { code: "peaka_readback_failed", table, flow: flowResult, row: verified },
			};
		}
		return {
			success: true,
			output: {
				action: existing ? "updated" : "inserted",
				table,
				key_columns: keys,
				flow: flowResult,
				row: verified,
			},
		};
	}

	private async findByKey(
		config: Record<string, unknown>,
		table: string,
		keys: string[],
		record: Record<string, unknown>,
	): Promise<Record<string, unknown> | null> {
		const predicates = keys.map((key) => {
			const value = record[key];
			if (value === undefined || value === null || value === "") {
				throw new Error(`Missing key column value for ${key}`);
			}
			return `${quoteIdentifier(key)} = ${quoteLiteral(normalise(value))}`;
		});
		const sql = `SELECT * FROM "peaka"."table".${quoteIdentifier(table)} WHERE ${predicates.join(" AND ")} LIMIT 2`;
		const response = await this.executeSql(config, sql);
		return asRows(response)[0] ?? null;
	}

	private async importRow(
		config: Record<string, unknown>,
		table: string,
		record: Record<string, unknown>,
	): Promise<ImportJob> {
		const columns = Object.keys(record);
		if (columns.length === 0) throw new Error("`record` must have at least one column");
		for (const column of columns) quoteIdentifier(column);
		const csv = buildCsv(columns, record);
		const form = new FormData();
		form.append("file", new Blob([csv], { type: "text/csv" }), `${table}.csv`);
		form.append(
			"request",
			JSON.stringify({
				mappings: columns.map((name) => ({ name, csvColumnName: name })),
				containsHeader: true,
			}),
		);
		const response = await this.http(config).request(
			`${baseUrl(config)}/data/projects/${encodeURIComponent(projectId(config))}/table/${encodeURIComponent(table)}/import`,
			{ method: "POST", body: form },
		);
		return (await response.json()) as ImportJob;
	}

	private async invokeFlow(
		config: Record<string, unknown>,
		input: Record<string, unknown>,
	): Promise<ActionResult> {
		const flowUrl = configString(config, "PEAKA_UPSERT_FLOW_URL");
		if (!flowUrl) throw new Error("Configure PEAKA_UPSERT_FLOW_URL before invoking a flow");
		const payload = input.payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			throw new Error("`payload` must be an object");
		}
		const result = await this.callFlow(config, flowUrl, payload as Record<string, unknown>);
		return { success: true, output: { flow_url: flowUrl, result } };
	}

	private async callFlow(
		config: Record<string, unknown>,
		flowUrl: string,
		payload: Record<string, unknown>,
	): Promise<unknown> {
		const url = assertPeakaFlowUrl(flowUrl);
		const token = configString(config, "PEAKA_FLOW_TOKEN");
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(payload),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`Peaka flow ${response.status}: ${text.slice(0, 500)}`);
		}
		try {
			return text ? JSON.parse(text) : null;
		} catch {
			return { text };
		}
	}

	async registerWebhook(
		ctx: WebhookRegistrationContext<PeakaConfig>,
	): Promise<WebhookRegistration> {
		// Peaka has no subscription API. Mint a secret so a signing relay can
		// deliver to the normal per-connection route, and return the manual setup
		// instead of pretending a subscription exists.
		const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
		return {
			externalId: `peaka-manual-${projectId(ctx.config as unknown as Record<string, unknown>)}`,
			secret,
			metadata: {
				mode: "manual",
				callback_url: ctx.callbackUrl,
				setup:
					"Create a Peaka API & Webhook flow whose HTTP Request node POSTs to callback_url with an x-peaka-signature HMAC-SHA256 header over the raw body, or point a Lobu webhook connection at the Peaka flow. Peaka cannot register or sign this subscription itself.",
			},
		};
	}

	async unregisterWebhook(_ctx: WebhookRegistrationContext<PeakaConfig>): Promise<void> {
		// Nothing was created provider-side; the gateway clears the stored secret.
	}
}
