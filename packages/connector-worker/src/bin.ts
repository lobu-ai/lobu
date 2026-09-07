#!/usr/bin/env node
/**
 * @lobu/worker CLI
 *
 * CLI entry point for the worker package.
 *
 * Commands:
 *   daemon - Start worker daemon (polls backend for jobs)
 */

import { startDaemonCommand } from './daemon/start.js';
import { printSelfCheckResult, runConnectorRuntimeSelfCheck } from './self-check/index.js';

function printUsage(): void {
  console.log(`
@lobu/worker - Self-hosted worker for Lobu - connectors and embedding generation

Usage:
  connector-worker <command> [options]

Commands:
  daemon       Start worker daemon (polls backend for jobs)
  self-check   Run the connector-runtime parity self-check (artifact/packaging
               assertions only; no network/DB). Exits non-zero on failure.

Options:
  --api-url <url>    Backend API URL (required for daemon)
  --worker-id <id>   Worker ID (device mode default: <platform>:<hostname>; fleet default: UUID)
  --version <ver>    Worker version (default: 1.0.0)
  --platform <name>  Run as a device worker on this host platform (e.g. macos, headless)
                     instead of a cloud-fleet worker. Requires a durable
                     personal access token in WORKER_API_TOKEN — mint one with
                     \`lobu token create --raw\`. Note \`lobu whoami --json\`
                     returns a session OAuth token that expires within 24h;
                     device mode rejects it at startup.
  --capabilities <a,b>  Comma-separated capabilities to advertise (device mode),
                     e.g. os.shell. The server drops anything the platform's
                     allowlist does not grant.
  --label <name>     Human-readable device name shown on the Devices page
  --active-org <slug> Org slug used for the action-permissions link printed in device mode
  --debug            Log poll/heartbeat/retry detail (default: one line per run)
  --json             (self-check) Emit machine-readable JSON to stdout
  --help             Show this help message

Environment Variables:
  API_URL            Backend API URL
  WORKER_ID          Worker ID
  GITHUB_TOKEN       GitHub API token (for GitHub feed)
  GOOGLE_MAPS_API_KEY Google Maps API key
  EMBEDDINGS_SERVICE_URL Embeddings service URL (if set, uses service; otherwise local)
  WORKER_API_TOKEN  Bearer token for /api/workers/* authentication (device
                    mode requires a durable owl_pat_ personal access token)
  WORKER_PLATFORM   Host platform (same as --platform)
  WORKER_CAPABILITIES Comma-separated capabilities (same as --capabilities)
  WORKER_LABEL      Human-readable device name (same as --label)
  LOBU_ORG          Active org slug (same as --active-org)

Examples:
  # Worker daemon
  connector-worker daemon --api-url https://api.example.com

  # Local headless device worker running shell commands
  WORKER_API_TOKEN=owl_pat_... connector-worker daemon \\
    --api-url https://app.lobu.ai --platform headless \\
    --worker-id "headless:$(hostname -s)" --capabilities os.shell \\
    --label "$(hostname -s)"

  # Connector-runtime parity self-check (CI smoke gate)
  connector-worker self-check --json
`);
}

function parseArgs(args: string[]): { command: string; options: Record<string, string> } {
  const command = args[0] || '';
  const options: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      } else {
        options[key] = 'true';
      }
    }
  }

  return { command, options };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command, options } = parseArgs(args);

  if (!command || command === '--help' || options.help) {
    printUsage();
    process.exit(0);
  }

  // Self-check needs no backend — handle it before the --api-url requirement.
  // This is one of the two parity entrypoints (the other is the CLI's
  // `lobu connector runtime-self-check`); both call the SAME
  // runConnectorRuntimeSelfCheck() so the worker image and the built CLI assert
  // the identical compile + IsolateExecutor invariant.
  if (command === 'self-check') {
    const result = await runConnectorRuntimeSelfCheck({ surface: 'worker' });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printSelfCheckResult(result);
    }
    process.exit(result.ok ? 0 : 1);
  }

  const apiUrl = options['api-url'] || process.env.API_URL;
  if (!apiUrl) {
    console.error('Error: --api-url or API_URL environment variable is required');
    process.exit(1);
  }

  const configuredWorkerId = (options['worker-id'] || process.env.WORKER_ID)?.trim() || undefined;
  const version = options.version || '1.0.0';

  switch (command) {
    case 'daemon': {
      const platform = (options.platform || process.env.WORKER_PLATFORM)?.trim() || undefined;
      const label = (options.label || process.env.WORKER_LABEL)?.trim() || undefined;
      const declared = (options.capabilities || process.env.WORKER_CAPABILITIES || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      try {
        await startDaemonCommand({
          apiUrl,
          workerId: configuredWorkerId,
          version,
          platform,
          label,
          capabilities: declared,
          activeOrg: (options['active-org'] || process.env.LOBU_ORG)?.trim() || undefined,
          workerApiToken: process.env.WORKER_API_TOKEN,
          debug: options.debug === 'true',
        });
      } catch (err) {
        console.error(
          'Error:',
          err instanceof Error ? err.message : String(err)
        );
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
