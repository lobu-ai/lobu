import chalk from "chalk";
import {
  getActiveOrg,
  getAgentApiToken,
  listOrganizations,
  loadCredentials,
  refreshCredentials,
  resolveContext,
} from "../internal/index.js";

/**
 * Machine-readable identity for the active (or `--context`) session, emitted by
 * `lobu whoami --json`. This is the contract the Owletto Mac app reads to drive
 * its menu bar (identity row, org, worker poll token) — it delegates all auth to
 * the CLI instead of keeping a parallel native session. Keep additive: the app
 * tolerates extra fields, but renamed/removed ones break it.
 */
interface WhoamiJson {
  loggedIn: boolean;
  context: string;
  /** Context URL as stored (may carry the `/lobu/api/v1` agent-API suffix). */
  apiUrl: string;
  /** True for loopback contexts (the embedded `lobu run` this Mac manages). */
  local: boolean;
  email?: string;
  name?: string;
  userId?: string;
  /** True when a refreshed access token is available. Raw tokens are never printed. */
  hasAccessToken: boolean;
  /** True when a device-worker token is available. Raw tokens are never printed. */
  hasWorkerToken: boolean;
  /** Epoch ms when `accessToken` expires, when known. */
  expiresAt?: number;
  /** Active org slug bound to this context, when set. */
  orgSlug?: string;
  /**
   * The user's personal-org slug. Device clients (Owletto Mac + Chrome) bind
   * here regardless of `orgSlug` (the active/CLI-selected org) — personal
   * device data always lands in the private workspace.
   */
  personalOrgSlug?: string;
  organizations: Array<{ slug: string; name?: string }>;
}

function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    );
  } catch {
    return false;
  }
}

export async function whoamiCommand(options?: {
  context?: string;
  json?: boolean;
}): Promise<void> {
  const target = await resolveContext(options?.context);
  const creds = await refreshCredentials(
    await loadCredentials(target.name),
    target.name
  );

  if (options?.json) {
    await emitJson(target, creds);
    return;
  }

  if (!creds) {
    const envToken = process.env.LOBU_API_TOKEN;
    if (envToken) {
      console.log(
        chalk.dim("\n  Authenticated via LOBU_API_TOKEN environment variable.")
      );
      console.log(chalk.dim(`  Context: ${target.name}`));
      console.log(chalk.dim(`  API URL: ${target.url}`));
      console.log(chalk.dim("  Lobu Cloud is in early access.\n"));
      return;
    }
    console.log(chalk.dim("\n  Not logged in."));
    console.log(chalk.dim(`  Context: ${target.name}`));
    console.log(chalk.dim(`  API URL: ${target.url}`));
    console.log(chalk.dim("  Run `lobu login` to authenticate.\n"));
    return;
  }

  console.log(chalk.bold("\n  Lobu CLI"));
  console.log(chalk.dim(`  Context: ${target.name}`));
  console.log(chalk.dim(`  API URL: ${target.url}`));
  if (creds.name) {
    console.log(chalk.dim(`  Name: ${creds.name}`));
  }
  if (creds.email) {
    console.log(chalk.dim(`  User: ${creds.email}`));
  }
  if (creds.userId) {
    console.log(chalk.dim(`  User ID: ${creds.userId}`));
  }
  console.log();
}

async function emitJson(
  target: { name: string; url: string },
  creds: Awaited<ReturnType<typeof refreshCredentials>>
): Promise<void> {
  const local = isLoopbackUrl(target.url);

  // For loopback contexts with no stored creds, getAgentApiToken transparently
  // POSTs /api/local-init to mint a worker PAT + session — the same zero-config
  // handshake the menu bar used to drive natively. This is what makes a fresh
  // `lobu run` install "just work" in the app without a manual login.
  let workerToken: string | undefined;
  try {
    workerToken = (await getAgentApiToken(target.name)) ?? undefined;
  } catch {
    workerToken = undefined;
  }

  // local-init may have written fresh creds (loopback bootstrap) — re-read so
  // identity/accessToken below reflect them.
  const effective = creds ?? (await loadCredentials(target.name));

  let organizations: Array<{ slug: string; name?: string }> = [];
  let personalOrgSlug: string | undefined;
  try {
    const full = await listOrganizations({ context: target.name });
    organizations = full.map((org) => ({ slug: org.slug, name: org.name }));
    personalOrgSlug = full.find((org) => org.personal)?.slug;
  } catch {
    organizations = [];
  }

  const orgSlug = (await getActiveOrg(target.name)) ?? organizations[0]?.slug;

  const result: WhoamiJson = {
    loggedIn: Boolean(effective?.accessToken || workerToken),
    context: target.name,
    apiUrl: target.url,
    local,
    email: effective?.email,
    name: effective?.name,
    userId: effective?.userId,
    hasAccessToken: Boolean(effective?.accessToken),
    hasWorkerToken: Boolean(workerToken ?? effective?.accessToken),
    expiresAt: effective?.expiresAt,
    orgSlug,
    personalOrgSlug,
    organizations,
  };

  process.stdout.write(`${JSON.stringify(result)}\n`);
}
