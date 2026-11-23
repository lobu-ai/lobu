/**
 * Who will see a connector write, for guardrails with an `audience`.
 *
 * The connector answers: an action marks its destination input with
 * `x-lobu-destination`, and the connector's registered
 * {@link DestinationAudienceSource} classifies that value. This module only
 * collects the sources and bounds the call; it never names a connector.
 */
import type { DestinationAudience, DestinationAudienceSource } from "@lobu/connector-sdk";
import { createLogger } from "@lobu/core";
import type { AvailableOperation } from "../operations/types";
import { slackDestinationAudienceSource } from "../gateway/connections/slack-destination-audience";

const logger = createLogger("destination-audience");
const LOOKUP_TIMEOUT_MS = 3_000;

// Read at call time, so importing this module never depends on a source's module having finished loading.
function sources(): DestinationAudienceSource[] {
	return [slackDestinationAudienceSource];
}

/** One destination a connector classified. */
export interface ClassifiedDestination {
	connectionId: number;
	destination: string;
	audience: DestinationAudience;
}

/**
 * How a policy decision may learn who sees the write.
 * `live`: the caller holds no transaction or row lock, so the connector may be
 * asked now; every answer is added to `seen`. Otherwise only `seen` answers,
 * which were collected before the transaction began; anything else is unknown.
 * Absent from a decision: the audience is unknown.
 */
export interface DestinationLookup {
	live: boolean;
	seen: ClassifiedDestination[];
}

type DestinationOperation = Pick<AvailableOperation, "connector_key" | "input_schema">;

function destinationField(operation: DestinationOperation): string | null {
	const properties = operation.input_schema?.properties;
	if (!properties || typeof properties !== "object") return null;
	for (const [name, schema] of Object.entries(properties)) {
		if (schema && typeof schema === "object" && (schema as Record<string, unknown>)["x-lobu-destination"] === true) return name;
	}
	return null;
}

function sourceFor(operation: DestinationOperation): DestinationAudienceSource | null {
	return sources().find((source) => source.connectorKey === operation.connector_key) ?? null;
}

/** Whether the connector can say who sees this operation's writes. */
export function hasClassifiableDestination(operation: DestinationOperation): boolean {
	return sourceFor(operation) !== null && destinationField(operation) !== null;
}

async function askConnector(
	source: DestinationAudienceSource,
	organizationId: string,
	connectionId: number,
	destination: string,
): Promise<DestinationAudience> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const audience = await Promise.race([
			source.destinationAudience({ organizationId, connectionId }, destination),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timed out")), LOOKUP_TIMEOUT_MS);
			}),
		]);
		if (audience === "private" || audience === "workspace" || audience === "external") return audience;
		return "unknown";
	} catch (error) {
		logger.warn({ connectorKey: source.connectorKey, connectionId, error: String(error) },
			"Destination audience lookup failed; treating it as unknown");
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Who sees this write. Undefined when the operation has no destination its
 * connector can classify; `unknown` when it has one that could not be read.
 */
export async function classifyDestination(args: {
	organizationId: string;
	connectionId: number | null;
	operation: DestinationOperation;
	input: Record<string, unknown> | null | undefined;
	lookup: DestinationLookup | undefined;
}): Promise<DestinationAudience | undefined> {
	const source = sourceFor(args.operation);
	const field = destinationField(args.operation);
	if (!source || !field) return undefined;
	const destination = args.input?.[field];
	if (typeof destination !== "string" || !destination || args.connectionId === null || !args.lookup) return "unknown";
	const { connectionId } = args;
	const seen = args.lookup.seen.find((entry) => entry.connectionId === connectionId && entry.destination === destination);
	if (seen) return seen.audience;
	if (!args.lookup.live) return "unknown";
	const audience = await askConnector(source, args.organizationId, connectionId, destination);
	args.lookup.seen.push({ connectionId, destination, audience });
	return audience;
}
