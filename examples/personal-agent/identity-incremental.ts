import { type IdentityInput, identityDigest } from "./identity-bootstrap.ts";
import type { IdentityClient } from "./identity-import.script.ts";
import { runMcpIdentity } from "./identity-mcp.ts";
import {
  extractParticipants,
  type ParticipantSource,
} from "./identity-participants.ts";

interface Binding extends ParticipantSource {
  source_scope: string;
}
interface Reference {
  semantic_type?: string;
  connection_id: number;
  feed_id: number;
  created_at: string;
  metadata: {
    observation_id: string;
    resource_ref: string;
    resource_type: string;
    source_scope: string;
  };
}
interface Unresolved {
  reference: Reference;
  status: string;
}
interface Pending {
  input: IdentityInput;
  next_cursor: string;
  phase: "import" | "verify";
  continuation: { digest: string; next: number; mode?: "import" | "verify" };
  unresolved: Unresolved[];
  digest: string;
}
export interface IncrementalState {
  version: 1;
  scope_digest: string;
  cursor?: string;
  unresolved: Unresolved[];
  pending?: Pending;
}
export interface IncrementalRequest {
  workspace: string;
  reader_id: string;
  automation_id: number;
  sources: Binding[];
  action: "poll" | "advance";
  state?: IncrementalState;
}
interface IncrementalWorkspace extends IdentityClient {
  knowledge: { read(input: Record<string, unknown>): Promise<unknown> };
  feeds: {
    get(input: { feed_id: number }): Promise<unknown>;
    readMany(input: {
      reads: { feed_id: number; query: string; limit: number }[];
    }): Promise<unknown>;
  };
}

const MAX_REFS = 10,
  MAX_UNRESOLVED = 64;
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed source response");
  return value as Record<string, any>;
};
function reference(value: unknown): Reference {
  const row = object(value),
    metadata = object(row.metadata);
  if (
    ![row.connection_id, row.feed_id].every(
      (id) => Number.isSafeInteger(id) && id > 0
    ) ||
    (row.semantic_type !== undefined &&
      (typeof row.semantic_type !== "string" || !row.semantic_type)) ||
    typeof row.created_at !== "string" ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    ["observation_id", "resource_ref", "resource_type", "source_scope"].some(
      (key) => typeof metadata[key] !== "string" || !metadata[key]
    )
  )
    throw new Error("Malformed source reference");
  return {
    ...(row.semantic_type !== undefined
      ? { semantic_type: row.semantic_type }
      : {}),
    connection_id: row.connection_id,
    feed_id: row.feed_id,
    created_at: row.created_at,
    metadata: {
      observation_id: metadata.observation_id,
      resource_ref: metadata.resource_ref,
      resource_type: metadata.resource_type,
      source_scope: metadata.source_scope,
    },
  };
}
// Caller state may round-trip through JSONB, whose object key order is not
// insertion order. Normalize only this state checksum; identity keys retain
// their existing hashes. Array order is part of the pending batch identity.
function canonicalState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalState);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalState(child)])
  );
}
function pendingDigest(pending: Omit<Pending, "digest">): string {
  return identityDigest(canonicalState(pending));
}
function referenceKey(ref: Reference): string {
  return JSON.stringify([
    ref.connection_id,
    ref.feed_id,
    ref.metadata.observation_id,
  ]);
}
function uniquePending(items: Unresolved[]): Unresolved[] {
  const byId = new Map<string, Unresolved>();
  for (const item of items) {
    const clean = { reference: reference(item.reference), status: item.status };
    if (typeof clean.status !== "string")
      throw new Error("Malformed unresolved state");
    const id = referenceKey(clean.reference);
    const prior = byId.get(id);
    if (
      prior &&
      identityDigest(prior.reference) !== identityDigest(clean.reference)
    )
      throw new Error("Observation identity changed");
    byId.set(id, clean);
  }
  if (byId.size > MAX_UNRESOLVED)
    throw new Error(
      "Unresolved source limit reached; resolve pending references before polling again"
    );
  return [...byId.values()];
}

/**
 * One bounded external-client step, no agent run or schedule. Persist the
 * returned state atomically before the next call. Serialize writers for this
 * identity/account scope; independent capture readers may use separate states.
 * A lost response replays the SAME prior state against exact live readback.
 * Capture progress is distinct from identity verification and semantic work.
 */
export async function runIncrementalIdentity(
  client: { org(name: string): Promise<IncrementalWorkspace> },
  request: IncrementalRequest
) {
  if (
    !request.workspace?.trim() ||
    !request.reader_id?.trim() ||
    !Number.isSafeInteger(request.automation_id) ||
    request.automation_id < 1 ||
    !["poll", "advance"].includes(request.action) ||
    !request.sources.length ||
    request.sources.length > 10
  )
    throw new Error(
      "Explicit workspace, reader, Automation and source bindings required"
    );
  const sources = request.sources
    .map((source) => {
      if (
        !["linkedin", "whatsapp", "x"].includes(source.provider) ||
        !source.account_scope?.trim() ||
        !source.source_scope?.trim() ||
        ![source.feed_id, source.connection_id].every(
          (id) => Number.isSafeInteger(id) && id > 0
        )
      )
        throw new Error("Invalid source account binding");
      return {
        provider: source.provider,
        account_scope: source.account_scope,
        source_scope: source.source_scope,
        connection_id: source.connection_id,
        feed_id: source.feed_id,
      };
    })
    .sort((a, b) => a.feed_id - b.feed_id);
  if (new Set(sources.map((source) => source.feed_id)).size !== sources.length)
    throw new Error("Duplicate source binding");
  const scope_digest = identityDigest([
    request.workspace,
    request.reader_id,
    request.automation_id,
    sources,
  ]);
  const state: IncrementalState = request.state
    ? JSON.parse(JSON.stringify(request.state))
    : { version: 1, scope_digest, unresolved: [] };
  if (
    state.version !== 1 ||
    state.scope_digest !== scope_digest ||
    !Array.isArray(state.unresolved)
  )
    throw new Error(
      "Identity reader scope changed; preserve old state and restart explicitly"
    );
  state.unresolved = uniquePending(state.unresolved);
  if (
    state.cursor !== undefined &&
    (typeof state.cursor !== "string" || !state.cursor)
  )
    throw new Error("Invalid saved cursor");

  if (request.action === "advance") {
    const pending = state.pending;
    if (!pending) throw new Error("Poll first; no pending identity batch");
    const { digest, ...payload } = pending;
    if (pendingDigest(payload) !== digest)
      throw new Error("Pending batch changed; replay the saved state");
    const result = await runMcpIdentity(client, {
      workspace: request.workspace,
      mode: pending.phase,
      input: pending.input,
      continuation: pending.continuation,
    });
    if (!("done" in result))
      throw new Error("Identity progress response missing");
    if (!result.done) {
      pending.continuation = result.continuation;
    } else if (pending.phase === "import") {
      pending.phase = "verify";
      pending.continuation = { digest: result.digest, next: 0 };
    } else {
      state.cursor = pending.next_cursor;
      state.unresolved = uniquePending(pending.unresolved);
      delete state.pending;
    }
    if (state.pending) {
      const { digest: _old, ...next } = state.pending;
      state.pending.digest = pendingDigest(next);
    }
    return {
      state,
      phase: state.pending?.phase ?? "accepted",
      changed: result.changed ?? 0,
      linked: result.linked ?? 0,
    };
  }

  if (state.pending)
    throw new Error("Finish or replay the pending batch before polling");
  const workspace = await client.org(request.workspace);
  const retries = state.unresolved.slice(0, Math.floor(MAX_REFS / 2));
  const pageLimit = MAX_REFS - retries.length;
  const page = object(
    await workspace.knowledge.read({
      automation_id: request.automation_id,
      view: "changes",
      limit: pageLimit,
      ...(state.cursor ? { cursor: state.cursor } : {}),
    })
  );
  if (
    !Array.isArray(page.content) ||
    page.content.length > pageLimit ||
    typeof page.page?.has_more !== "boolean"
  )
    throw new Error("Malformed change page");
  const next_cursor = page.page.has_more
    ? page.next_cursor
    : page.resume_cursor;
  if (typeof next_cursor !== "string" || !next_cursor)
    throw new Error("Missing source cursor; preserve the prior state");
  const refs = new Map<string, Reference>();
  const savedRefs = new Map(
    state.unresolved.map((item) => [
      referenceKey(item.reference),
      item.reference,
    ])
  );
  for (const row of [
    ...retries.map((item) => item.reference),
    ...page.content,
  ]) {
    const ref = reference(row),
      id = referenceKey(ref);
    const previous = refs.get(id) ?? savedRefs.get(id);
    if (previous && identityDigest(previous) !== identityDigest(ref))
      throw new Error("Observation identity changed");
    refs.set(id, ref);
  }
  const retryIds = new Set(refs.keys());
  const unresolved = state.unresolved.filter(
    (item) => !retryIds.has(referenceKey(item.reference))
  );
  const input: IdentityInput = { observations: [], aliases: [] };
  const feedScopes = new Map<number, Record<string, any>>();
  const nativeCache = new Map<string, Record<string, any> | null>();
  const feedScope = (feed: Record<string, any>) => [
    feed.id,
    feed.connection_id,
    feed.feed_key,
    feed.config,
    feed.pinned_version,
    feed.operations,
  ];
  for (const ref of refs.values()) {
    const type = ref.metadata.resource_type;
    const binding = sources.find(
      (source) =>
        source.feed_id === ref.feed_id &&
        source.connection_id === ref.connection_id
    );
    if (!binding || binding.source_scope !== ref.metadata.source_scope)
      throw new Error(
        "Unbound or changed source scope; preserve the prior state"
      );
    if (ref.semantic_type === "source.gap") {
      unresolved.push({ reference: ref, status: "source_gap_or_unsupported" });
      continue;
    }
    if (type === "notification") continue; // no person/relationship claim
    if (type !== "message") {
      unresolved.push({ reference: ref, status: "source_gap_or_unsupported" });
      continue;
    }
    if (!feedScopes.has(binding.feed_id)) {
      const feed = object(
        object(await workspace.feeds.get({ feed_id: binding.feed_id })).feed
      );
      if (
        Number(feed.id) !== binding.feed_id ||
        Number(feed.connection_id) !== binding.connection_id ||
        !Array.isArray(feed.operations) ||
        !feed.operations.includes("read")
      )
        throw new Error("Source feed/account binding changed");
      feedScopes.set(binding.feed_id, feed);
    }
    const cacheKey = JSON.stringify([
      binding.feed_id,
      ref.metadata.resource_ref,
    ]);
    if (!nativeCache.has(cacheKey)) {
      const result = object(
        await workspace.feeds.readMany({
          reads: [
            {
              feed_id: binding.feed_id,
              query: `id:${ref.metadata.resource_ref}`,
              limit: 1,
            },
          ],
        })
      );
      if (!Array.isArray(result.results) || result.results.length !== 1)
        throw new Error("Incomplete native read result");
      const read = object(result.results[0]);
      if (read.ok !== true)
        throw new Error(
          `Native read stopped: ${typeof read.error_code === "string" ? read.error_code : "UNKNOWN"}`
        );
      if (
        Number(read.feed_id) !== binding.feed_id ||
        !Array.isArray(read.rows) ||
        read.rows.length > 1
      )
        throw new Error("Native read scope mismatch");
      const native = read.rows.length ? object(read.rows[0]) : null;
      if (native && native.id !== ref.metadata.resource_ref)
        throw new Error("Native identity mismatch");
      nativeCache.set(
        cacheKey,
        native
          ? Object.fromEntries(
              [
                "from_me",
                "is_group",
                "sender_member_id",
                "sender_slug",
                "sender_name",
                "sender_jid",
                "sender_phone",
                "push_name",
                "chat_jid",
                "sender_id",
                "sender_handle",
                "handle",
              ]
                .filter(
                  (key) => native[key] !== undefined && native[key] !== null
                )
                .map((key) => [key, native[key]])
            )
          : null
      );
    }
    const native = nativeCache.get(cacheKey);
    if (!native) {
      unresolved.push({ reference: ref, status: "native_unavailable" });
      continue;
    }
    // Source connectors enforce their saved session account before/after the
    // read. Keep the caller's previously established account scope unchanged.
    const metadata = native;
    if (metadata.from_me === true || metadata.from_me === "true") continue;
    try {
      const extracted = extractParticipants(binding, [
        {
          origin_id: ref.metadata.resource_ref,
          observed_at: ref.created_at,
          connection_id: binding.connection_id,
          metadata,
        },
      ]);
      if (
        !extracted.observations.some(
          (item) => item.namespace !== "whatsapp:group"
        )
      )
        throw new Error("Missing participant identifiers");
      input.observations.push(...extracted.observations);
      for (const alias of extracted.aliases ?? []) {
        if (
          !input.aliases!.some(
            (prior) =>
              prior.left === alias.left &&
              prior.right === alias.right &&
              prior.kind === alias.kind
          )
        )
          input.aliases!.push(alias);
      }
    } catch {
      unresolved.push({
        reference: ref,
        status: "unsupported_participant_metadata",
      });
    }
  }
  for (const [feed_id, before] of feedScopes) {
    const after = object(object(await workspace.feeds.get({ feed_id })).feed);
    if (identityDigest(feedScope(before)) !== identityDigest(feedScope(after)))
      throw new Error("Source configuration changed during read");
  }
  const nextUnresolved = uniquePending(unresolved);
  if (!input.observations.length) {
    state.cursor = next_cursor;
    state.unresolved = nextUnresolved;
    return { state, phase: "accepted", changed: 0, linked: 0 };
  }
  const preview = await runMcpIdentity(client, {
    workspace: request.workspace,
    mode: "preview",
    input,
  });
  const pending: Omit<Pending, "digest"> = {
    input,
    next_cursor,
    phase: "import",
    continuation: preview.continuation,
    unresolved: nextUnresolved,
  };
  state.pending = { ...pending, digest: pendingDigest(pending) };
  return { state, phase: "import", changed: 0, linked: 0 };
}
