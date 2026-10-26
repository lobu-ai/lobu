import {
  buildManifest,
  type IdentityInput,
  identityDigest,
} from "./identity-bootstrap.ts";
import {
  type IdentityClient,
  type ImportChunk,
  runIdentityChunk,
} from "./identity-import.script.ts";
import {
  extractParticipants,
  type ParticipantRow,
  type ParticipantSource,
} from "./identity-participants.ts";

export interface McpIdentityRequest {
  workspace: string;
  mode: "preview" | "import" | "verify";
  input: IdentityInput & {
    sources?: { source: ParticipantSource; rows: ParticipantRow[] }[];
  };
  continuation?: { digest: string; next: number; mode?: "import" | "verify" };
}

// Example-owned MCP adapter. The published bundle uses the same normalizer and
// importer as the CLI; the caller needs only Lobu's existing query_sdk/run_sdk.
// One writer per identity scope. A lost response is replayed with the SAME input
// and continuation; live exact readback, rather than a local receipt, reconciles it.
export async function runMcpIdentity(
  client: { org(name: string): Promise<IdentityClient> },
  request: McpIdentityRequest
) {
  if (!request.workspace?.trim())
    throw new Error("Select an explicit workspace");
  if (!["preview", "import", "verify"].includes(request.mode))
    throw new Error("Invalid mode");
  const extracted = (request.input.sources ?? []).map(({ source, rows }) =>
    extractParticipants(source, rows)
  );
  const manifest = buildManifest({
    observations: [
      ...(request.input.observations ?? []),
      ...extracted.flatMap((value) => value.observations),
    ],
    aliases: [
      ...(request.input.aliases ?? []),
      ...extracted.flatMap((value) => value.aliases ?? []),
    ],
  });
  // Small independent SDK batches stay below the sandbox's call quota. Evidence
  // arrays are sliced exactly as in the CLI, then merged by runIdentityChunk.
  const chunks: ImportChunk[] = [];
  for (const item of manifest.items) {
    const refs = item.metadata.source_refs as unknown[];
    for (let offset = 0; offset < refs.length; offset += 40) {
      chunks.push({
        items: [
          {
            ...item,
            metadata: {
              ...item.metadata,
              source_refs: refs.slice(offset, offset + 40),
            },
          },
        ],
        aliases: [],
      });
    }
  }
  for (const alias of manifest.aliases)
    chunks.push({ items: [], aliases: [alias] });
  const digest = identityDigest([request.workspace, manifest]);
  const next = request.continuation?.next ?? 0;
  if (!Number.isSafeInteger(next) || next < 0 || next > chunks.length)
    throw new Error("Invalid continuation");
  if (request.continuation && request.continuation.digest !== digest)
    throw new Error("Input/workspace changed; preview the new batch first");
  if (request.continuation?.mode && request.continuation.mode !== request.mode)
    throw new Error("Preview again before switching import/verify modes");
  if (request.mode !== "preview" && !request.continuation)
    throw new Error("Preview first; pass its continuation unchanged");
  const summary = {
    digest,
    identities: manifest.items.length,
    aliases: manifest.aliases.length,
    chunks: chunks.length,
  };
  if (request.mode === "preview")
    return { ...summary, continuation: { digest, next: 0 } };
  const workspace = await client.org(request.workspace);
  const budgetReached = new Error("Identity MCP call budget reached");
  let calls = 0;
  const bounded = async (action: () => Promise<unknown>) => {
    if (calls >= 150) throw budgetReached;
    calls++;
    return action();
  };
  const sdk: IdentityClient = {
    query: (sql) => bounded(() => workspace.query(sql)),
    entities: {
      get: (input) => bounded(() => workspace.entities.get(input)),
      create: (input) => bounded(() => workspace.entities.create(input)),
      update: (input) => bounded(() => workspace.entities.update(input)),
      listLinks: (input) => bounded(() => workspace.entities.listLinks(input)),
      link: (input) => bounded(() => workspace.entities.link(input)),
    },
  };
  const end = Math.min(next + 40, chunks.length);
  let changed = 0,
    linked = 0;
  let accepted = next;
  for (let index = next; index < end; index++) {
    const chunk = chunks[index];
    let result: Awaited<ReturnType<typeof runIdentityChunk>>;
    try {
      result = await runIdentityChunk(sdk, chunk, request.mode === "verify");
    } catch (error) {
      if (error !== budgetReached) throw error;
      if (accepted === next)
        throw new Error(
          "One chunk exceeds the MCP budget; reduce its existing person matches"
        );
      break; // The partially applied chunk is deliberately replayed next time.
    }
    if (
      result.records.length !== chunk.items.length ||
      result.edges.length !==
        chunk.aliases.length +
          chunk.items.reduce((sum, item) => sum + item.person_ids.length, 0)
    )
      throw new Error("Incomplete result; replay this continuation");
    changed += result.records.filter(
      (record) => record.action !== "adopted"
    ).length;
    linked += result.edges.filter((edge) => edge.action !== "adopted").length;
    accepted = index + 1;
  }
  return {
    ...summary,
    changed,
    linked,
    sdk_calls: calls,
    accepted_chunks: accepted - next,
    done: accepted === chunks.length,
    continuation: { digest, next: accepted, mode: request.mode },
  };
}
