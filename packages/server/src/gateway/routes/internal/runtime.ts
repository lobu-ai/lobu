import { createLogger } from "@lobu/core";
import { Hono } from "hono";
import { resolveRuntimeCredentials } from "../../runtime/credentials.js";
import { getGatewayRuntimeProvider } from "../../runtime/index.js";
import { sanitizeNixPackages } from "../../runtime/packages.js";
import { errorStatus, resolveWorkspacePath } from "../../runtime/workspace.js";
import { resolveLeasedExecEnv } from "../../agent-tooling/exec-credentials.js";
import { type PackageProvisionResult, RuntimeInfrastructureError } from "../../runtime/types.js";
import { errorResponse, getVerifiedWorker } from "../shared/helpers.js";
import { authenticateWorker } from "./middleware.js";
import type { WorkerContext } from "./types.js";
import { captureSideEffect } from "./capture-mode.js";

const logger = createLogger("internal-runtime");

type ExecRequest = {
  command?: unknown;
  cwd?: unknown;
  workspaceDir?: unknown;
  timeoutMs?: unknown;
  // NOTE: no `env` here. Connector-contributed credentials are minted
  // GATEWAY-side per command (`resolveLeasedExecEnv`) and the worker has no say
  // in them, for the same reason the two lists below are signed claims: the
  // worker is the sandbox-ee. A body value was previously passed through
  // verbatim, so a compromised isolate could have pinned `GH_TOKEN` to a token
  // it controlled and had the sandbox act as that identity. The isolate lane's
  // own exec client never sent the field (`RuntimeExecRequest` is
  // `{ command, timeoutMs }`), so nothing legitimate is losing a capability.
  //
  // NOTE: no `allowedDomains` here — the egress allowlist is NOT trusted from the
  // request body (the worker is the sandbox-ee). It's read from the signed worker
  // token claim below, same as `runtimeProviderId`.
  //
  // NOTE: no `nixPackages` here either, for exactly the same reason. Every entry
  // becomes an argument to a `nix profile install` command line inside the
  // sandbox; a worker that could name its own package set could install
  // arbitrary nixpkgs attributes — and widen its own toolset past what its org
  // configured. The list is read from the signed claim below and re-validated.
};

/**
 * Generic worker-bash execution route. One route for every runtime provider:
 * the provider is chosen from the signed worker-token claim (never the request
 * body), credentials are resolved gateway-side from the org vault, and the
 * provider runs the command. Replaces the per-provider `/internal/<x>/exec`
 * routes — adding a provider needs no route change.
 */
export function createRuntimeRoutes(): Hono<WorkerContext> {
  const router = new Hono<WorkerContext>();

  router.post("/internal/runtime/exec", authenticateWorker, async (c) => {
    try {
      const worker = getVerifiedWorker(c);
      const provider = getGatewayRuntimeProvider(worker.runtimeProviderId);
      if (!provider) {
        return errorResponse(
          c,
          "No runtime provider configured for this agent",
          404
        );
      }
      if (!worker.agentId) {
        return errorResponse(c, "Token missing agent context", 403);
      }

      const body = (await c.req.json().catch(() => null)) as ExecRequest | null;
      if (!body || typeof body.command !== "string" || !body.command.trim()) {
        return errorResponse(c, "Missing command", 400);
      }

      // The worker's exec client (generic-runtime-bash.ts) reads
      // `{ stdout, exitCode }` off a 2xx and treats a missing exitCode as the
      // command failing with exit 1 — so the captured body must speak that
      // contract, or every captured command reads as a silent failure and the
      // replay measures the agent's retry loop instead of its intent.
      const captured = await captureSideEffect(
        c,
        "runtime.exec",
        { command: body.command },
        {
          captured: true,
          stdout:
            "lobu: capture run — this command was recorded but not executed (evaluation replay).\n",
          exitCode: 0,
        },
      );
      if (captured) return captured;

      let credentials = await resolveRuntimeCredentials(
        provider,
        worker.organizationId,
        worker.sandboxId
      );
      if (!credentials) {
        // No vault/system credential resolved. Provider self-auth (e.g. Vercel
        // via an ambient VERCEL_OIDC_TOKEN when Lobu itself runs on Vercel) is
        // the HOST realm — permissible ONLY for a sandbox-less resolution
        // (self-host / org default). A sandbox-bound miss must fail closed: a
        // conversation pinned to a specific sandbox that's been deleted or
        // misconfigured must NOT silently execute in the host realm under ambient
        // OIDC — that would break the one-conversation-one-realm pin contract.
        if (!worker.sandboxId && provider.canSelfAuth?.()) {
          credentials = { values: {}, source: "system" };
        } else {
          return errorResponse(
            c,
            "Runtime provider credentials unavailable",
            424
          );
        }
      }

      const workspaceDir = resolveWorkspacePath(
        worker.agentId,
        worker.conversationId,
        body.workspaceDir
      );

      const timeoutMs =
        typeof body.timeoutMs === "number" &&
        Number.isFinite(body.timeoutMs) &&
        body.timeoutMs > 0
          ? Math.floor(body.timeoutMs)
          : undefined;

      // Authoritative package set from the SIGNED token, never the body, and
      // re-validated through the shared nix sanitizer before it can reach any
      // command line. Sanitizing here (not only in the provider) keeps the one
      // check on the path EVERY provider inherits.
      const nixPackages = sanitizeNixPackages(worker.nixPackages);

      // The org's connector-contributed leases, minted for THIS command.
      //
      // Caught HERE as well as inside the resolver: the contract is "a
      // credential lookup never fails the command", and a contract that lives
      // only in the callee is one refactor away from being lost. An
      // unauthenticated `gh` tells the user something they can act on; a 500
      // from the shell tells them nothing and looks like the sandbox is down.
      //
      // No org on the token → nothing to mint: connector contributions are
      // resolved per organization, so an unscoped token has no connections to
      // read. Skipped rather than defaulted, because guessing a tenant here is
      // how a credential crosses one.
      let env: Record<string, string> = {};
      try {
        env = worker.organizationId
          ? await resolveLeasedExecEnv({
              agentId: worker.agentId,
              organizationId: worker.organizationId,
              conversationId: worker.conversationId,
              runId: worker.runId,
            })
          : {};
      } catch (error) {
        logger.warn(
          {
            agent_id: worker.agentId,
            organization_id: worker.organizationId,
            err: error instanceof Error ? error.message : String(error),
          },
          "Connector credential resolution failed; running the command without those credentials"
        );
      }

      const execContext = {
        organizationId: worker.organizationId,
        agentId: worker.agentId,
        conversationId: worker.conversationId,
        workspaceDir,
        credentials,
        command: body.command,
        cwd: body.cwd,
        env,
        timeoutMs,
        // Authoritative egress allow/deny lists from the SIGNED token, never
        // the body — a compromised worker cannot widen its own sandbox policy.
        allowedDomains: worker.allowedDomains,
        deniedDomains: worker.deniedDomains,
        nixPackages,
      };

      // Provision BEFORE the command runs, and only when there is something to
      // provision. The provider applies the sandbox network policy (including
      // the nix substituter hosts) as part of this call — the install would
      // otherwise hang against a deny-by-default sandbox.
      //
      // A provider without `ensurePackages` cannot provision: that is the
      // honest-degradation path. We log it and run the command anyway rather
      // than failing the turn or pretending the tool is present.
      let packages: PackageProvisionResult | undefined;
      if (nixPackages.length > 0) {
        if (provider.ensurePackages) {
          packages = await provider.ensurePackages(execContext);
        } else {
          logger.warn(
            { provider: provider.id, packages: nixPackages },
            "Runtime provider cannot provision packages — the contributed CLIs will be absent"
          );
          packages = {
            installed: [],
            failed: nixPackages,
            cached: false,
            error: `Provider ${provider.id} does not support package provisioning`,
          };
        }
      }

      // Providers decide whether to expose their package profile based on what
      // provisioning actually achieved — see `RuntimeExecContext.provisioned`.
      const result = await provider.exec({ ...execContext, provisioned: packages });

      return c.json({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        sandbox: packages ? { ...result.meta, packages } : result.meta,
      });
    } catch (error) {
      // Reported as itself, with the upstream status it carries, rather than
      // inferred from the message text. See RuntimeInfrastructureError.
      if (error instanceof RuntimeInfrastructureError) {
        logger.error(
          {
            err: error.message,
            status: error.status,
            retryable: error.retryable,
            outcome: error.outcome,
          },
          "Runtime infrastructure failure"
        );
        return c.json(
          {
            error: error.message,
            kind: "infrastructure" as const,
            retryable: error.retryable,
            outcome: error.outcome,
          },
          error.status === 429 ? 429 : 503
        );
      }
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Runtime exec failed"
      );
      return errorResponse(
        c,
        error instanceof Error ? error.message : "Runtime exec failed",
        error instanceof Error ? errorStatus(error) : 500
      );
    }
  });

  return router;
}
