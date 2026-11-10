/**
 * `x-lobu-stamps`: a root `metadata_schema` annotation mapping a server-owned
 * timestamp field to the field whose changes it records, for example
 * `{ "stage_at": "stage" }`.
 *
 * The entity-row validation seam applies it to every validated write, so a
 * stamp no longer depends on which writer (view action, agent, SDK, connector
 * projection, approval apply) happened to change the tracked field. A stamped
 * field is server-owned: whatever a caller sends for it is discarded.
 */

import { isDeepStrictEqual } from "node:util";

export const ENTITY_STAMPS_ANNOTATION = "x-lobu-stamps";

export type EntityStamps = Readonly<Record<string, string>>;

/**
 * The stamps a stored schema declares. Write-time validation
 * ({@link entityStampsConfigError}) owns the shape, so a value that is not a
 * string-to-string map reads as no stamps rather than failing every write.
 */
export function readEntityStamps(value: unknown): EntityStamps {
	let raw = value;
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return {};
		}
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const stamps: Record<string, string> = {};
	for (const [stamp, tracked] of Object.entries(raw)) {
		if (typeof tracked === "string" && tracked.length > 0 && tracked !== stamp) {
			stamps[stamp] = tracked;
		}
	}
	return stamps;
}

/** Why the schema's `x-lobu-stamps` is unusable, or null when it is valid. */
export function entityStampsConfigError(
	metadataSchema: Record<string, unknown>,
): string | null {
	const raw = metadataSchema[ENTITY_STAMPS_ANNOTATION];
	if (raw === undefined) return null;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return "must map each stamp field to the field it tracks";
	}
	const properties =
		metadataSchema.properties &&
		typeof metadataSchema.properties === "object" &&
		!Array.isArray(metadataSchema.properties)
			? (metadataSchema.properties as Record<string, unknown>)
			: {};
	const declared = (field: string): Record<string, unknown> | null => {
		const prop = Object.hasOwn(properties, field) ? properties[field] : null;
		return prop && typeof prop === "object" && !Array.isArray(prop)
			? (prop as Record<string, unknown>)
			: null;
	};
	const entries = Object.entries(raw as Record<string, unknown>);
	// Schema validation runs on the caller's metadata before the stamp is
	// applied, so a required stamp would make every create without one fail.
	const required = new Set(
		Array.isArray(metadataSchema.required)
			? metadataSchema.required.filter((key): key is string => typeof key === "string")
			: [],
	);
	const tracked = new Set(
		entries.flatMap(([, value]) => (typeof value === "string" ? [value] : [])),
	);
	for (const [stamp, field] of entries) {
		if (typeof field !== "string" || field.length === 0) {
			return `${stamp} must name the field it tracks`;
		}
		if (field === stamp) return `${stamp} cannot stamp itself`;
		const stampProp = declared(stamp);
		if (!stampProp) return `${stamp} is not a declared property`;
		if (stampProp.type !== "string" || stampProp.format !== "date-time") {
			return `${stamp} must be declared as { type: "string", format: "date-time" }`;
		}
		if (required.has(stamp)) {
			return `${stamp} is server-owned and cannot be listed in required`;
		}
		if (!declared(field)) return `${stamp} tracks ${field}, which is not a declared property`;
		if (tracked.has(stamp)) {
			return `${stamp} is a stamp field and cannot also be tracked by another stamp`;
		}
	}
	return null;
}

/**
 * The metadata a write actually commits once its stamps are applied.
 *
 * Every stamp field keeps its committed value whatever `next` carries, then is
 * set to `now` when its tracked field is set on a create (`committed` null) or
 * changes value on an update.
 */
export function applyEntityStamps(args: {
	stamps: EntityStamps;
	committed: Record<string, unknown> | null;
	next: Record<string, unknown>;
	now: string;
}): Record<string, unknown> {
	const { stamps, committed, now } = args;
	const out = { ...args.next };
	for (const [stamp, tracked] of Object.entries(stamps)) {
		if (committed && Object.hasOwn(committed, stamp)) out[stamp] = committed[stamp];
		else delete out[stamp];
		const after = out[tracked] ?? null;
		const changed = committed === null
			? after !== null
			: !isDeepStrictEqual(committed[tracked] ?? null, after);
		if (changed) out[stamp] = now;
	}
	return out;
}
