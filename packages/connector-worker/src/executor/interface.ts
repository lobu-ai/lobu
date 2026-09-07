import type { AgentTurnEvent, AgentTurnInput, AgentTurnOutput, AgentTurnSteer } from '../agent-turn/types.js';
import type {
  AuthResult,
  ConnectorWebhookSchema,
  EventEnvelope,
  SyncCredentials,
  WebhookRegistration,
} from '@lobu/connector-sdk';

/**
 * Executor mode discriminator. The executor speaks the same V1 SDK shapes
 * the connector code expects: `SyncContext` / `ActionContext` / `AuthContext`
 * in, `SyncResult` / `ActionResult` / `AuthResult` out, no envelope.
 */
export type ExecutorJob =
  | {
      mode: 'sync';
      feedKey?: string | null;
      /** Feed-instance id (feeds.id) — namespaces emitted origin_ids per feed. */
      feedId?: number | null;
      config: Record<string, unknown>;
      checkpoint: Record<string, unknown> | null;
      entityIds: number[];
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
    }
  | {
      mode: 'action';
      actionKey: string;
      actionInput: Record<string, unknown>;
      config: Record<string, unknown>;
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
    }
  | {
      mode: 'authenticate';
      config: Record<string, unknown>;
      previousCredentials: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
    }
  | {
      mode: 'query';
      query: string;
      config: Record<string, unknown>;
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
      limit?: number;
      offset?: number;
      sort?: { column: string; order: 'asc' | 'desc' };
    }
  | {
      // Configured feed read: source-native filtering with no platform copy.
      mode: 'read';
      feedKey: string;
      feedId?: number | null;
      query?: string;
      cursor?: string;
      config: Record<string, unknown>;
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
      limit?: number;
      offset?: number;
      sort?: { column: string; order: 'asc' | 'desc' };
    }
  | {
      // Subscribe with the provider at connect time so deliveries flow to
      // `callbackUrl` (`/api/v1/webhooks/:connectionId`). Runs once per
      // connection, not per delivery. Returns the provider subscription id +
      // signing secret to persist on the connection.
      mode: 'webhook_register';
      config: Record<string, unknown>;
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      callbackUrl: string;
      env: Record<string, string | undefined>;
    }
  | {
      // One turn of an agent conversation. Not connector code: `compiledCode`
      // is Lobu's own agent-session guest bundle. `credentials.accessToken` is
      // the gateway's own `lobu_secret_` placeholder for this agent, so the
      // worker never holds a real provider key either — it rides the lane's
      // ordinary credential path and the guest sees the vault's placeholder.
      mode: 'agent_turn';
      turn: AgentTurnInput;
      config: Record<string, unknown>;
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      env: Record<string, string | undefined>;
    }
  | {
      // Tear down the provider subscription created by `webhook_register` when
      // the connection is removed.
      mode: 'webhook_unregister';
      config: Record<string, unknown>;
      credentials: SyncCredentials | null;
      sessionState: Record<string, unknown> | null;
      externalId: string;
      env: Record<string, string | undefined>;
    };

/**
 * Result shape returned by the executor. One discriminated union per mode
 * mirrors the SDK's `ActionResult` / `AuthResult` directly. Sync is
 * streaming-only: events leave via `hooks.onEventChunk`, never collected
 * onto the result — callers that need a list build it themselves in the
 * hook (see e.g. `packages/cli/src/commands/_lib/connector-run-cmd.ts`).
 */
export type ExecutorResult =
  | {
      mode: 'sync';
      checkpoint: Record<string, unknown> | null;
      auth_update?: Record<string, unknown> | null;
      metadata?: Record<string, unknown>;
    }
  | {
      mode: 'action';
      output: Record<string, unknown>;
    }
  | {
      mode: 'authenticate';
      auth: AuthResult;
    }
  | {
      mode: 'query';
      rows: Record<string, unknown>[];
      columns?: { name: string; type: string }[];
      total?: number;
    }
  | {
      mode: 'read';
      rows: Record<string, unknown>[];
      columns?: { name: string; type: string }[];
      total?: number;
      nextCursor?: string;
      hasMore?: boolean;
    }
  | {
      mode: 'webhook_register';
      registration: WebhookRegistration;
      /**
       * The connector's declarative `definition.webhook` scheme. The verifier
       * (gateway ingest hot path) needs `signatureHeader`/`algorithm`/etc. to
       * check provider HMACs, but those fields are NOT persisted to the
       * `connector_definitions` catalog. Returning the scheme here lets the
       * server stamp it onto the connection in the same round-trip as the
       * minted secret + externalId — no extra catalog column / migration.
       */
      webhookScheme: ConnectorWebhookSchema | null;
    }
  | {
      mode: 'agent_turn';
      turn: AgentTurnOutput;
    }
  | {
      mode: 'webhook_unregister';
    };

export interface ExecutionHooks {
  /**
   * Stop the run from outside: the guest is terminated and `execute` rejects
   * with the abort as its error. An agent turn arms this when the gateway's
   * heartbeat answers `continue: false` — the human cancelled — so the model
   * stops mid-turn instead of spending the rest of the wall clock.
   */
  signal?: AbortSignal;
  /** Agent turns: the guest emitted a token or ended a message, mid-stream. */
  onTurnEvent?: (event: AgentTurnEvent) => Promise<void> | void;
  /**
   * Agent turns: messages that arrived for the conversation while the turn
   * was running, taken once each in arrival order. The guest asks at the
   * points pi drains steering — after an assistant message and after a tool
   * result — and hands what it gets to `agent.steer()`.
   */
  takeSteering?: () => ReadonlyArray<AgentTurnSteer>;
  /** Sync runs: connector streamed a chunk of events (and we should persist them). */
  onEventChunk?: (events: EventEnvelope[]) => Promise<void> | void;
  /** Sync runs: connector pushed an incremental checkpoint update. */
  onCheckpointUpdate?: (checkpoint: Record<string, unknown> | null) => Promise<void> | void;
  /** Auth runs: connector emitted an artifact (QR/redirect/prompt/status). */
  onAuthArtifact?: (artifact: Record<string, unknown>) => Promise<void> | void;
  /** Auth runs: connector paused until a named signal arrives. */
  onAwaitAuthSignal?: (
    name: string,
    options?: { timeoutMs?: number }
  ) => Promise<Record<string, unknown>>;
  /**
   * Sync runs: connector code invoked
   * `ctx.sessionState.chrome_dispatcher.dispatch(actionKey, actionInput)`.
   * The host (connector-worker daemon) forwards the call to the gateway
   * (POST /api/workers/dispatch-chrome-action), which inserts a chrome
   * connector action run, waits for the paired Owletto extension to claim
   * and complete it, and returns the observation. Implementations MUST
   * reject when no extension is reachable.
   */
  onChromeDispatch?: (
    actionKey: string,
    actionInput: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
}

/**
 * Pluggable executor interface. The canonical implementation is `IsolateExecutor`;
 * the seam stays around so tests can stub it.
 */
export interface SyncExecutor {
  execute(
    compiledCode: string,
    job: ExecutorJob,
    hooks?: ExecutionHooks
  ): Promise<ExecutorResult>;
}

export type ConnectorExitReason = 'ok' | 'error_message' | 'timeout' | 'oom' | 'crash';

export interface ConnectorExecutionDiagnostics {
  exitCode: number | null;
  exitSignal: string | null;
  outputTail: string;
  exitReason: ConnectorExitReason;
  httpStatus?: number;
}

export class ConnectorExecutionError extends Error implements ConnectorExecutionDiagnostics {
  exitCode: number | null;
  exitSignal: string | null;
  outputTail: string;
  exitReason: ConnectorExitReason;
  httpStatus?: number;

  constructor(
    message: string,
    diagnostics: ConnectorExecutionDiagnostics,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ConnectorExecutionError';
    this.exitCode = diagnostics.exitCode;
    this.exitSignal = diagnostics.exitSignal;
    this.outputTail = diagnostics.outputTail;
    this.exitReason = diagnostics.exitReason;
    this.httpStatus = diagnostics.httpStatus;
  }
}

/** Per-stream ring buffer that preserves the most recent bytes. */
export class RingBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}

  append(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.cap && this.chunks.length > 0) {
      const front = this.chunks[0];
      const overflow = this.size - this.cap;
      if (front.length <= overflow) {
        this.size -= front.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = front.slice(overflow);
        this.size -= overflow;
      }
    }
  }

  toString(): string {
    return this.chunks.join('');
  }
}
