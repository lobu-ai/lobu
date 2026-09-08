import { randomUUID } from "node:crypto";
import { createLogger } from "../logger";
import { decrypt, encrypt } from "../utils/encryption";

const logger = createLogger("worker-auth");

/**
 * Fast envelope check for the AES-GCM worker-token wire format.
 *
 * This does not authenticate or decrypt the token. Call {@link verifyWorkerToken}
 * before trusting any claim.
 */
export function looksLikeWorkerToken(token: string): boolean {
  return /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i.test(token);
}

/**
 * Worker authentication using encrypted conversation ID.
 * Token format: encrypted(JSON payload of thread metadata).
 */

export interface WorkerTokenData {
  /**
   * Separates worker-facing bearers, credentials exposed to agent subprocesses
   * through HTTP_PROXY, and the server-only embedded MCP credential.
   *
   * Absent means "worker" for tokens minted before this discriminator existed;
   * `gateway-mcp` is never returned to or minted inside an agent process.
   */
  tokenKind?: "worker" | "egress-proxy" | "gateway-mcp";
  userId: string;
  conversationId: string;
  channelId: string;
  teamId?: string;
  agentId?: string;
  /**
   * Owning organization of the agent the token was minted for. Used by the
   * HTTP proxy to scope per-tenant caches (e.g. egress-judge verdict cache)
   * so org A's decisions can never satisfy org B's requests. Optional only
   * because some internal/preflight call sites mint tokens before the owning
   * org has been resolved; production agent runs always set it.
   */
  organizationId?: string;
  connectionId?: string;
  /**
   * Full Chat SDK thread id selected by the gateway when the turn is queued.
   * Signed because worker response bodies are untrusted routing input.
   */
  responseThreadId?: string;
  deploymentName: string;
  timestamp: number;
  platform?: string;
  /**
   * Headless run origin (`platformMetadata.source`, e.g. automation-run /
   * scheduled-job / connector-repair / internal). Carried so interaction
   * cards emitted from a headless turn can be stamped headless and exempted
   * from the SSE-owner gate — no browser SSE connection exists on any pod for
   * a headless run, so an owner-gated card would dead-letter. Absent for
   * interactive (browser-driven) runs.
   */
  source?: string;
  /**
   * Side-effect mode for this run, derived server-side from `runs.run_type`
   * when the session was authorized. `capture` marks an eval run: mutating
   * work is recorded and NOT performed. Absent means live — see the rollout
   * note in gateway/orchestration/worker-token-claims.ts. Signed, so a worker
   * cannot promote itself to live.
   */
  executionMode?: "live" | "capture";
  /**
   * The parent Automation `runs.id` for this one-shot session. NOT
   * {@link runId} — an Automation execution writes a parent row and a
   * per-turn chat_message row. A capture session records its suppressed side
   * effects onto this row and must carry it. A live session MAY carry it as
   * signed parent identity; today the mint sets it only for capture, so no
   * live consumer reads it yet.
   */
  automationRunId?: number;
  sessionKey?: string;
  traceId?: string;
  /** Unique token ID — enables targeted revocation. */
  jti?: string;
  /**
   * Optional `runs.id` this token is scoped to. Present only on per-job
   * tokens minted by the runs queue dispatcher at thread-message time;
   * the deployment-lifetime WORKER_TOKEN minted at spawn time does NOT
   * carry it. The snapshot route requires equality between this field
   * and the request body's `runId` so a worker bearing a same-(org,
   * agent, conv) token cannot POST under a different run's slot —
   * codex round 2, finding A on PR #865.
   */
  runId?: number;
  /**
   * Per-turn message id this token's work was dispatched for. Set alongside
   * {@link runId} by the runs-queue dispatcher (MessageConsumer.handleMessage),
   * which arms the turn-timeout marker with the SAME `messageId`. The token
   * refresh gate uses it to require a live marker for THIS turn specifically
   * (`deploymentName:messageId`), not merely any live turn on the deployment —
   * otherwise a still-valid token from a completed turn could refresh while a
   * later, unrelated turn on the same deployment is live. Long-lived deployment
   * tokens do NOT carry it.
   */
  messageId?: string;
  /**
   * Per-turn allowlist of internal admin tool NAMES this token may call.
   * Enforced exact-name at the execute gate (`tools/execute.ts`); absent for
   * every normal agent/turn, so a forged or normal token grants no admin
   * access. Nothing mints it today (the builder admin grant is gone); the
   * claim stays in the token contract for compatibility.
   */
  adminTools?: string[];
  /**
   * Lobu auth user authorized for {@link adminTools}. Chat turns keep the
   * platform principal in `userId`, so direct MCP auth must not reinterpret a
   * Slack/Telegram id as a `member.userId`. Present iff `adminTools` is present.
   */
  adminActorUserId?: string;
  /**
   * Selected runtime-provider id (e.g. "vercel"), resolved from the agent's
   * environment at token-mint time. The generic `/internal/runtime/exec` route
   * trusts THIS signed claim to pick the gateway-side provider — the worker
   * never names a provider over the wire, so a compromised worker cannot reach
   * a provider/credential its org didn't configure. Absent → the worker runs
   * its in-process just-bash backend (no remote runtime).
   */
  runtimeProviderId?: string;
  /**
   * The `sandboxes.id` whose vault credential backs {@link runtimeProviderId}
   * (rows `sandbox:<id>:<field>`). Absent → gateway resolves the provider
   * credential from system env only. Set together with `runtimeProviderId`.
   */
  sandboxId?: string;
  /**
   * Egress allowlist (the agent's resolved `networkConfig.allowedDomains`) for a
   * remote runtime sandbox. Carried as a SIGNED claim — set gateway-side at mint
   * from the agent's network config — because the generic `/internal/runtime/exec`
   * route must NOT trust a worker-supplied list: the worker is the sandbox-ee, so
   * a compromised one could send `["*"]` and get an allow-all sandbox, bypassing
   * egress policy. Absent/empty → the sandbox is `deny-all` (fail closed).
   */
  allowedDomains?: string[];
  /**
   * Egress denylist (the agent's `networkConfig.deniedDomains`) for a remote
   * runtime sandbox — signed for the same reason as {@link allowedDomains}.
   * Providers that cannot express exclusions must fail closed: drop any allow
   * entry the denylist covers rather than granting it.
   */
  deniedDomains?: string[];
  /**
   * Nix packages to provision inside a remote runtime sandbox (the agent's
   * resolved `nixConfig.packages` unioned with its connections' contributed
   * tooling). Signed for the same reason as {@link allowedDomains}: the worker
   * is the sandbox-ee, so a compromised one must not be able to name its own
   * package set — every entry here reaches a `nix profile install` command line.
   * The local (embedded) path wraps the worker spawn in `nix-shell` instead and
   * ignores this claim. Absent/empty → nothing is provisioned and a contributed
   * CLI is simply absent from PATH (honest degradation, never a silent success).
   */
  nixPackages?: string[];
}

export interface WorkerTokenOptions {
  channelId: string;
  teamId?: string;
  agentId?: string;
  organizationId?: string;
  connectionId?: string;
  /** Full trusted Chat SDK thread id. See WorkerTokenData.responseThreadId. */
  responseThreadId?: string;
  platform?: string;
  /** Headless run origin — see WorkerTokenData.source. */
  source?: string;
  /** Side-effect mode — see WorkerTokenData.executionMode. */
  executionMode?: "live" | "capture";
  /** Parent Automation run for this session — see WorkerTokenData.automationRunId. */
  automationRunId?: number;
  sessionKey?: string;
  traceId?: string;
  /**
   * Bind the token to a single `runs.id`. Set only by the runs-queue
   * dispatcher's per-job token mint (MessageConsumer.handleMessage on
   * the gateway side). Long-lived deployment tokens must NOT pass this
   * — they'd be wrong for subsequent runs. See WorkerTokenData.runId
   * for the consumption contract.
   */
  runId?: number;
  /**
   * Per-turn message id, set alongside `runId` by the runs-queue dispatcher.
   * Binds token refresh to this turn's own liveness marker. See
   * WorkerTokenData.messageId.
   */
  messageId?: string;
  /**
   * Admin-tool allowlist for this turn. See WorkerTokenData.adminTools.
   */
  adminTools?: string[];
  /** Lobu auth user bound to the admin-tools allowlist. */
  adminActorUserId?: string;
  /** Selected runtime provider id. See WorkerTokenData.runtimeProviderId. */
  runtimeProviderId?: string;
  /** Selected sandbox id backing the runtime credential. See WorkerTokenData.sandboxId. */
  sandboxId?: string;
  /** Resolved egress allowlist for a remote runtime sandbox. See WorkerTokenData.allowedDomains. */
  allowedDomains?: string[];
  /** Resolved egress denylist for a remote runtime sandbox. See WorkerTokenData.deniedDomains. */
  deniedDomains?: string[];
  /** Resolved nix package set for a remote runtime sandbox. See WorkerTokenData.nixPackages. */
  nixPackages?: string[];
}

function generateToken(
  userId: string,
  conversationId: string,
  deploymentName: string,
  options: WorkerTokenOptions,
  tokenKind: "worker" | "egress-proxy",
  jti = randomUUID()
): string {
  if (!options.channelId) {
    throw new Error("channelId is required for worker token generation");
  }

  const payload: WorkerTokenData = {
    tokenKind,
    userId,
    conversationId,
    channelId: options.channelId,
    teamId: options.teamId,
    agentId: options.agentId,
    organizationId: options.organizationId,
    connectionId: options.connectionId,
    responseThreadId: options.responseThreadId,
    deploymentName,
    timestamp: Date.now(),
    platform: options.platform,
    source: options.source,
    executionMode: options.executionMode,
    automationRunId: options.automationRunId,
    sessionKey: options.sessionKey,
    traceId: options.traceId,
    jti,
    runId: options.runId,
    messageId: options.messageId,
    adminTools: options.adminTools,
    adminActorUserId: options.adminActorUserId,
    runtimeProviderId: options.runtimeProviderId,
    sandboxId: options.sandboxId,
    allowedDomains: options.allowedDomains,
    deniedDomains: options.deniedDomains,
    nixPackages: options.nixPackages,
  };

  return encrypt(JSON.stringify(payload));
}

export function generateWorkerToken(
  userId: string,
  conversationId: string,
  deploymentName: string,
  options: WorkerTokenOptions
): string {
  return generateToken(
    userId,
    conversationId,
    deploymentName,
    options,
    "worker"
  );
}

/**
 * Mint deployment-lifetime worker and proxy credentials with one revocation
 * identity. Revoking the deployment token must also stop its egress.
 */
export function generateWorkerTokenPair(
  userId: string,
  conversationId: string,
  deploymentName: string,
  options: WorkerTokenOptions
): { workerToken: string; egressProxyToken: string } {
  const jti = randomUUID();
  return {
    workerToken: generateToken(
      userId,
      conversationId,
      deploymentName,
      options,
      "worker",
      jti
    ),
    egressProxyToken: generateToken(
      userId,
      conversationId,
      deploymentName,
      options,
      "egress-proxy",
      jti
    ),
  };
}

/**
 * Narrow a verified worker credential to the embedded MCP hop.
 *
 * The gateway derives this only for its internal upstream hop. For tool calls,
 * that happens after worker authentication and pre-tool policy. The derived
 * credential preserves the original token's timestamp, revocation id, and
 * identity claims, but worker-facing routes reject its distinct token kind.
 */
export function mintGatewayMcpToken(workerToken: string): string | null {
  const data = verifyWorkerToken(workerToken);
  if (!data) return null;
  return encrypt(
    JSON.stringify({
      ...data,
      tokenKind: "gateway-mcp" satisfies WorkerTokenData["tokenKind"],
    })
  );
}

function parsePositiveIntEnv(
  name: string,
  fallback: number,
  allowZero = false
): number {
  const raw = parseInt(process.env[name] ?? "", 10);
  if (Number.isNaN(raw)) return fallback;
  if (allowZero ? raw < 0 : raw <= 0) return fallback;
  return raw;
}

/**
 * Verify and decrypt a worker authentication token
 */
function verifyToken(
  token: string,
  expectedKind: "worker" | "egress-proxy" | "gateway-mcp"
): WorkerTokenData | null {
  try {
    const parsed: unknown = JSON.parse(decrypt(token));

    // Decrypted plaintext is attacker-influenced — `as` would coerce `null`,
    // an array, a string, or a number into `WorkerTokenData` and let
    // downstream consumers TypeError off undefined fields. Validate shape
    // before treating it as a payload.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logger.error("Worker token rejected: payload is not a plain object");
      return null;
    }
    const data = parsed as WorkerTokenData;

    const tokenKind = data.tokenKind ?? "worker";
    if (
      (tokenKind !== "worker" &&
        tokenKind !== "egress-proxy" &&
        tokenKind !== "gateway-mcp") ||
      tokenKind !== expectedKind
    ) {
      logger.error(`Token rejected: expected ${expectedKind} credential`);
      return null;
    }

    if (
      typeof data.conversationId !== "string" ||
      !data.conversationId ||
      typeof data.userId !== "string" ||
      !data.userId ||
      typeof data.deploymentName !== "string" ||
      !data.deploymentName ||
      typeof data.timestamp !== "number" ||
      !data.timestamp
    ) {
      logger.error(
        "Worker token rejected: missing or wrongly-typed required fields"
      );
      return null;
    }
    // `runId` is optional but must be a positive integer when present.
    // A forged token with `runId: "*"` (or NaN, or negative) would pass
    // the verification check and then defeat the snapshot route's
    // equality check below if downstream code compared loosely.
    if (data.runId !== undefined) {
      if (
        typeof data.runId !== "number" ||
        !Number.isInteger(data.runId) ||
        data.runId <= 0
      ) {
        logger.error("Worker token rejected: runId must be a positive integer");
        return null;
      }
    }
    // Same shape rule for `automationRunId` — it addresses the parent
    // Automation run row, so a non-integer must be rejected here rather than
    // reaching a query as a coerced value.
    if (data.automationRunId !== undefined) {
      if (
        typeof data.automationRunId !== "number" ||
        !Number.isInteger(data.automationRunId) ||
        data.automationRunId <= 0
      ) {
        logger.error(
          "Worker token rejected: automationRunId must be a positive integer"
        );
        return null;
      }
    }
    // `executionMode` decides whether the run may touch the outside world, and
    // every consumer tests it for equality with "capture". An unrecognised
    // value would therefore read as live and let an eval replay perform real
    // side effects, so an unknown mode is rejected rather than defaulted.
    if (
      data.executionMode !== undefined &&
      data.executionMode !== "live" &&
      data.executionMode !== "capture"
    ) {
      logger.error(
        "Worker token rejected: executionMode must be 'live' or 'capture'"
      );
      return null;
    }
    // A capture token must name the row that records suppressed effects. The
    // reverse is deliberately NOT enforced: a live token carrying a parent
    // Automation run id is a valid shape, so the two are checked in one
    // direction only.
    if (
      data.executionMode === "capture" &&
      data.automationRunId === undefined &&
      data.runId === undefined
    ) {
      logger.error(
        "Worker token rejected: executionMode 'capture' requires automationRunId or runId"
      );
      return null;
    }
    // `adminTools` is optional but must be a string[] when present — a forged
    // token with a non-array (or non-string elements) must be rejected, not
    // coerced, before the execute gate trusts it to allow internal tools.
    if (data.adminTools !== undefined) {
      if (
        !Array.isArray(data.adminTools) ||
        data.adminTools.length === 0 ||
        !data.adminTools.every((t) => typeof t === "string")
      ) {
        logger.error(
          "Worker token rejected: adminTools must be a non-empty string[]"
        );
        return null;
      }
    }
    // The admin-tools pair is inseparable: the allowlist limits WHAT may
    // run and the resolved auth subject says WHO authorized it. Accepting one
    // without the other either makes the allowlist unusable or tempts callers
    // to reinterpret the platform-scoped `userId` as an auth user again.
    if (
      (data.adminTools === undefined) !==
      (data.adminActorUserId === undefined)
    ) {
      logger.error(
        "Worker token rejected: adminTools and adminActorUserId must be set together"
      );
      return null;
    }
    if (
      data.adminActorUserId !== undefined &&
      (typeof data.adminActorUserId !== "string" || !data.adminActorUserId)
    ) {
      logger.error(
        "Worker token rejected: adminActorUserId must be a non-empty string"
      );
      return null;
    }
    // `runtimeProviderId` / `sandboxId` are optional but, when present, the
    // runtime route trusts them to pick a provider + vault credential. A forged
    // token with a non-string here must be rejected, not coerced.
    if (
      data.runtimeProviderId !== undefined &&
      typeof data.runtimeProviderId !== "string"
    ) {
      logger.error("Worker token rejected: runtimeProviderId must be a string");
      return null;
    }
    if (data.sandboxId !== undefined && typeof data.sandboxId !== "string") {
      logger.error("Worker token rejected: sandboxId must be a string");
      return null;
    }
    // `nixPackages` feeds a `nix profile install` command line in the remote
    // runtime provider. Reject a non-string[] here rather than coercing — the
    // provider validates each NAME through `nixPackageAttrRef`, but a non-array
    // (or a nested object) would defeat that per-element check entirely.
    if (data.nixPackages !== undefined) {
      if (
        !Array.isArray(data.nixPackages) ||
        !data.nixPackages.every((p) => typeof p === "string")
      ) {
        logger.error("Worker token rejected: nixPackages must be a string[]");
        return null;
      }
    }
    // Reject legacy tokens carrying the pre-rename `environmentId` claim (the
    // field was renamed to `sandboxId`). A token minted just before the
    // environments→sandboxes rename deploy still verifies structurally (the
    // extra JSON key would otherwise be ignored) but would mint/refresh with NO
    // sandbox binding — the runtime route then resolves system-env / OIDC creds
    // and a provider-pinned turn silently executes in the HOST realm. Fail
    // closed instead: rejection → queue retry re-resolves the pin fresh under
    // the new claim. Tokens have a ≤2h TTL, so this window is self-clearing.
    if ((data as { environmentId?: unknown }).environmentId !== undefined) {
      logger.error(
        "Worker token rejected: legacy `environmentId` claim (superseded by `sandboxId`) — re-resolve"
      );
      return null;
    }

    // Default TTL 2h (was 24h — a leaked token had no revocation path for a
    // full day). Override via WORKER_TOKEN_TTL_MS. Clock-skew tolerance via
    // WORKER_TOKEN_CLOCK_SKEW_MS. Tokens timestamped further in the future
    // than the skew are rejected too — otherwise forward drift would grant
    // an unbounded validity window.
    const ttl = parsePositiveIntEnv("WORKER_TOKEN_TTL_MS", 2 * 60 * 60 * 1000);
    const skewMs = parsePositiveIntEnv(
      "WORKER_TOKEN_CLOCK_SKEW_MS",
      30 * 1000,
      true
    );
    const age = Date.now() - data.timestamp;
    if (age > ttl + skewMs) {
      logger.error("Worker token rejected: expired");
      return null;
    }
    if (-age > skewMs) {
      logger.error("Worker token rejected: timestamp in the future");
      return null;
    }

    return data;
  } catch (error) {
    // Pino expects `(obj, msg)` for Error serialization. The previous
    // `(msg, error)` form fell through to message-only logging and rendered
    // the actual decryption / parse error as `{}`, hiding the real cause.
    logger.error(
      {
        err:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
      },
      "Error verifying token"
    );
    return null;
  }
}

export function verifyWorkerToken(token: string): WorkerTokenData | null {
  return verifyToken(token, "worker");
}

export function verifyEgressProxyToken(token: string): WorkerTokenData | null {
  return verifyToken(token, "egress-proxy");
}

export function verifyGatewayMcpToken(token: string): WorkerTokenData | null {
  return verifyToken(token, "gateway-mcp");
}
