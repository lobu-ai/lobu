/**
 * Gateway-side runtime-provider abstraction.
 *
 * A runtime provider executes a worker's bash command on some compute target
 * (a persistent/ephemeral sandbox, a remote host). The generic
 * `/internal/runtime/exec` route handles auth, provider selection (from the
 * signed worker token), credential resolution, and workspace validation, then
 * hands a fully-resolved {@link RuntimeExecContext} to `provider.exec`. The
 * provider owns only the SDK-specific bits (sandbox naming, network policy,
 * get-or-create, run). Adding a provider is a declaration — no new route.
 */

/** One credential field a provider needs (e.g. Vercel: token, teamId, projectId). */
export interface RuntimeCredentialField {
  /**
   * Logical key. The per-sandbox vault row is `sandbox:<sandboxId>:<key>`;
   * the value is surfaced to the provider as `credentials.values[key]`.
   */
  key: string;
  /** Deployment-wide system-env fallback var (e.g. "VERCEL_TOKEN"). */
  systemEnvVar: string;
  required: boolean;
  /**
   * Whether this field is a secret. Secret fields (e.g. an API token) are never
   * returned to the UI. Non-secret fields (`false` — e.g. teamId/projectId, which
   * are plain identifiers) may be surfaced for display. Defaults to secret.
   */
  secret?: boolean;
  /** Human label for the field in credential-entry UIs. */
  label?: string;
}

export interface ResolvedRuntimeCredentials {
  /** key → plaintext value, resolved gateway-side; never returned to the worker. */
  values: Record<string, string>;
  /** "byo" when any value came from the org vault, else "system". */
  source: "byo" | "system";
}

/** Everything the route resolves before handing off to a provider. */
export interface RuntimeExecContext {
  organizationId?: string;
  agentId: string;
  conversationId: string;
  /** Local workspace dir, already validated against the token's agent+conversation. */
  workspaceDir: string;
  credentials: ResolvedRuntimeCredentials;
  command: string;
  /** Raw requested cwd from the worker; the provider maps it onto its remote root. */
  cwd: unknown;
  /**
   * Connector-contributed credentials for this command, minted gateway-side
   * (`resolveLeasedExecEnv`). Never sourced from the worker's request body:
   * the worker is the sandbox-ee, so it must not name its own credentials.
   */
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Raw allowed-domains list from the worker; the provider derives its policy. */
  allowedDomains: unknown;
  /** Raw denied-domains list (signed claim); providers subtract it from the allow policy. */
  deniedDomains: unknown;
  /**
   * Nix package names already validated through `nixPackageAttrRef` by the
   * route. Providers may put these on a command line as-is; anything the
   * validator rejected never reaches here.
   */
  nixPackages?: string[];
  /**
   * Result of this request's {@link GatewayRuntimeProvider.ensurePackages}, set
   * by the route before `exec`. Absent when there was nothing to provision or
   * the provider cannot. Providers use it to decide whether to expose their
   * package profile: after a FAILED install the profile may still hold an older
   * set, and silently putting that on PATH would contradict the `failed` list we
   * just reported to the worker.
   */
  provisioned?: PackageProvisionResult;
}

/** Outcome of one `ensurePackages` call, surfaced to the worker as exec meta. */
export interface PackageProvisionResult {
  /** Package names that are on PATH after this call (installed now or already present). */
  installed: string[];
  /** Package names provisioning failed for. The tool is absent; the turn still runs. */
  failed: string[];
  /** True when the marker matched and nothing had to be installed. */
  cached: boolean;
  /** Why provisioning degraded, when it did. Logged and surfaced, never thrown. */
  error?: string;
}

export interface RuntimeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Provider-specific diagnostics surfaced to the worker as `sandbox`. */
  meta?: Record<string, unknown>;
}

export interface GatewayRuntimeProvider {
  /** Stable id; matches the worker-side provider id and the token claim. */
  readonly id: string;
  readonly credentialFields: RuntimeCredentialField[];
  /**
   * Optional: returns true when the provider can authenticate without an
   * explicit vault/system credential (e.g. Vercel via an ambient
   * `VERCEL_OIDC_TOKEN`). When true and no credential resolves, the route
   * proceeds with empty credentials and lets the provider SDK self-auth;
   * when absent/false, a missing credential fails closed.
   */
  canSelfAuth?(): boolean;
  /**
   * Optional: provision `ctx.nixPackages` into the compute target so the
   * contributed CLIs are on PATH for the subsequent {@link exec}. Called by the
   * generic route before `exec`, AFTER the network policy is in force (the nix
   * substituter hosts must be reachable or the install hangs on deny-by-default).
   *
   * ABSENT means "this provider cannot provision" — the honest-degradation path:
   * the route logs it and the tool is simply missing, rather than the turn
   * failing or the gateway pretending the package is there. Implementations must
   * likewise RESOLVE with `failed` populated rather than throwing; a package that
   * didn't install must never fail the whole turn.
   *
   * Idempotence is the implementation's job and must be sandbox-side state (a
   * marker file), never gateway memory — another replica handles the next
   * message and must reach the same conclusion without reading this pod.
   */
  ensurePackages?(ctx: RuntimeExecContext): Promise<PackageProvisionResult>;
  exec(ctx: RuntimeExecContext): Promise<RuntimeExecResult>;
}

/**
 * Whether the agent's command actually ran. Independent of `retryable`: the two
 * answer different questions, and conflating them misleads in both directions.
 * A 403 while provisioning is not retryable but definitely never ran, while a
 * throttled log fetch may have run and completed.
 */
export type RuntimeExecutionOutcome =
  /** Failed before dispatch. The command did not run; no side effects. */
  | "not_started"
  /** Dispatch itself failed. Unlikely to have run, but not provable. */
  | "unknown"
  /** The command ran; only retrieving its output failed. */
  | "completed";

/**
 * A failure of the RUNTIME, not of the agent's command.
 *
 * The distinction is load-bearing. A provider rate limit, an auth rejection or a
 * network fault used to reach the agent as `exitCode 1` with the provider's
 * message written into the command's own stdout — indistinguishable from a
 * command that genuinely failed. Observed in production: a bare
 * `echo hello > /tmp/x` reported "Status code 429 is not ok", so the agent
 * assumed its shell syntax was wrong, rewrote a correct command, and retried
 * into an already-throttled endpoint.
 *
 * Carrying the upstream status means the route no longer has to infer one by
 * string-matching the message, and the worker can tell the agent "the sandbox
 * is unavailable" instead of "your command failed".
 */
export class RuntimeInfrastructureError extends Error {
  /** Upstream HTTP status when the provider reported one. */
  readonly status?: number;
  /** True when retrying the same command later could plausibly succeed. */
  readonly retryable: boolean;
  /** What is known about whether the command executed. */
  readonly outcome: RuntimeExecutionOutcome;

  constructor(
    message: string,
    options?: {
      status?: number;
      retryable?: boolean;
      outcome?: RuntimeExecutionOutcome;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "RuntimeInfrastructureError";
    this.status = options?.status;
    // A rate limit or a 5xx is worth retrying; a 4xx auth/config error is not.
    this.retryable =
      options?.retryable ??
      (options?.status === 429 || (options?.status ?? 0) >= 500);
    // Default to the safe answer: only claim a command did not run when the
    // caller says so. Advising a retry for something that may have taken effect
    // is the costlier mistake.
    this.outcome = options?.outcome ?? "unknown";
  }
}
