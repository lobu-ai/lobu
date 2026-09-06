/**
 * Worker API Client
 *
 * HTTP client for communicating with the backend worker API endpoints.
 * Updated for V1 integration platform: runs-based job model.
 */

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return end === value.length ? value : value.slice(0, end);
}

// ============================================
// ExecutorClient Interface
// ============================================

/**
 * Interface for job execution clients.
 * Implemented by WorkerClient (HTTP).
 * Allows the executor to work without coupling to a specific transport.
 */
export interface ExecutorClient {
  readonly id: string;
  poll(capacityAvailable?: number): Promise<PollResponse>;
  /**
   * Beat, and read what the gateway says back. The response is the only channel
   * into a run this worker already holds: `continue: false` means stop.
   */
  heartbeat(
    runId: number,
    progress?: {
      items_collected_so_far?: number;
      current_page?: number;
      elapsed_ms?: number;
    },
    agentSession?: NonNullable<HeartbeatRequest['agent_session']>,
    turnDelta?: NonNullable<HeartbeatRequest['turn_delta']>
  ): Promise<HeartbeatResponse>;
  stream(batch: StreamBatch): Promise<void>;
  complete(req: CompleteRequest): Promise<void>;
  completeAction(req: CompleteActionRequest): Promise<void>;
  fetchEventsForEmbedding(eventIds: number[]): Promise<EmbedEvent[]>;
  completeEmbeddings(req: CompleteEmbeddingsRequest): Promise<void>;
  emitAuthArtifact(req: EmitAuthArtifactRequest): Promise<void>;
  pollAuthSignal(req: PollAuthSignalRequest): Promise<PollAuthSignalResponse>;
  completeAuth(req: CompleteAuthRequest): Promise<void>;
  /**
   * Forward a chrome-extension action call from the running connector to the
   * gateway, which enqueues a chrome connector action run, waits for the
   * paired Owletto extension to claim/complete, and returns the observation
   * — multi-replica safe because the wait is Postgres-mediated.
   */
  dispatchChromeAction(req: DispatchChromeActionRequest): Promise<Record<string, unknown>>;
  /**
   * Post a device-side automation exit report and read the server's decision.
   * `status: "resume"` means the run is still claimed and the caller should
   * re-spawn with the returned nudge.
   */
  completeAutomation(
    runId: number,
    req: CompleteAutomationRequest
  ): Promise<CompleteAutomationResponse>;
  completeDeviceChat(
    runId: number,
    req: CompleteDeviceChatRequest
  ): Promise<CompleteDeviceChatResponse>;
  /**
   * Report an agent turn. Fleet-only, so it posts to the shared worker route
   * rather than the device-scoped `/me/runs/...` family.
   */
  completeAgentTurn(req: CompleteAgentTurnRequest): Promise<CompleteAgentTurnResponse>;
  /** MCP endpoint + bearer the automation arm wires into the spawned CLI. */
  readonly mcpWiring?: { url: string; bearer?: string };
  /** Terminal ACP transcript upload authenticated by the per-run agent token. */
  writeAutomationTranscript(
    runId: number,
    bearer: string,
    terminalStatus: 'completed' | 'failed' | 'timeout' | 'cancelled',
    snapshotJsonl: string
  ): Promise<void>;
}

// ============================================
// Types
// ============================================

/**
 * The worker⇄gateway wire payloads are the SINGLE SOURCE in
 * `@lobu/core/contracts/worker/protocol` (TypeBox). Re-exported here so this
 * module's public surface is unchanged for importers, while the server annotates
 * its request-body reads with the same shapes from that file.
 */
export type {
  CompleteActionRequest,
  CompleteAgentTurnRequest,
  CompleteAgentTurnResponse,
  CompleteAuthRequest,
  CompleteAutomationRequest,
  CompleteAutomationResponse,
  CompleteDeviceChatRequest,
  CompleteDeviceChatResponse,
  CompleteEmbeddingsRequest,
  CompleteRequest,
  ContentItem,
  DispatchChromeActionRequest,
  DispatchChromeActionResponse,
  EmbedEvent,
  EmitAuthArtifactRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  OAuthCredentials,
  PollAuthSignalRequest,
  PollAuthSignalResponse,
  PollResponse,
  StreamBatch,
} from "@lobu/core/contracts/worker/protocol";
import type {
  CompleteActionRequest,
  CompleteAgentTurnRequest,
  CompleteAgentTurnResponse,
  CompleteAuthRequest,
  CompleteAutomationRequest,
  CompleteAutomationResponse,
  CompleteDeviceChatRequest,
  CompleteDeviceChatResponse,
  CompleteEmbeddingsRequest,
  CompleteRequest,
  DispatchChromeActionRequest,
  DispatchChromeActionResponse,
  EmbedEvent,
  EmitAuthArtifactRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  PollAuthSignalRequest,
  PollAuthSignalResponse,
  PollResponse,
  StreamBatch,
} from "@lobu/core/contracts/worker/protocol";
import type { AgentKind } from "@lobu/core/contracts/worker/device-automation";
import { resolveRunnableAgentKinds } from "./agent-binaries.js";

/** Capability strings the worker advertises, keyed by name (e.g. `browser.debugger`). */
export type WorkerCapabilities = Record<string, boolean>;

export interface WorkerAdvertisementSnapshot {
  capabilities: WorkerCapabilities;
  manifests: unknown[];
  generation: number;
}

export interface WorkerAdvertisementProvider {
  snapshot(): WorkerAdvertisementSnapshot;
}

export class MutableWorkerAdvertisementProvider implements WorkerAdvertisementProvider {
  private current: WorkerAdvertisementSnapshot;

  constructor(snapshot: Omit<WorkerAdvertisementSnapshot, 'generation'> & { generation?: number }) {
    this.current = {
      capabilities: { ...snapshot.capabilities },
      manifests: [...snapshot.manifests],
      generation: snapshot.generation ?? 0,
    };
  }

  snapshot(): WorkerAdvertisementSnapshot {
    return {
      capabilities: { ...this.current.capabilities },
      manifests: [...this.current.manifests],
      generation: this.current.generation,
    };
  }

  update(snapshot: Omit<WorkerAdvertisementSnapshot, 'generation'> & { generation: number }): void {
    if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < this.current.generation) {
      throw new Error('worker advertisement generation must be a monotonic safe integer');
    }
    const next = {
      capabilities: { ...snapshot.capabilities },
      manifests: [...snapshot.manifests],
      generation: snapshot.generation,
    };
    if (snapshot.generation === this.current.generation) {
      if (snapshotFingerprint(next) !== snapshotFingerprint(this.current)) {
        throw new Error('worker advertisement generation must increase for a changed snapshot');
      }
      return;
    }
    this.current = next;
  }
}

function snapshotFingerprint(snapshot: WorkerAdvertisementSnapshot): string {
  return JSON.stringify(snapshot, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });
}

/** HTTP error carrying the status code for retry and terminal-conflict policy. */
export class WorkerHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    body: string
  ) {
    super(`${path} failed: ${status} ${body.slice(0, 500)}`);
    this.name = 'WorkerHttpError';
  }
}

/**
 * A 2xx body we could not read as a completion decision. The server answered,
 * so re-sending would only mangle the same body — non-retriable.
 */
export class WorkerDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerDecodeError';
  }
}

/** How long a local CLI discovery sweep is reused before re-running. */
const AGENT_KIND_DISCOVERY_TTL_MS = 60_000;

/**
 * Worker API Client
 */
export class WorkerClient implements ExecutorClient {
  private apiUrl: string;
  private workerId: string;
  private capabilities: WorkerCapabilities;
  private authToken?: string;
  private version: string;
  private platform?: string;
  private label?: string;
  private manifests: unknown[] = [];
  private binaryOverrides?: Partial<Record<AgentKind, string>>;
  private fixedAgentKinds?: AgentKind[];
  private advertisementProvider?: WorkerAdvertisementProvider;
  private agentKindsCache: { kinds: AgentKind[]; at: number } | null = null;
  private backendCapacity: Record<string, number>;

  constructor(config: {
    apiUrl: string;
    workerId: string;
    authToken?: string;
    capabilities: WorkerCapabilities;
    version?: string;
    /** Host platform for server-side device registration and capability authorization. */
    platform?: string;
    /** Human-readable device name for the Devices page. */
    label?: string;
    /** Device-manifest connector definitions to register on each poll. */
    manifests?: unknown[];
    /** Executor binary overrides, so advertised kinds match what the arm spawns. */
    binaryOverrides?: Partial<Record<AgentKind, string>>;
    /** Exact session workers advertise only the one CLI they can receive. */
    agentKinds?: AgentKind[];
    /** Mutable device capability/manifest snapshot, updated by the native bridge. */
    advertisementProvider?: WorkerAdvertisementProvider;
    /** Static readiness/capacity per execution backend. */
    backendCapacity?: Record<string, number>;
  }) {
    this.apiUrl = trimTrailingSlashes(config.apiUrl);
    this.workerId = config.workerId;
    this.capabilities = config.capabilities;
    this.authToken = config.authToken?.trim() || undefined;
    this.version = config.version ?? '1.0.0';
    this.platform = config.platform?.trim() || undefined;
    this.label = config.label?.trim() || undefined;
    this.manifests = config.manifests ?? [];
    this.binaryOverrides = config.binaryOverrides;
    this.fixedAgentKinds = config.agentKinds;
    this.advertisementProvider = config.advertisementProvider;
    this.backendCapacity = { ...(config.backendCapacity ?? {}) };
  }

  /**
   * Agent kinds this machine can spawn, re-discovered at most every
   * `AGENT_KIND_DISCOVERY_TTL_MS`. Installing a CLI mid-session must start
   * attracting runs without a daemon restart, but a filesystem sweep on every
   * poll (default 10s) buys nothing.
   */
  private runnableAgentKinds(): AgentKind[] {
    if (this.fixedAgentKinds) return this.fixedAgentKinds;
    const now = Date.now();
    if (this.agentKindsCache && now - this.agentKindsCache.at < AGENT_KIND_DISCOVERY_TTL_MS) {
      return this.agentKindsCache.kinds;
    }
    const kinds = resolveRunnableAgentKinds(this.binaryOverrides);
    this.agentKindsCache = { kinds, at: now };
    return kinds;
  }

  /**
   * Capabilities this poll advertises. On the headless platform the daemon adds
   * `automations.execute` itself: the gateway hands `run_type='automation'` runs
   * only to devices advertising it, so the string is the build signal that keeps
   * an older daemon — one whose executor mishandles the automation lane — from
   * claiming and wedging a run. Whether this host can actually launch the
   * Automation's CLI is a separate gate: the `agent_kinds` discovered below.
   */
  private advertisedCapabilities(): WorkerCapabilities {
    if (this.platform !== 'headless') return this.capabilities;
    return { ...this.capabilities, 'automations.execute': true };
  }

  private authHeaders(): Record<string, string> {
    return this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {};
  }

  replaceAuthToken(authToken: string): void {
    this.authToken = authToken;
  }

  private async post<B = unknown>(path: string, body: B): Promise<Response> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const responseText = await response.text();
      const detail = `${response.statusText} ${responseText}`.trim();
      throw new WorkerHttpError(response.status, path, detail);
    }
    return response;
  }

  private async requestJson<T, B = unknown>(path: string, body: B): Promise<T> {
    const response = await this.post(path, body);
    return response.json() as Promise<T>;
  }

  private async requestVoid<B = unknown>(path: string, body: B): Promise<void> {
    await this.post(path, body);
  }

  /**
   * Poll for available runs
   */
  async poll(capacityAvailable?: number): Promise<PollResponse> {
    const advertisement = this.advertisementProvider?.snapshot();
    const capabilities = advertisement
      ? { ...this.advertisedCapabilities(), ...advertisement.capabilities }
      : this.advertisedCapabilities();
    const manifests = advertisement?.manifests ?? this.manifests;
    return this.requestJson<PollResponse>('/api/workers/poll', {
      worker_id: this.workerId,
      capabilities,
      version: this.version,
      ...(capacityAvailable === undefined
        ? {}
        : { capacity_available: capacityAvailable }),
      ...(Object.keys(this.backendCapacity).length > 0
        ? { backend_capacity: this.backendCapacity }
        : {}),
      // app_version belongs to the device registration fields, so omit both for
      // fleet workers rather than sending empty values. A device worker also
      // advertises the agent kinds its automation arm can run.
      ...(this.platform
        ? {
            platform: this.platform,
            app_version: this.version,
            agent_kinds: this.runnableAgentKinds(),
          }
        : {}),
      ...(this.label ? { label: this.label } : {}),
      ...(this.advertisementProvider || manifests.length > 0
        ? { connector_manifests: manifests }
        : {}),
    });
  }

  /**
   * Send heartbeat for active run
   */
  async heartbeat(
    runId: number,
    progress?: {
      items_collected_so_far?: number;
      current_page?: number;
      elapsed_ms?: number;
    },
    agentSession?: NonNullable<HeartbeatRequest['agent_session']>,
    /**
     * An agent turn's reply so far. Rides the heartbeat because the turn
     * already beats to say it is alive, and this is that statement carrying
     * its evidence — see `HeartbeatRequestSchema.turn_delta`.
     */
    turnDelta?: NonNullable<HeartbeatRequest['turn_delta']>
  ): Promise<HeartbeatResponse> {
    return this.requestJson<HeartbeatResponse>('/api/workers/heartbeat', {
      run_id: runId,
      worker_id: this.workerId,
      progress,
      ...(agentSession ? { agent_session: agentSession } : {}),
      ...(turnDelta ? { turn_delta: turnDelta } : {}),
    });
  }

  async writeAutomationTranscript(
    runId: number,
    bearer: string,
    terminalStatus: 'completed' | 'failed' | 'timeout' | 'cancelled',
    snapshotJsonl: string
  ): Promise<void> {
    const route = '/worker/transcript/snapshot';
    const response = await fetch(`${this.apiUrl}${route}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ runId, terminalStatus, snapshotJsonl }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new WorkerHttpError(
        response.status,
        route,
        `${response.statusText} ${body}`.trim()
      );
    }
  }

  /**
   * Stream content batch to backend
   */
  async stream(batch: StreamBatch): Promise<void> {
    await this.requestVoid('/api/workers/stream', batch);
  }

  /**
   * Report sync run completion
   */
  async complete(req: CompleteRequest): Promise<void> {
    await this.requestVoid('/api/workers/complete', req);
  }

  /**
   * Report action run completion
   */
  async completeAction(req: CompleteActionRequest): Promise<void> {
    await this.requestVoid(
      '/api/workers/complete-action',
      req
    );
  }

  /**
   * Fetch events needing embeddings
   */
  async fetchEventsForEmbedding(eventIds: number[]): Promise<EmbedEvent[]> {
    const result = await this.requestJson<{ events: EmbedEvent[] }>('/api/workers/fetch-events', {
      event_ids: eventIds,
    });
    return result.events;
  }

  /**
   * Submit generated embeddings
   */
  async completeEmbeddings(req: CompleteEmbeddingsRequest): Promise<void> {
    await this.requestVoid(
      '/api/workers/complete-embeddings',
      req
    );
  }

  /**
   * Emit an auth artifact (QR, redirect URL, prompt) for the UI to render.
   */
  async emitAuthArtifact(req: EmitAuthArtifactRequest): Promise<void> {
    await this.requestVoid(
      '/api/workers/emit-auth-artifact',
      req
    );
  }

  /**
   * Poll for a signal sent by the UI (OAuth callback, form submit, cancel).
   */
  async pollAuthSignal(req: PollAuthSignalRequest): Promise<PollAuthSignalResponse> {
    return this.requestJson<PollAuthSignalResponse>(
      '/api/workers/poll-auth-signal',
      req
    );
  }

  /**
   * Report auth run completion — writes credentials + metadata to auth_profiles.
   */
  async completeAuth(req: CompleteAuthRequest): Promise<void> {
    await this.requestVoid('/api/workers/complete-auth', req);
  }

  /**
   * Forward a chrome connector action call to the gateway. Blocks until the
   * paired Owletto extension completes the run or the gateway-side budget
   * times out. Throws on failure/timeout with the gateway's error message.
   */
  async dispatchChromeAction(req: DispatchChromeActionRequest): Promise<Record<string, unknown>> {
    const result = await this.requestJson<DispatchChromeActionResponse>(
      '/api/workers/dispatch-chrome-action',
      req
    );
    if (result.status === 'completed') {
      return result.output ?? {};
    }
    throw new Error(
      result.error_message ??
        `Chrome action '${req.action_key}' ${result.status === 'timeout' ? 'timed out' : 'failed'}`
    );
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiUrl}/api/health`, {
        headers: this.authHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Device-side EXIT REPORT for an automation run. Posts the process exit
   * metadata and returns the server's decision; see
   * `interpretCompleteAutomationResponse` for how a 2xx body is read without
   * inventing an outcome.
   */
  async completeAutomation(
    runId: number,
    req: CompleteAutomationRequest
  ): Promise<CompleteAutomationResponse> {
    const path = `/api/workers/me/runs/${runId}/complete-automation`;
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(req),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new WorkerHttpError(response.status, path, text);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WorkerDecodeError(
        'complete-automation returned a 2xx body that is not JSON'
      );
    }
    return interpretCompleteAutomationResponse(body);
  }

  async completeAgentTurn(req: CompleteAgentTurnRequest): Promise<CompleteAgentTurnResponse> {
    return this.requestJson<CompleteAgentTurnResponse>('/api/workers/complete-agent-turn', req);
  }

  async completeDeviceChat(
    runId: number,
    req: CompleteDeviceChatRequest
  ): Promise<CompleteDeviceChatResponse> {
    return this.requestJson<CompleteDeviceChatResponse>(
      `/api/workers/me/runs/${runId}/complete-chat`,
      req
    );
  }

  get mcpWiring(): { url: string; bearer?: string } | undefined {
    if (!this.authToken) return undefined;
    return { url: `${this.apiUrl}/mcp`, bearer: this.authToken };
  }

  get id(): string {
    return this.workerId;
  }
}

/**
 * A 2xx body from `complete-automation`, read without inventing an outcome.
 * Anything not recognised throws `WorkerDecodeError` — the server answered, so
 * the caller must not re-send and must not report a fabricated outcome.
 */
export function interpretCompleteAutomationResponse(
  body: unknown
): CompleteAutomationResponse {
  if (
    body != null &&
    typeof body === 'object' &&
    typeof (body as Record<string, unknown>).status === 'string'
  ) {
    return body as CompleteAutomationResponse;
  }
  throw new WorkerDecodeError(
    'complete-automation returned an unrecognised 2xx body'
  );
}
