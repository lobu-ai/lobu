import chalk from "chalk";
import open from "open";
import ora from "ora";
import {
  type Credentials,
  type OAuthClientInfo,
  clearCredentials,
  loadCredentials,
  resolveContext,
  saveCredentials,
} from "../internal/index.js";
import {
  bumpInterval,
  DEVICE_CODE_GRANT_TYPE,
  discoverOAuth,
  fetchUserInfo,
  type OAuthDiscovery,
  OAuthError,
  pollDeviceToken,
  type RegisteredClient,
  registerClient,
  revokeToken,
  startDeviceAuthorization,
} from "../internal/oauth.js";

interface LoginOptions {
  token?: string;
  context?: string;
  force?: boolean;
  /** Forwarded to RFC 7591 dynamic client registration as `software_version`. */
  cliVersion?: string;
  /** Suppress spinner output; bail out non-interactively if the server rejects polling. */
  quiet?: boolean;
  /**
   * Keep polling a browser device-code flow without a TTY when an external
   * process owns cancellation and the user's approval UI. Native apps use
   * this instead of pretending their piped subprocess is interactive.
   */
  waitForApproval?: boolean;
  /**
   * Headless email "user_claimed" login (auth.md): the server emails this
   * address a one-click approval link instead of showing a code, and we keep
   * polling without a TTY. Lets an agent log in on a user's behalf without a
   * pre-minted PAT. Requires the server to advertise `agent_auth.claim_email_endpoint`.
   */
  email?: string;
}

/**
 * Hard ceiling on the polling loop. RFC 8628 servers typically return
 * `expires_in: 600` (10 min), but if the server hands us a much longer
 * deadline we still don't want to hammer `/oauth/token` for an hour from
 * a backgrounded shell. 5 minutes matches the documented device-code
 * expiry and is generous for a human to scan a QR + approve.
 */
const POLL_HARD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * `lobu login` runs the OAuth 2.0 device-code grant against the issuer
 * advertised at `<apiUrl-origin>/.well-known/oauth-authorization-server`.
 * `--token <pat>` skips OAuth entirely for CI/CD.
 */
export async function loginCommand(options: LoginOptions): Promise<void> {
  const target = await resolveContext(options.context);

  const existing = await loadCredentials(target.name);
  if (existing && !options.force) {
    console.log(
      chalk.dim(
        `\n  Already logged in to ${target.name} as ${existing.email ?? existing.name ?? "user"}.`
      )
    );
    console.log(
      chalk.dim(
        "  Run `lobu logout` first, or use `--force` to re-authenticate.\n"
      )
    );
    return;
  }

  if (existing && options.force) {
    await revokeExisting(existing);
    await clearCredentials(target.name);
  }

  if (options.token) {
    await loginWithToken(target, options.token);
    return;
  }

  let discovery: OAuthDiscovery;
  try {
    discovery = await discoverOAuth(target.url);
  } catch (err) {
    const message =
      err instanceof OAuthError ? err.message : String((err as Error).message);
    console.log(chalk.red(`\n  ${message}`));
    console.log(
      chalk.dim(
        "  Confirm the context URL is correct: `lobu context current`.\n"
      )
    );
    process.exitCode = 1;
    return;
  }

  const { deviceAuthorizationEndpoint, registrationEndpoint } = discovery;
  if (
    !deviceAuthorizationEndpoint ||
    !registrationEndpoint ||
    !discovery.grantTypesSupported.includes(DEVICE_CODE_GRANT_TYPE)
  ) {
    console.log(
      chalk.red(
        `\n  ${discovery.issuer} does not advertise the device-code grant.`
      )
    );
    console.log(
      chalk.dim("  Use `--token <pat>` with a personal access token instead.\n")
    );
    process.exitCode = 1;
    return;
  }

  // For --email, fail before creating an OAuth client / device code on a server
  // that can't deliver the email claim anyway.
  if (options.email && !discovery.claimEmailEndpoint) {
    console.log(
      chalk.red(
        `\n  ${discovery.issuer} does not support email login (no agent_auth.claim_email_endpoint).`
      )
    );
    console.log(chalk.dim("  Use plain `lobu login` or `--token <pat>`.\n"));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.dim(`\n  Context: ${target.name}`));
  console.log(chalk.dim(`  Issuer:  ${discovery.issuer}`));

  const client = await tryOAuthStep(() =>
    registerClient(registrationEndpoint, options.cliVersion ?? "unknown")
  );
  if (!client) return;

  const authorization = await tryOAuthStep(() =>
    startDeviceAuthorization(deviceAuthorizationEndpoint, client)
  );
  if (!authorization) return;

  // Headless email "user_claimed" login (auth.md): instead of showing a code
  // for a human at this terminal, ask the server to email an approval link to
  // `--email`. Approval happens out of band, so we then poll regardless of TTY.
  const emailClaim = Boolean(options.email);
  if (emailClaim) {
    const verificationUrl =
      authorization.verificationUriComplete ?? authorization.verificationUri;
    // Support was already verified above, before client/device-code creation.
    // tryOAuthStep returns the callback's value or undefined on error;
    // sendEmailClaim resolves void, so return a truthy sentinel to distinguish
    // success from the error case (otherwise we'd bail before polling).
    const sent = await tryOAuthStep(async () => {
      await sendEmailClaim(
        discovery.claimEmailEndpoint as string,
        authorization.userCode,
        options.email as string
      );
      return true;
    });
    if (!sent) return;
    console.log(
      chalk.dim(
        `\n  Sent a confirmation link to ${chalk.white(options.email as string)}.`
      )
    );
    console.log(
      chalk.dim(`  Code: ${chalk.bold.white(authorization.userCode)}`)
    );
    console.log(chalk.dim(`  Fallback approval URL: ${verificationUrl}`));
    console.log(
      chalk.dim("  Waiting for the user to approve from their email...\n")
    );
  } else {
    const verificationUrl =
      authorization.verificationUriComplete ?? authorization.verificationUri;

    console.log(chalk.dim("\n  Open this URL to approve the login:"));
    console.log(chalk.cyan(`  ${verificationUrl}`));
    console.log(
      chalk.dim(`  Code: ${chalk.bold.white(authorization.userCode)}`)
    );
    if (
      authorization.verificationUriComplete &&
      authorization.verificationUriComplete !== authorization.verificationUri
    ) {
      console.log(chalk.dim(`  Or visit: ${authorization.verificationUri}\n`));
    } else {
      console.log();
    }

    // Refuse to hand a non-https URL (e.g. javascript:, data:, file:) to the
    // OS's `open` handler. A compromised/misconfigured discovery endpoint
    // could otherwise redirect the user's browser into running attacker code.
    let canOpen = false;
    try {
      canOpen = new URL(verificationUrl).protocol === "https:";
    } catch {
      canOpen = false;
    }
    if (canOpen) {
      try {
        await open(verificationUrl);
      } catch {
        // The URL is printed above; opening is best-effort.
      }
    }
  }

  // Both ends of the stdio pair must be a TTY for the device-code prompt to
  // make sense — a backgrounded shell or CI runner has neither stdin to
  // approve from nor stdout to spin on. Require both, plus the absence of
  // `--quiet`, before treating the call as interactive. Email-claim approval
  // and an explicit supervised wait are out of band, so they poll even without
  // a TTY. The supervisor is responsible for bounding/cancelling the child.
  const isInteractive =
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true &&
    !options.quiet;
  const spinner = isInteractive
    ? ora("Waiting for authorization...").start()
    : null;

  // Cap the wait at the server-advertised lifetime AND our local ceiling.
  // The local ceiling guards against a misconfigured issuer handing us an
  // hour-long deadline that a backgrounded shell would otherwise honour.
  const serverDeadline = Date.now() + authorization.expiresIn * 1000;
  const localDeadline = Date.now() + POLL_HARD_TIMEOUT_MS;
  const deadline = Math.min(serverDeadline, localDeadline);

  // If the user kills the spawning shell (SIGHUP) or any supervisor sends
  // SIGTERM, exit promptly instead of inheriting the orphaned poll loop.
  // The abortable sleep below wakes immediately when `signal` is set, so we
  // don't have to wait out the polling interval first.
  const abortBox: { signal: NodeJS.Signals | null; wake: (() => void) | null } =
    { signal: null, wake: null };
  const abort = (signal: NodeJS.Signals): void => {
    if (abortBox.signal === null) {
      abortBox.signal = signal;
      abortBox.wake?.();
    }
  };
  const onSIGHUP = () => abort("SIGHUP");
  const onSIGTERM = () => abort("SIGTERM");
  const onSIGINT = () => abort("SIGINT");
  process.on("SIGHUP", onSIGHUP);
  process.on("SIGTERM", onSIGTERM);
  process.on("SIGINT", onSIGINT);
  const detach = () => {
    process.off("SIGHUP", onSIGHUP);
    process.off("SIGTERM", onSIGTERM);
    process.off("SIGINT", onSIGINT);
  };

  let intervalSeconds = authorization.interval;

  try {
    while (Date.now() < deadline) {
      // Sleep at most until the deadline, and let signal handlers wake us
      // up so cancellation doesn't have to wait out the full polling
      // interval (which `slow_down` can balloon to >30s).
      const remainingMs = deadline - Date.now();
      const sleepMs = Math.min(
        intervalSeconds * 1000,
        Math.max(remainingMs, 0)
      );
      await abortableDelay(sleepMs, abortBox);

      if (abortBox.signal) {
        spinner?.fail(`Login cancelled (${abortBox.signal}).`);
        process.exitCode = 1;
        return;
      }
      if (Date.now() >= deadline) break;

      const result = await pollDeviceToken(
        discovery.tokenEndpoint,
        client,
        authorization.deviceCode
      );

      if (result.status === "pending") {
        // Ordinary non-interactive callers (CI, backgrounded shells) can't
        // approve a terminal device code, so a `pending` poll is the terminal
        // answer. Email claims and native apps with an explicit supervisor own
        // an out-of-band approval path and therefore keep polling without TTYs.
        if (!isInteractive && !emailClaim && !options.waitForApproval) {
          console.log(
            chalk.red("  Device-code login requires an interactive terminal.")
          );
          console.log(
            chalk.dim(
              "  Use `--token <pat>`, `--email <addr>`, or `--wait-for-approval` with an external supervisor.\n"
            )
          );
          process.exitCode = 1;
          return;
        }
        intervalSeconds = bumpInterval(intervalSeconds, result.bumpInterval);
        continue;
      }

      if (result.status === "error") {
        spinner?.fail(result.message);
        if (!spinner) console.log(chalk.red(`  ${result.message}`));
        console.log();
        process.exitCode = 1;
        return;
      }

      const tokens = result.tokens;
      let identity: { email?: string; name?: string; userId?: string } = {};
      if (discovery.userinfoEndpoint) {
        const info = await fetchUserInfo(
          discovery.userinfoEndpoint,
          tokens.accessToken
        );
        if (info) {
          identity = { email: info.email, name: info.name, userId: info.sub };
        }
      }

      const oauth: OAuthClientInfo = {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        tokenEndpoint: discovery.tokenEndpoint,
        revocationEndpoint: discovery.revocationEndpoint,
        userinfoEndpoint: discovery.userinfoEndpoint,
        // Record the audience the issuer bound this grant to (RFC 8707, echoed
        // on the token response). Refresh must replay it verbatim.
        ...(tokens.resource ? { resource: tokens.resource } : {}),
      };

      await saveCredentials(
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt:
            typeof tokens.expiresIn === "number"
              ? Date.now() + tokens.expiresIn * 1000
              : undefined,
          ...identity,
          oauth,
        },
        target.name
      );

      spinner?.succeed(`Logged in to ${target.name}.`);
      if (!spinner) console.log(chalk.green(`  Logged in to ${target.name}.`));
      console.log();
      return;
    }

    spinner?.fail("Login request expired. Run `lobu login` again.");
    if (!spinner) console.log(chalk.red("  Login request expired."));
    console.log();
    process.exitCode = 1;
  } finally {
    detach();
  }
}

/**
 * POST the device `user_code` + target email to the auth.md claim endpoint so
 * the server emails the user a one-click approval link. The endpoint is opaque
 * (202) about whether the address has an account; only a real 4xx/5xx (bad
 * user_code, rate limit) is surfaced.
 */
async function sendEmailClaim(
  endpoint: string,
  userCode: string,
  email: string
): Promise<void> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_code: userCode, email }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as {
        error_description?: string;
        error?: string;
      };
      detail = body.error_description ?? body.error ?? "";
    } catch {
      // non-JSON error body — status alone is enough
    }
    throw new OAuthError(
      "email_claim_failed",
      `Email login request failed (${res.status})${detail ? `: ${detail}` : ""}.`
    );
  }
}

async function loginWithToken(
  target: { url: string; name: string },
  rawToken: string
): Promise<void> {
  const token = rawToken.trim();
  if (!token) {
    console.log(chalk.red("\n  Token cannot be empty.\n"));
    process.exitCode = 1;
    return;
  }

  await saveCredentials({ accessToken: token }, target.name);
  console.log(chalk.green(`\n  Logged in to ${target.name} with API token.\n`));
}

async function revokeExisting(existing: Credentials): Promise<void> {
  const oauth = existing.oauth;
  if (!oauth?.revocationEndpoint || !oauth.clientId) return;

  const client: RegisteredClient = {
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
  };

  if (existing.refreshToken) {
    await revokeToken(
      oauth.revocationEndpoint,
      client,
      existing.refreshToken,
      "refresh_token"
    );
  }
  await revokeToken(
    oauth.revocationEndpoint,
    client,
    existing.accessToken,
    "access_token"
  );
}

function abortableDelay(
  ms: number,
  abortBox: { signal: NodeJS.Signals | null; wake: (() => void) | null }
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (abortBox.signal) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      abortBox.wake = null;
      resolve();
    }, ms);
    abortBox.wake = () => {
      clearTimeout(timer);
      abortBox.wake = null;
      resolve();
    };
  });
}

async function tryOAuthStep<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.log(chalk.red(`\n  ${(err as Error).message}\n`));
    process.exitCode = 1;
    return undefined;
  }
}
