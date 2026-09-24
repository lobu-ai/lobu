import type {
  AutomationScriptContext,
  ReactionClient,
} from "@lobu/connector-sdk";

interface PollResult {
  option: string;
  count: number;
}

interface PollState {
  question: string;
  options: string[];
  status: "open" | "closed";
  quorum: number;
  closes_at: string;
  results: PollResult[];
  response_count: number;
  close_reason?: "quorum" | "deadline";
  closed_at?: string;
}

interface TriggerEvent {
  id: number;
  entity_ids: number[];
  origin_type: string | null;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

interface EventHead {
  id: number;
  semantic_type: "poll_opened" | "poll_closed";
  metadata: PollState;
}

function sameResults(left: PollResult[], right: PollResult[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (result, index) =>
        result.option === right[index]?.option &&
        result.count === right[index]?.count
    )
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveIntegerList(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string" && /^\{\d+(,\d+)*\}$/.test(value)
      ? value.slice(1, -1).split(",")
      : [];
  return values.flatMap((item) => {
    const parsed = positiveInteger(item);
    return parsed == null ? [] : [parsed];
  });
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pollState(value: unknown): PollState | null {
  const row = objectValue(value);
  const options = Array.isArray(row.options)
    ? row.options.filter(
        (option): option is string => typeof option === "string"
      )
    : [];
  const closesAt = typeof row.closes_at === "string" ? row.closes_at : "";
  const closesAtMs = Date.parse(closesAt);
  const quorum = positiveInteger(row.quorum);
  if (
    typeof row.question !== "string" ||
    options.length < 2 ||
    quorum == null ||
    !Number.isFinite(closesAtMs) ||
    (row.status !== "open" && row.status !== "closed")
  ) {
    return null;
  }
  return {
    question: row.question,
    options,
    status: row.status,
    quorum,
    closes_at: closesAt,
    results: Array.isArray(row.results)
      ? row.results.flatMap((entry) => {
          const result = objectValue(entry);
          return typeof result.option === "string" &&
            Number.isFinite(Number(result.count))
            ? [{ option: result.option, count: Number(result.count) }]
            : [];
        })
      : options.map((option) => ({ option, count: 0 })),
    response_count: Math.max(0, Number(row.response_count) || 0),
    ...(row.close_reason === "quorum" || row.close_reason === "deadline"
      ? { close_reason: row.close_reason }
      : {}),
    ...(typeof row.closed_at === "string" ? { closed_at: row.closed_at } : {}),
  };
}

async function readTrigger(
  ctx: AutomationScriptContext,
  client: ReactionClient
): Promise<TriggerEvent | null> {
  // This is an event handler: read the exact durable activation, not a time
  // window that may contain neighboring votes or exclude a delayed event.
  const signals = ctx.trigger_signals
    .map(objectValue)
    .filter(
      (signal) =>
        signal.kind === "event" &&
        signal.source === "workspace" &&
        signal.event_type === "poll_vote_cast"
    );
  if (signals.length !== 1) throw new Error("Expected one queued poll vote");
  const triggerId = positiveInteger(signals[0].event_id);
  if (triggerId == null) throw new Error("Invalid queued poll vote id");
  const page = objectValue(
    await client.knowledge.read({
      content_ids: [triggerId],
      limit: 1,
    })
  );
  const content = Array.isArray(page.content) ? page.content : [];
  const matches = content.filter(
    (item) =>
      objectValue(item).semantic_type === "poll_vote_cast" &&
      positiveInteger(objectValue(item).id) === triggerId
  );
  if (matches.length !== 1)
    throw new Error("Queued poll vote was not readable");
  const row = objectValue(matches[0]);
  const id = positiveInteger(row.id);
  if (id == null) return null;
  return {
    id,
    entity_ids: positiveIntegerList(row.entity_ids),
    origin_type: typeof row.origin_type === "string" ? row.origin_type : null,
    occurred_at: typeof row.occurred_at === "string" ? row.occurred_at : "",
    metadata: objectValue(row.metadata),
  };
}

async function pollEntityId(
  trigger: TriggerEvent,
  client: ReactionClient
): Promise<number | null> {
  if (trigger.entity_ids.length === 0) return null;
  const rows = (await client.query(
    `SELECT id FROM entities
     WHERE entity_type = 'poll'
       AND id IN (${trigger.entity_ids.join(",")})
       AND deleted_at IS NULL
     ORDER BY id
     LIMIT 2`
  )) as Array<{ id: number | string }>;
  return rows.length === 1 ? positiveInteger(rows[0].id) : null;
}

async function currentHead(
  entityId: number,
  client: ReactionClient
): Promise<EventHead | null> {
  const rows = (await client.query(
    `SELECT id, semantic_type, metadata
     FROM events
     WHERE entity_ids @> ARRAY[${entityId}]::bigint[]
       AND semantic_type IN ('poll_opened', 'poll_closed')
     ORDER BY id DESC
     LIMIT 2`
  )) as Array<{
    id: number | string;
    semantic_type: string;
    metadata: unknown;
  }>;
  if (rows.length !== 1) return null;
  const id = positiveInteger(rows[0].id);
  const state = pollState(rows[0].metadata);
  if (
    id == null ||
    state == null ||
    (rows[0].semantic_type !== "poll_opened" &&
      rows[0].semantic_type !== "poll_closed") ||
    (rows[0].semantic_type === "poll_opened" && state.status !== "open") ||
    (rows[0].semantic_type === "poll_closed" && state.status !== "closed")
  ) {
    return null;
  }
  return { id, semantic_type: rows[0].semantic_type, metadata: state };
}

async function saveSuccessor(params: {
  ctx: AutomationScriptContext;
  client: ReactionClient;
  entityId: number;
  headId: number;
  triggerId: number;
  state: PollState;
  alreadyClosed: boolean;
}): Promise<void> {
  const closed = params.state.status === "closed";
  await params.client.knowledge.save({
    entity_ids: [params.entityId],
    content: closed
      ? `Poll closed by ${params.state.close_reason}.`
      : `Poll tally updated after vote event ${params.triggerId}.`,
    title: closed ? `${params.state.question} — closed` : params.state.question,
    semantic_type: closed ? "poll_closed" : "poll_opened",
    payload_type: "empty",
    metadata: params.state as unknown as Record<string, unknown>,
    supersedes_event_id: params.headId,
    idempotency_key: params.alreadyClosed
      ? `poll-finalize:${params.entityId}:vote:${params.triggerId}`
      : closed
        ? `poll-close:${params.entityId}`
        : `poll-state:${params.entityId}:vote:${params.triggerId}`,
    automation_source: {
      automation_id: params.ctx.window.automation_id,
      run_id: params.ctx.window.run_id,
    },
  });
}

async function updatePollEntity(
  entityId: number,
  state: PollState,
  client: ReactionClient
): Promise<void> {
  await client.entities.update({
    entity_id: entityId,
    metadata: state as unknown as Record<string, unknown>,
  });
}

async function currentResponseEvent(
  entityId: number,
  platform: string,
  actorId: string,
  client: ReactionClient
): Promise<{ id: number; voteEventId: number } | null> {
  const rows = (await client.query(
    `SELECT id, metadata
     FROM events
     WHERE entity_ids @> ARRAY[${entityId}]::bigint[]
       AND semantic_type = 'poll_response_recorded'
       AND metadata->>'platform' = ${sqlLiteral(platform)}
       AND metadata->>'actor_id' = ${sqlLiteral(actorId)}
     ORDER BY id DESC
     LIMIT 2`
  )) as Array<{ id: number | string; metadata: unknown }>;
  if (rows.length > 1) {
    throw new Error("Ambiguous current poll response projection");
  }
  if (!rows[0]) return null;
  const id = positiveInteger(rows[0].id);
  const voteEventId = positiveInteger(
    objectValue(rows[0].metadata).vote_event_id
  );
  if (id == null || voteEventId == null) {
    throw new Error("Invalid current poll response projection");
  }
  return { id, voteEventId };
}

async function upsertResponseEvent(params: {
  ctx: AutomationScriptContext;
  pollEntityId: number;
  platform: string;
  actorId: string;
  choice: string;
  trigger: TriggerEvent;
  client: ReactionClient;
}): Promise<void> {
  const current = await currentResponseEvent(
    params.pollEntityId,
    params.platform,
    params.actorId,
    params.client
  );
  if (current && current.voteEventId >= params.trigger.id) return;
  await params.client.knowledge.save({
    entity_ids: [params.pollEntityId],
    content: `Current poll response from vote event ${params.trigger.id}.`,
    semantic_type: "poll_response_recorded",
    payload_type: "empty",
    metadata: {
      platform: params.platform,
      actor_id: params.actorId,
      choice: params.choice,
      vote_event_id: params.trigger.id,
      updated_at: params.trigger.occurred_at,
    },
    ...(current ? { supersedes_event_id: current.id } : {}),
    idempotency_key: `poll-response:${params.pollEntityId}:vote:${params.trigger.id}`,
    automation_source: {
      automation_id: params.ctx.window.automation_id,
      run_id: params.ctx.window.run_id,
    },
  });
}

async function resultsForPoll(
  entityId: number,
  options: string[],
  client: ReactionClient
): Promise<{ results: PollResult[]; responseCount: number }> {
  // The event view contains one current projection per actor. Legacy entity
  // rows are a bounded cutover source for polls opened before this event kind.
  const rows = (await client.query(
    `WITH candidates AS (
       SELECT metadata
       FROM entities
       WHERE entity_type = 'poll-response'
         AND deleted_at IS NULL
         AND (metadata->>'poll_entity_id')::bigint = ${entityId}
       UNION ALL
       SELECT metadata
       FROM events
       WHERE entity_ids @> ARRAY[${entityId}]::bigint[]
         AND semantic_type = 'poll_response_recorded'
     ), latest AS (
       SELECT metadata->>'choice' AS choice,
              row_number() OVER (
                PARTITION BY metadata->>'platform', metadata->>'actor_id'
                ORDER BY (metadata->>'vote_event_id')::bigint DESC,
                         (metadata->>'updated_at')::timestamptz DESC
              ) AS rank
       FROM candidates
     )
     SELECT choice, count(*)::int AS count
     FROM latest
     WHERE rank = 1
     GROUP BY choice
     ORDER BY choice
     LIMIT 100`
  )) as Array<{ choice: string; count: number | string }>;
  const counts = new Map(
    rows.map((row) => [row.choice, Math.max(0, Number(row.count) || 0)])
  );
  const results = options.map((option) => ({
    option,
    count: counts.get(option) ?? 0,
  }));
  return {
    results,
    responseCount: results.reduce((sum, result) => sum + result.count, 0),
  };
}

export default async function reducePollVote(
  ctx: AutomationScriptContext,
  client: ReactionClient
): Promise<void> {
  const trigger = await readTrigger(ctx, client);
  if (!trigger || trigger.origin_type !== "template_interaction") return;

  const interaction = objectValue(trigger.metadata.interaction);
  const actor = objectValue(interaction.actor);
  const choice = typeof interaction.value === "string" ? interaction.value : "";
  const platform = typeof actor.platform === "string" ? actor.platform : "";
  const actorId = typeof actor.id === "string" ? actor.id : "";
  if (
    interaction.action !== "vote" ||
    positiveInteger(interaction.source_event_id) == null ||
    !choice ||
    !platform ||
    !actorId ||
    platform.length > 50 ||
    actorId.length > 500
  ) {
    return;
  }

  const entityId = await pollEntityId(trigger, client);
  if (entityId == null) return;
  const head = await currentHead(entityId, client);
  if (!head) return;
  if (!head.metadata.options.includes(choice)) return;

  const voteAt = Date.parse(trigger.occurred_at);
  const closesAt = Date.parse(head.metadata.closes_at);
  const deadlineReached = !Number.isFinite(voteAt) || voteAt >= closesAt;
  const alreadyClosed = head.semantic_type === "poll_closed";
  if (alreadyClosed && deadlineReached) {
    await updatePollEntity(entityId, head.metadata, client);
    return;
  }
  if (!deadlineReached) {
    await upsertResponseEvent({
      ctx,
      pollEntityId: entityId,
      platform,
      actorId,
      choice,
      trigger,
      client,
    });
  }

  const { results, responseCount } = await resultsForPoll(
    entityId,
    head.metadata.options,
    client
  );
  const reachedQuorum = results.some(
    (result) => result.count >= head.metadata.quorum
  );
  const closed = alreadyClosed || deadlineReached || reachedQuorum;
  const next: PollState = {
    ...head.metadata,
    status: closed ? "closed" : "open",
    results,
    response_count: responseCount,
    ...(closed && !alreadyClosed
      ? {
          close_reason: deadlineReached ? "deadline" : "quorum",
          closed_at: new Date().toISOString(),
        }
      : {}),
  };
  if (
    alreadyClosed &&
    next.response_count === head.metadata.response_count &&
    sameResults(next.results, head.metadata.results)
  ) {
    await updatePollEntity(entityId, next, client);
    return;
  }
  try {
    await saveSuccessor({
      ctx,
      client,
      entityId,
      headId: head.id,
      triggerId: trigger.id,
      state: next,
      alreadyClosed,
    });
  } catch (error) {
    // A deadline wake-up may close the head after this accepted pre-deadline
    // vote was materialized. Reconcile that durable response into a terminal
    // successor instead of silently losing it from the displayed tally.
    const winner = await currentHead(entityId, client);
    if (winner?.semantic_type !== "poll_closed" || deadlineReached) throw error;
    const reconciled = await resultsForPoll(
      entityId,
      winner.metadata.options,
      client
    );
    const terminal: PollState = {
      ...winner.metadata,
      results: reconciled.results,
      response_count: reconciled.responseCount,
    };
    if (
      terminal.response_count !== winner.metadata.response_count ||
      !sameResults(terminal.results, winner.metadata.results)
    ) {
      await saveSuccessor({
        ctx,
        client,
        entityId,
        headId: winner.id,
        triggerId: trigger.id,
        state: terminal,
        alreadyClosed: true,
      });
    }
    await updatePollEntity(entityId, terminal, client);
    return;
  }
  await updatePollEntity(entityId, next, client);
  client.log("Poll vote reduced", {
    poll_entity_id: entityId,
    vote_event_id: trigger.id,
    status: next.status,
    response_count: next.response_count,
  });
}
