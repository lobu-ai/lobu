/**
 * Worker ⇄ gateway HTTP protocol contract (TypeBox).
 *
 * Single source of truth for the device/connector-worker job protocol:
 * `POST /api/workers/poll`, `/api/workers/complete`, `/complete-action`,
 * `/complete-embeddings`, `/complete-automation`, `/complete-chat`,
 * `/emit-auth-artifact`, `/poll-auth-signal`, `/stream`, and the chrome-action
 * dispatch.
 *
 * Before this module the wire shapes were typed twice with no compiler link:
 *   - the SERVER, inline as `c.req.json<{…}>()` in `worker-api/*` handlers, and
 *   - the WORKER, as hand-written interfaces in
 *     `connector-worker/src/daemon/client.ts`.
 * A field added on one side and missed on the other was a silent protocol
 * mismatch. Both sides now derive their COMPILE-TIME types from the schemas here
 * (the worker re-exports the `Static<>` types; the server annotates its
 * `c.req.json<T>()` bodies with them), so the type checker enforces agreement.
 * These are TypeBox schemas, so a future pass can also validate request bodies
 * against them at runtime — this change only wires the shared types, not
 * runtime validation.
 *
 * INVARIANT — Workers never receive real credentials (see AGENTS.md). The
 * `credentials` / `connection_credentials` on `PollResponse` carry only
 * placeholders / proxied grants the gateway chose to expose; this contract does
 * not change that boundary, it only types what already crosses it.
 */

import { type Static, Type } from "@sinclair/typebox";

// Wire mirror of connector-sdk's ConnectorAutomationSignalDraftSchema. Core is
// deliberately dependency-free from connector-sdk; both the worker and gateway
// compile against this schema at the HTTP boundary.
const ConnectorAutomationSignalDraftSchema = Type.Object(
  {
    event_type: Type.String({ minLength: 1, maxLength: 100 }),
    updated_event_type: Type.Optional(
      Type.String({ minLength: 1, maxLength: 100 })
    ),
    resource_type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    resource_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    label: Type.String({ minLength: 1, maxLength: 300 }),
    input_text: Type.String({ maxLength: 32_000 }),
    url: Type.Optional(Type.String({ maxLength: 2_000 })),
    occurred_at: Type.Optional(Type.String({ maxLength: 64 })),
    attributes: Type.Optional(
      Type.Record(
        Type.String({ maxLength: 100 }),
        Type.Union([
          Type.String({ maxLength: 1_000 }),
          Type.Number(),
          Type.Boolean(),
          Type.Null(),
        ])
      )
    ),
  },
  { additionalProperties: false }
);

/** Run kinds the poller can hand back. */
export const RunTypeSchema = Type.Union([
  Type.Literal("sync"),
  Type.Literal("action"),
  Type.Literal("automation"),
  Type.Literal("chat_message"),
  Type.Literal("embed_backfill"),
  Type.Literal("auth"),
  /**
   * One conversation turn executed as one isolate job, claimed only by a fleet
   * worker that advertises the lane and run through `IsolateExecutor`. Distinct
   * from `chat_message`, a lobu-queue row the gateway drains to a subprocess
   * worker — or, when the agent is device-pinned, hands to that device through
   * this same poll. A daemon that predates this lane must never claim an
   * `agent_turn`: its dispatch would fall through to a connector sync.
   */
  Type.Literal("agent_turn"),
]);

/** Categorized run exit reason on the failed-run path. */
export const WorkerExitReasonSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("cancelled"),
  Type.Literal("error_message"),
  Type.Literal("timeout"),
  Type.Literal("oom"),
  Type.Literal("crash"),
]);

/**
 * Diagnostic fields the connector executor attaches on the failed-run path.
 * The worker redacts `output_tail` before sending; the backend stores it as-is.
 * Shared by `/complete` and `/complete-auth`.
 */
export const WorkerExitDiagnosticsSchema = Type.Object({
  output_tail: Type.Optional(Type.String()),
  exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  exit_signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  exit_reason: Type.Optional(WorkerExitReasonSchema),
});

/**
 * OAuth grant the gateway hands a worker for a run: the access token for this
 * run only, never the refresh token. The worker host keeps it and the isolate
 * guest sees a per-run placeholder in its place.
 */
export const OAuthCredentialsSchema = Type.Object({
  accessToken: Type.String(),
  provider: Type.String(),
  expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

// ── poll ────────────────────────────────────────────────────────────────────

/**
 * Execution backends a worker can advertise capacity for. Declared here, and
 * imported by both the daemon that advertises and the gateway that gates on
 * it, because the two sides only agree by string equality: a typo in either
 * copy silently disables every claim for that worker rather than failing.
 */
export const EXECUTION_BACKENDS = {
  /** Artifact compiled from connector source and executed by the worker. */
  compiledConnector: "compiled_connector",
} as const;

/**
 * What a worker advertises when it sends no `backend_capacity`.
 *
 * Every daemon is compiled-capable by construction: `startDaemonCommand`
 * asserts the compiled runtime resolves and loads before the first poll, so a
 * polling daemon has already proven it.
 *
 * Capacity covers only work the SERVER hands over as code. A connector the
 * endpoint implements itself needs no advertised backend, because the gateway
 * ships nothing to run and the endpoint routes it from its own registry — that
 * is also what lets a device with a broken connector compiler keep serving its
 * native connectors and be recovered through one.
 */
export function defaultBackendCapacity(): Record<string, number> {
  return { [EXECUTION_BACKENDS.compiledConnector]: 1 };
}

/** `POST /api/workers/poll` request body. */
export const PollRequestSchema = Type.Object({
  worker_id: Type.String(),
  capabilities: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  /** Number of additional runs the worker can accept at this instant. */
  capacity_available: Type.Optional(
    Type.Integer({ minimum: 0, maximum: 1024 })
  ),
  /** Per-execution-backend capacity. Zero means the backend is not ready. */
  backend_capacity: Type.Optional(
    Type.Record(Type.String(), Type.Integer({ minimum: 0, maximum: 1024 }))
  ),
  platform: Type.Optional(Type.String()),
  app_version: Type.Optional(Type.String()),
  /**
   * Display name for the device, applied only when this poll is the device's
   * first registration. Later polls ignore it — the name belongs to the user
   * once they set one on the Devices page (`PATCH /api/me/devices/:id`).
   */
  label: Type.Optional(Type.String()),
  connector_manifests: Type.Optional(Type.Unknown()),
  /**
   * Agent kinds this device can run for Automations (e.g. `["claude-code"]`).
   * Advertised by the connector-worker daemon, derived from the binaries
   * actually resolvable on that machine — not the build's static kind table,
   * which would make the gate below inert. The gateway
   * persists it on `device_workers.agent_kinds` and withholds device-pinned
   * runs whose `agent_kind` the device did not advertise. Omit the field
   * entirely when the client runs no CLIs and should stay unrestricted; send
   * `[]` to claim no Automation runs at all — including runs that name no
   * `agent_kind`, since a device that runs nothing has no default either.
   */
  agent_kinds: Type.Optional(Type.Array(Type.String())),
});

/**
 * Per-automation device-worker CLI execution settings. Mirrors the server's
 * `automations.execution_config` jsonb column; a missing key means "use the
 * dispatcher/CLI default". Field names are snake_case to match the wire payload.
 */
export const AutomationExecutionConfigSchema = Type.Object({
  /** Wall-clock cap in seconds; the dispatcher enforces it by SIGTERM. */
  timeout_seconds: Type.Optional(Type.Integer()),
  /** Per-run dollar ceiling (claude-only today). */
  max_budget_usd: Type.Optional(Type.Number()),
  /** Model alias/id (`--model` / `-m`). */
  model: Type.Optional(Type.String()),
  /** Tool permission mode (`--permission-mode`). */
  permission_mode: Type.Optional(Type.String()),
  /** Reasoning effort: low|medium|high (`--effort` / `--variant` / `--thinking`). */
  effort: Type.Optional(Type.String()),
});

/**
 * Automation metadata in the poll envelope. `prompt` is the version-pinned
 * instructions (author prompt + frozen skill snapshots, composed server-side by
 * `formatDeviceAutomationInstructions`); `extraction_schema` is the derived
 * output contract the CLI must satisfy (null for untyped Automations).
 */
export const AutomationPollMetaSchema = Type.Object({
  id: Type.String(),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  slug: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  agent_kind: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  execution_config: Type.Optional(AutomationExecutionConfigSchema),
  prompt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  extraction_schema: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
});

/** Trigger event in the automation poll envelope (`approved_input` verbatim). */
export const AutomationPollEventSchema = Type.Object({
  trigger_event_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  fired_at: Type.String(),
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/** Identity context for a device-local CLI run (automation or chat). */
export const AutomationPollContextSchema = Type.Object({
  device: Type.Object({ worker_id: Type.Optional(Type.String()) }),
  user: Type.Object({
    user_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  }),
  // Device execution: the per-run lobu-memory MCP session when the worker
  // advertises automations.execute. Legacy Mac bridge workers omit it.
  // `token` is a WorkerToken minted for the run's ASSIGNED AGENT — never the
  // polling device's PAT (a child PAT is bound to the user's personal org and
  // can't authenticate to a team org). `mcp_url` is the org-scoped direct MCP
  // endpoint (`<public origin>/mcp/<orgSlug>`), where the bearer opens its own
  // session. The daemon hands both to the spawned CLI as its MCP wiring and as
  // LOBU_API_TOKEN / LOBU_MEMORY_URL so `lobu memory` runs as the run's agent.
  // Absent when the run has no usable assigned agent, or when the legacy worker
  // did not advertise automations.execute. A capable standalone daemon fails
  // closed instead of falling back to its device PAT.
  agent_session: Type.Optional(
    Type.Object({
      conversation_id: Type.String(),
      mcp_url: Type.String(),
      token: Type.String(),
      expires_at: Type.Number(),
      /** Exact same-device ACP session to continue; never discovered by listing sessions. */
      resume_session_id: Type.Optional(
        Type.String({ minLength: 1, maxLength: 512 })
      ),
    })
  ),
});

/**
 * `payload` of an automation poll response — the envelope a device-local CLI
 * executor passes to the spawned agent. Built ad hoc by `poll.ts` and
 * hand-decoded by the Mac app's `AutomationDispatcher`; typed here so the TS
 * daemon can express the same job.
 */
export const AutomationPollPayloadSchema = Type.Object({
  automation: AutomationPollMetaSchema,
  event: AutomationPollEventSchema,
  context: AutomationPollContextSchema,
});

/** One bounded prior turn shipped to a stateless device CLI. */
export const DeviceChatHistoryMessageSchema = Type.Object({
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  content: Type.String({ maxLength: 16_000 }),
});

/** Device-local chat execution metadata. Conversation ownership stays with `agent.id`. */
export const DeviceChatPollPayloadSchema = Type.Object({
  chat: Type.Object({
    agent_kind: Type.String({ minLength: 1, maxLength: 64 }),
    message: Type.String({ maxLength: 32_000 }),
    ephemeral_context: Type.Optional(Type.String({ maxLength: 2_048 })),
    history: Type.Array(DeviceChatHistoryMessageSchema, { maxItems: 12 }),
    agent: Type.Object({
      id: Type.String({ minLength: 1 }),
      name: Type.Optional(Type.String()),
      identity_md: Type.Optional(Type.String()),
      soul_md: Type.Optional(Type.String()),
      user_md: Type.Optional(Type.String()),
    }),
  }),
  context: AutomationPollContextSchema,
});

/**
 * `payload` of an agent-turn poll response.
 *
 * The provider credential is deliberately NOT here: it rides the response's
 * ordinary `credentials.accessToken`, so the worker host conceals it behind a
 * per-run placeholder exactly as it does a connector's OAuth token. Its value
 * is the gateway's own `lobu_secret_` placeholder for the agent, which only the
 * gateway's secret proxy at `base_url` can resolve — the worker never holds a
 * real provider key at either hop.
 */
/**
 * Base64 length of the largest image one turn may carry.
 *
 * The byte cap itself lives with the producer that enforces it
 * (`MAX_TURN_IMAGE_BYTES`, 5 MiB, in the server's `agent-turn-attachments.ts`);
 * this is the same number expressed in the units the wire field is measured
 * in, so the schema can reject an oversized payload without importing the
 * server into the contract package.
 */
const MAX_TURN_IMAGE_BASE64_CHARS = Math.ceil((5 * 1024 * 1024) / 3) * 4;

export const AgentTurnPollPayloadSchema = Type.Object({
  turn: Type.Object({
    agent_id: Type.String({ minLength: 1 }),
    conversation_id: Type.String({ minLength: 1 }),
    message_id: Type.String({ minLength: 1 }),
    /** What the human said, verbatim. May be empty when the turn is attachments only. */
    message_text: Type.String({ maxLength: 32_000 }),
    /**
     * Image attachments of THIS message, already resolved to bytes by the
     * gateway and inlined here as base64.
     *
     * They are inlined rather than referenced because the guest must never
     * fetch an attachment: the producer reads each one out of the artifact
     * store by the artifact id the gateway itself minted for this message, so
     * the bytes the model sees are bytes Lobu already owns, and no attachment
     * URL — signed or not — ever crosses into the isolate. Bounded per image
     * and in total by the producer; an attachment over the bound is dropped
     * with a log line rather than truncated, exactly as the subprocess lane
     * skips an oversized image.
     *
     * The bounds here RESTATE the producer's own caps
     * (`agent-turn-attachments.ts`: 8 images, 5 MiB each) so the contract is
     * checkable on its own rather than only as a property of the one producer
     * that writes it. `maxLength` is the base64 length of a capped image —
     * 4 characters per 3 bytes, rounded up to the padded quantum.
     */
    message_images: Type.Optional(
      Type.Array(
        Type.Object({
          /** `image/png`, `image/jpeg`, … — the artifact's own stored content type. */
          mime_type: Type.String({ minLength: 1, maxLength: 128 }),
          /** The artifact's bytes, base64. */
          data: Type.String({
            minLength: 1,
            maxLength: MAX_TURN_IMAGE_BASE64_CHARS,
          }),
        }),
        { maxItems: 8 }
      )
    ),
    /**
     * The message's NON-IMAGE attachments, as metadata only.
     *
     * The subprocess lane does not send these to the model either — it writes
     * them into the worker's `input/` directory and names them in the prompt.
     * This lane has no such directory, so it carries the same names and types
     * and says so in the prompt; the bytes are deliberately absent, and this
     * field must not be read as a general file capability.
     */
    message_files: Type.Optional(
      Type.Array(
        Type.Object({
          name: Type.String({ minLength: 1, maxLength: 512 }),
          mime_type: Type.String({ minLength: 1, maxLength: 128 }),
          size: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        { maxItems: 32 }
      )
    ),
    system_prompt: Type.String(),
    /** The transcript this turn continues, oldest first, in pi's message shape. */
    messages: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    provider: Type.Object({
      api: Type.Union([
        Type.Literal("anthropic-messages"),
        Type.Literal("openai-completions"),
      ]),
      provider: Type.String({ minLength: 1 }),
      model_id: Type.String({ minLength: 1 }),
      /** The gateway's agent-scoped secret-proxy base URL. */
      base_url: Type.String({ minLength: 1 }),
      max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
      /**
       * The modalities this model accepts, in pi-ai's own `Model.input`
       * vocabulary and resolved from pi-ai's model registry — NOT guessed
       * here. pi reads it to decide whether an image survives to the wire: a
       * model without `"image"` has every image block replaced by
       * "(image omitted: model does not support images)" before the request is
       * built, which is what a non-vision model must get. Absent →
       * the guest assumes text only.
       */
      input: Type.Optional(
        Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), {
          minItems: 1,
        })
      ),
    }),
    /**
     * Tools the turn may call. Each is an MCP tool the gateway proxies, reached
     * from the guest as `POST {gateway_url}/mcp/{mcp_id}/tools/{name}` with the
     * turn's one credential as the bearer — the same worker token the secret
     * proxy accepts, so a turn with tools still carries exactly one secret.
     * Absent → the turn runs with no tools.
     */
    tools: Type.Optional(
      Type.Object({
        /** The gateway the MCP route lives on, mount path included. */
        gateway_url: Type.String({ minLength: 1 }),
        definitions: Type.Array(
          Type.Object({
            mcp_id: Type.String({ minLength: 1 }),
            name: Type.String({ minLength: 1 }),
            description: Type.String(),
            /** The tool's JSON schema for its arguments, as the MCP server published it. */
            input_schema: Type.Record(Type.String(), Type.Unknown()),
          })
        ),
        /**
         * The guest's own workspace tools the agent's tool policy admits. They
         * run against a per-turn in-memory filesystem inside the isolate:
         * `bash` is just-bash, the rest are pi's file tools over the same
         * filesystem. Absent or empty → no workspace tools.
         */
        builtin: Type.Optional(
          Type.Array(
            Type.Union([
              Type.Literal("bash"),
              Type.Literal("read"),
              Type.Literal("write"),
              Type.Literal("ls"),
              Type.Literal("find"),
            ])
          )
        ),
        /** The agent's bash prefix policy, enforced before a command runs. */
        bash_policy: Type.Optional(
          Type.Object({
            allow_all: Type.Boolean(),
            allow_prefixes: Type.Array(Type.String()),
            deny_prefixes: Type.Array(Type.String()),
          })
        ),
        /**
         * The gateway tools the agent's tool policy admits, by NAME only —
         * `ask_user`, `send_message`, `suggest_actions` and the rest of
         * `@lobu/plugin-conversations`. The guest runs that package's own
         * implementation, so the route, the request body and the schema live
         * there and never on this wire; sending a name the package does not
         * define drops the tool rather than inventing one.
         *
         * They reach the SAME gateway on the SAME bearer as the MCP tools
         * above, so a turn with them still carries exactly one credential.
         */
        gateway: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        /**
         * Which conversation those tools post into. Required whenever
         * `gateway` is non-empty: a tool that addresses a channel cannot
         * default one, and the guest must never infer routing.
         */
        conversation: Type.Optional(
          Type.Object({
            channel_id: Type.String({ minLength: 1 }),
            conversation_id: Type.String({ minLength: 1 }),
            platform: Type.String({ minLength: 1 }),
          })
        ),
      })
    ),
    /**
     * Hosts the turn may reach. An agent turn is deny-all by default, unlike a
     * connector's open one, so this is normally just the gateway.
     */
    allowed_hosts: Type.Array(Type.String({ minLength: 1 })),
    /** Shadow runs report their result and never reach the conversation. */
    shadow: Type.Boolean(),
  }),
});

/** `POST /api/workers/poll` response body (a claimed run, or a poll-again). */
export const PollResponseSchema = Type.Object({
  next_poll_seconds: Type.Optional(Type.Number()),
  page_activations: Type.Optional(
    Type.Array(
      Type.Object({
        run_id: Type.Integer(),
        urls: Type.Array(Type.String()),
      })
    )
  ),
  run_id: Type.Optional(Type.Integer()),
  run_type: Type.Optional(RunTypeSchema),
  auth_profile_id: Type.Optional(Type.Integer()),
  previous_credentials: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  connector_key: Type.Optional(Type.String()),
  feed_key: Type.Optional(Type.String()),
  /**
   * Contract identity of the pinned manifest artifact, so a device can refuse
   * a manifest it does not implement at that exact hash.
   */
  connector_manifest_hash: Type.Optional(Type.String({ minLength: 1 })),
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  db_egress_policy: Type.Optional(
    Type.Union([Type.Literal("block-private"), Type.Literal("allow-private")])
  ),
  /**
   * Operator-configured exact hosts (comma-separated) exempt from the private-IP
   * range check under `block-private` — e.g. a Tailscale/CGNAT DB. Travels the
   * same gateway-authoritative channel as `db_egress_policy` and REPLACES any
   * worker-local list. Never exempts metadata/link-local/multicast.
   */
  db_egress_allow_hosts: Type.Optional(Type.String()),
  checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  entity_ids: Type.Optional(Type.Array(Type.Integer())),
  credentials: Type.Optional(Type.Union([OAuthCredentialsSchema, Type.Null()])),
  connection_credentials: Type.Optional(
    Type.Record(Type.String(), Type.Unknown())
  ),
  connection_id: Type.Optional(Type.Integer()),
  feed_id: Type.Optional(Type.Integer()),
  compiled_code: Type.Optional(Type.String()),
  session_state: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  connector_version: Type.Optional(Type.String()),
  action_key: Type.Optional(Type.String()),
  /** Native device operation key; public connector operations use action_key. */
  operation_key: Type.Optional(Type.String()),
  action_input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  entity: Type.Optional(
    Type.Object({
      id: Type.Integer(),
      name: Type.String(),
      entity_type: Type.String(),
      metadata: Type.Record(Type.String(), Type.Unknown()),
    })
  ),
  /** Owning org of a claimed device-local CLI run. */
  organization_id: Type.Optional(Type.String()),
  /**
   * Device-local CLI envelope for `automation` or `chat_message` runs. The
   * gateway composes the prompt context and the device reports through the
   * matching completion endpoint. No connector code or credentials are shipped.
   */
  payload: Type.Optional(
    Type.Union([
      AutomationPollPayloadSchema,
      DeviceChatPollPayloadSchema,
      AgentTurnPollPayloadSchema,
    ])
  ),
});

export const ActivatePageRequestSchema = Type.Object({
  worker_id: Type.String({ minLength: 1 }),
  run_id: Type.Integer({ minimum: 1 }),
  tab_id: Type.Integer({ minimum: 0 }),
  url: Type.String({ format: "uri" }),
});

export const ActivatePageResponseSchema = Type.Object({
  status: Type.Union([Type.Literal("activated"), Type.Literal("unavailable")]),
});

// ── stream ──────────────────────────────────────────────────────────────────

/**
 * One collected item in a `/stream` batch. This is the SERVER-accepted superset:
 * the connector-worker's `ContentItem` sends the plain-content subset (id,
 * payload_text, author/source/score/embedding…), while richer producers (the
 * chrome extension, json_template feeds) also send `payload_type` + the
 * `payload_data`/`payload_template`/`attachments` it selects. All are optional
 * so a bare content item still validates.
 */
export const ContentItemSchema = Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  payload_type: Type.Optional(
    Type.Union([
      Type.Literal("text"),
      Type.Literal("markdown"),
      Type.Literal("json_template"),
      Type.Literal("media"),
      Type.Literal("empty"),
    ])
  ),
  payload_text: Type.String(),
  payload_data: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  payload_template: Type.Optional(
    Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])
  ),
  attachments: Type.Optional(Type.Array(Type.Unknown())),
  author_name: Type.Optional(Type.String()),
  occurred_at: Type.String(),
  source_url: Type.Optional(Type.String()),
  score: Type.Optional(Type.Number()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  origin_parent_id: Type.Optional(Type.String()),
  embedding: Type.Optional(Type.Array(Type.Number())),
  embedding_model: Type.Optional(Type.String()),
  origin_type: Type.Optional(Type.String()),
  semantic_type: Type.Optional(Type.String()),
  automation_signals: Type.Optional(
    Type.Array(ConnectorAutomationSignalDraftSchema, { maxItems: 16 })
  ),
});

/**
 * `POST /api/workers/stream` batch body. `worker_id` is optional here (unlike
 * the /complete family): a legacy streamer may omit it, and the run-ownership
 * gate on /stream keys off the run's claimed_by, not this field.
 */
export const StreamBatchSchema = Type.Object({
  type: Type.Literal("batch"),
  run_id: Type.Integer(),
  worker_id: Type.Optional(Type.String()),
  items: Type.Array(ContentItemSchema),
  checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// ── complete family ─────────────────────────────────────────────────────────

/** `POST /api/workers/complete` (sync/automation run terminal report). */
export const CompleteRequestSchema = Type.Composite([
  Type.Object({
    run_id: Type.Integer(),
    worker_id: Type.String(),
    status: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
    items_collected: Type.Optional(Type.Integer()),
    error_message: Type.Optional(Type.String()),
    checkpoint: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    auth_update: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  WorkerExitDiagnosticsSchema,
]);

/** `POST /api/workers/complete-action`. */
export const CompleteActionRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  status: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
  action_output: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  error_message: Type.Optional(Type.String()),
});

/** One event returned by `/fetch-events-for-embedding` for the worker to embed. */
export const EmbedEventSchema = Type.Object({
  id: Type.Integer(),
  content: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
});

/** One (event, chunk) embedding in a `/complete-embeddings` batch. */
export const EmbeddingEntrySchema = Type.Object({
  event_id: Type.Integer(),
  chunk_index: Type.Integer(),
  embedding: Type.Array(Type.Number()),
  embedding_model: Type.Optional(Type.String()),
});

/** `POST /api/workers/complete-embeddings`. */
export const CompleteEmbeddingsRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  embeddings: Type.Array(EmbeddingEntrySchema),
  error_message: Type.Optional(Type.String()),
});

/**
 * `POST /api/workers/complete-auth` (auth run terminal report). Carries the
 * same exit diagnostics as `/complete`.
 */
export const CompleteAuthRequestSchema = Type.Composite([
  Type.Object({
    run_id: Type.Integer(),
    worker_id: Type.String(),
    status: Type.Union([Type.Literal("success"), Type.Literal("failed")]),
    credentials: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    error_message: Type.Optional(Type.String()),
  }),
  WorkerExitDiagnosticsSchema,
]);

/**
 * `POST /api/workers/me/runs/:runId/complete-automation` (device-side EXIT
 * REPORT). The run id travels in the URL, not the body. Reports process exit
 * metadata for an automation run executed by a local CLI agent; `finalize_attempt`
 * is the finalize round the reporting spawn ran under (0 for the first), which
 * makes the report replayable across a lost response.
 */
export const CompleteAutomationRequestSchema = Type.Object({
  worker_id: Type.String(),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  duration_ms: Type.Optional(Type.Integer()),
  exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  exit_signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  exit_reason: Type.Optional(WorkerExitReasonSchema),
  finalize_attempt: Type.Optional(Type.Integer()),
});

/**
 * Response from `complete-automation`. `status: "resume"` means the run is
 * still claimed and the device should re-spawn its CLI with `nudge` appended
 * (bounded by `max_attempts`). Other statuses are terminal.
 */
export const CompleteAutomationResponseSchema = Type.Object({
  ok: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  status: Type.String(),
  reason_code: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  attempt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  max_attempts: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  nudge: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  run_id: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  idempotent: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
});

/** `POST .../complete-chat` terminal report for a `chat_message` turn. */
export const CompleteDeviceChatRequestSchema = Type.Object({
  worker_id: Type.String(),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  exit_code: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  exit_signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  exit_reason: Type.Optional(WorkerExitReasonSchema),
});

export const CompleteDeviceChatResponseSchema = Type.Object({
  ok: Type.Boolean(),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
  idempotent: Type.Optional(Type.Boolean()),
});

/**
 * `POST /api/workers/complete-agent-turn`.
 *
 * `transcript` is what the turn produced, to resume the next one from. A shadow
 * run reports it and nothing else happens; when the lane becomes authoritative
 * the same body carries the reply.
 */
export const CompleteAgentTurnRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
  text: Type.Optional(Type.String()),
  stop_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  usage: Type.Optional(
    Type.Union([
      Type.Object({ input: Type.Integer(), output: Type.Integer() }),
      Type.Null(),
    ])
  ),
  transcript: Type.Optional(
    Type.Array(Type.Record(Type.String(), Type.Unknown()))
  ),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  exit_reason: Type.Optional(WorkerExitReasonSchema),
});

export const CompleteAgentTurnResponseSchema = Type.Object({
  ok: Type.Boolean(),
  status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
  idempotent: Type.Optional(Type.Boolean()),
});

// ── auth signalling ─────────────────────────────────────────────────────────

/** `POST /api/workers/emit-auth-artifact`. */
export const EmitAuthArtifactRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  artifact: Type.Record(Type.String(), Type.Unknown()),
});

/** `POST /api/workers/poll-auth-signal` request. */
export const PollAuthSignalRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  signal_name: Type.String(),
});

/** `POST /api/workers/poll-auth-signal` response. */
export const PollAuthSignalResponseSchema = Type.Object({
  signal: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

/**
 * Ceiling on a single streamed turn delta, in characters.
 *
 * The same bound the terminal reply takes (`TURN_MESSAGE_CHARS`); a delta is a
 * prefix of that reply, so anything longer is not a longer answer but a
 * runaway. The guest clamps to it, and the schema rejects past it.
 */
export const TURN_DELTA_MAX_CHARS = 24_000;

/**
 * `POST /api/workers/heartbeat`. `progress` is a coarse liveness counter, not an
 * authoritative item count (that arrives on `/stream` + `/complete`).
 */
export const HeartbeatRequestSchema = Type.Object({
  run_id: Type.Integer(),
  worker_id: Type.String(),
  /** Durable checkpoint written before the first prompt in a new ACP session. */
  agent_session: Type.Optional(
    Type.Object({
      protocol: Type.Literal("acp"),
      agent_kind: Type.Union([
        Type.Literal("claude-code"),
        Type.Literal("codex"),
        Type.Literal("opencode"),
      ]),
      session_id: Type.String({ minLength: 1, maxLength: 512 }),
    })
  ),
  progress: Type.Optional(
    Type.Object({
      items_collected_so_far: Type.Optional(Type.Integer()),
    })
  ),
  /**
   * The assistant text an `agent_turn` has produced SO FAR, so a client
   * watching the conversation sees the answer arrive instead of a blank screen
   * for the length of the turn.
   *
   * It rides the heartbeat rather than a route of its own because the turn
   * already beats on an interval for exactly this reason — to say it is still
   * alive — and a delta is that same statement carrying its evidence. The
   * connector `/stream` route is not the vehicle: that one ingests connector
   * EVENTS into an org's memory, which a chat delta is not.
   *
   * `text` is CUMULATIVE, not incremental. A heartbeat is best-effort and may
   * be dropped or retried, and a lost incremental chunk would leave a hole in
   * the reply that nothing later repairs; a cumulative snapshot is idempotent,
   * so the newest one that arrives is always correct on its own.
   *
   * Routing is deliberately absent. The server reads where to deliver from the
   * run's own row, never from this body — a worker may be compromised, and the
   * same rule already governs `/worker/response`.
   */
  turn_delta: Type.Optional(
    Type.Object({
      text: Type.String({ maxLength: TURN_DELTA_MAX_CHARS }),
      /**
       * Monotonic per turn. The server keeps the highest it has seen and drops
       * anything older, so a retried or reordered heartbeat can never walk the
       * visible reply backwards.
       */
      sequence: Type.Integer({ minimum: 0 }),
    })
  ),
});

/**
 * The heartbeat's reply, and the only channel the gateway has back into a run
 * it has already handed to a worker. A claimed run belongs to whichever fleet
 * worker holds its lease, and the gateway cannot address that process — so
 * anything it needs to tell a turn in flight rides the beat the worker is
 * already making.
 *
 * `continue: false` means stop: the run left `running` under this worker's
 * lease, because a human cancelled it or the lease was lost. The worker
 * finishes through its normal completion path rather than abandoning the run,
 * so the terminal row and the client's reply are still written by the lane
 * that owns them.
 *
 * `steer` carries a message that arrived while this turn was running and is
 * meant for the model now rather than for the next turn. Absent on every beat
 * that has nothing to inject, which is nearly all of them.
 */
export const HeartbeatResponseSchema = Type.Object({
  continue: Type.Boolean(),
  /** Why the gateway asked the worker to stop. Only set when `continue` is false. */
  stop_reason: Type.Optional(
    Type.Union([Type.Literal("cancelled"), Type.Literal("lease_lost")])
  ),
  steer: Type.Optional(
    Type.Object({
      message_id: Type.String(),
      text: Type.String(),
    })
  ),
});

/**
 * Request the gateway dispatch a chrome connector action on behalf of a
 * running sync. Scoped to the parent run's org.
 */
export const DispatchChromeActionRequestSchema = Type.Object({
  parent_run_id: Type.Integer(),
  worker_id: Type.String(),
  action_key: Type.String(),
  action_input: Type.Record(Type.String(), Type.Unknown()),
});

/** Gateway → worker result of a dispatched chrome action. */
export const DispatchChromeActionResponseSchema = Type.Object({
  status: Type.Union([
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("timeout"),
  ]),
  output: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  error_message: Type.Optional(Type.String()),
});

export type RunType = Static<typeof RunTypeSchema>;
export type WorkerExitReason = Static<typeof WorkerExitReasonSchema>;
export type WorkerExitDiagnostics = Static<typeof WorkerExitDiagnosticsSchema>;
export type OAuthCredentials = Static<typeof OAuthCredentialsSchema>;
export type PollRequest = Static<typeof PollRequestSchema>;
export type PollResponse = Static<typeof PollResponseSchema>;
export type AutomationExecutionConfig = Static<
  typeof AutomationExecutionConfigSchema
>;
export type AutomationPollMeta = Static<typeof AutomationPollMetaSchema>;
export type AutomationPollEvent = Static<typeof AutomationPollEventSchema>;
export type AutomationPollContext = Static<typeof AutomationPollContextSchema>;
export type AutomationPollPayload = Static<typeof AutomationPollPayloadSchema>;
export type DeviceChatHistoryMessage = Static<
  typeof DeviceChatHistoryMessageSchema
>;
export type DeviceChatPollPayload = Static<typeof DeviceChatPollPayloadSchema>;
export type CompleteAutomationRequest = Static<
  typeof CompleteAutomationRequestSchema
>;
export type CompleteAutomationResponse = Static<
  typeof CompleteAutomationResponseSchema
>;
export type CompleteDeviceChatRequest = Static<
  typeof CompleteDeviceChatRequestSchema
>;
export type CompleteDeviceChatResponse = Static<
  typeof CompleteDeviceChatResponseSchema
>;
export type AgentTurnPollPayload = Static<typeof AgentTurnPollPayloadSchema>;
export type CompleteAgentTurnRequest = Static<
  typeof CompleteAgentTurnRequestSchema
>;
export type CompleteAgentTurnResponse = Static<
  typeof CompleteAgentTurnResponseSchema
>;
export type ActivatePageRequest = Static<typeof ActivatePageRequestSchema>;
export type ActivatePageResponse = Static<typeof ActivatePageResponseSchema>;
export type ContentItem = Static<typeof ContentItemSchema>;
export type StreamBatch = Static<typeof StreamBatchSchema>;
export type CompleteRequest = Static<typeof CompleteRequestSchema>;
export type CompleteActionRequest = Static<typeof CompleteActionRequestSchema>;
export type EmbedEvent = Static<typeof EmbedEventSchema>;
export type EmbeddingEntry = Static<typeof EmbeddingEntrySchema>;
export type CompleteEmbeddingsRequest = Static<
  typeof CompleteEmbeddingsRequestSchema
>;
export type CompleteAuthRequest = Static<typeof CompleteAuthRequestSchema>;
export type EmitAuthArtifactRequest = Static<
  typeof EmitAuthArtifactRequestSchema
>;
export type PollAuthSignalRequest = Static<typeof PollAuthSignalRequestSchema>;
export type PollAuthSignalResponse = Static<
  typeof PollAuthSignalResponseSchema
>;
export type HeartbeatRequest = Static<typeof HeartbeatRequestSchema>;
export type HeartbeatResponse = Static<typeof HeartbeatResponseSchema>;
export type DispatchChromeActionRequest = Static<
  typeof DispatchChromeActionRequestSchema
>;
export type DispatchChromeActionResponse = Static<
  typeof DispatchChromeActionResponseSchema
>;
