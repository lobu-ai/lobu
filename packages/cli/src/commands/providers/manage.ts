/**
 * Org inference-provider commands — the imperative, config-less counterpart to
 * `defineConfig({ providers: [...] })` + `lobu apply`. Both edit the same
 * store: the org's `/inference-providers` REST surface (mounted under the
 * agents router). Use these when there is no `lobu.config.ts` for the project
 * — e.g. adding a model provider to an org that only exists server-side.
 *
 * OAuth (subscription sign-in) providers are the one exception: their
 * start/complete routes require an interactive browser session, so the CLI
 * points at the web console instead of driving the flow.
 */

import chalk from "chalk";
import type {
  InferenceCapabilityBlock,
  InferenceModality,
} from "../../config/define.js";
import { resolveApiClient } from "../../internal/index.js";
import { printJson } from "../../internal/output.js";
import type { CloudCommandOptions } from "../_lib/cloud-options.js";
import { resolveSecretFlag } from "../_lib/secret-value.js";

/** Server-routable modalities (`isInferenceModality` in provider-secrets.ts). */
const MODALITIES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "stt",
  "tts",
]);

interface OrgProviderRow {
  id: number;
  slug: string;
  kind: string;
  displayName: string | null;
  capabilities: Partial<Record<string, InferenceCapabilityBlock>>;
  hasCustomUpstream: boolean;
  status: string;
  createdAt: string;
  isDefault: boolean;
}

interface CatalogEntry {
  slug: string;
  displayName: string;
  authType: string;
  supportedAuthTypes?: string[];
  modalities?: string[];
  systemAvailable?: boolean;
}

function providersBase(orgSlug: string): string {
  return `/api/${orgSlug}/agents/inference-providers`;
}

function capabilitiesSummary(
  capabilities: Partial<Record<string, InferenceCapabilityBlock>>
): string {
  const parts: string[] = [];
  for (const [modality, block] of Object.entries(capabilities)) {
    if (!block) continue;
    parts.push(block.model ? `${modality}:${block.model}` : modality);
  }
  return parts.join(", ");
}

export async function providersListCommand(
  options: CloudCommandOptions = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const { providers } = await client.get<{ providers: OrgProviderRow[] }>(
    providersBase(orgSlug)
  );

  if (options.json) {
    printJson(providers);
    return;
  }

  if (providers.length === 0) {
    console.log(
      chalk.dim(
        `\n  No model providers in org ${orgSlug}. Add one with \`lobu providers create\`.\n`
      )
    );
    return;
  }

  console.log(chalk.bold(`\n  Model providers in ${orgSlug}`));
  for (const provider of providers) {
    const defaultTag = provider.isDefault ? chalk.cyan("  [default]") : "";
    const name = provider.displayName
      ? chalk.dim(` — ${provider.displayName}`)
      : "";
    const caps = capabilitiesSummary(provider.capabilities);
    const capsText = caps ? chalk.dim(`  (${caps})`) : "";
    console.log(
      `  ${chalk.green("●")} ${chalk.bold(provider.slug)} ${chalk.dim(provider.kind)}${defaultTag}${capsText}${name}`
    );
  }
  console.log();
}

export async function providersCatalogCommand(
  options: CloudCommandOptions = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  const { catalog } = await client.get<{ catalog: CatalogEntry[] }>(
    `${providersBase(orgSlug)}/catalog`
  );

  if (options.json) {
    printJson(catalog);
    return;
  }

  if (catalog.length === 0) {
    console.log(chalk.dim("\n  No bundled providers in the catalog.\n"));
    return;
  }

  console.log(chalk.bold("\n  Available provider kinds"));
  for (const entry of catalog) {
    // `supportedAuthTypes`, not `authType`: kinds like Claude list OAuth as
    // primary but also take a key, and `create --key` works for them. Sign-in
    // itself stays web-console-only (the OAuth routes reject PATs).
    const supported = entry.supportedAuthTypes ?? [entry.authType];
    const takesApiKey = supported.includes("api-key");
    const signsIn = supported.some((t) => t !== "api-key");
    const auth = takesApiKey
      ? signsIn
        ? chalk.dim("  api key or web sign-in")
        : chalk.dim("  api key")
      : chalk.yellow("  sign-in via web console");
    console.log(
      `  ${chalk.bold(entry.slug)} ${chalk.dim(entry.displayName)}${auth}`
    );
  }
  console.log(
    chalk.dim(
      "\n  Add one: lobu providers create <slug> --kind <kind> --key '$MY_API_KEY'\n"
    )
  );
}

export async function providersCreateCommand(
  slug: string,
  options: CloudCommandOptions & {
    kind: string;
    key: string;
    name?: string;
    model?: string;
    capabilities?: string;
    default?: boolean;
  }
): Promise<void> {
  const apiKey = resolveSecretFlag(options.key, "--key");
  const capabilities = buildCapabilities(options.capabilities, options.model);

  const { client, orgSlug } = await resolveApiClient(options);
  const { provider } = await client.post<{ provider: OrgProviderRow }>(
    providersBase(orgSlug),
    {
      slug,
      kind: options.kind,
      apiKey,
      ...(options.name ? { displayName: options.name } : {}),
      ...(capabilities ? { capabilities } : {}),
    }
  );

  if (options.default) {
    try {
      await client.request(
        "PUT",
        `${providersBase(orgSlug)}/${encodeURIComponent(slug)}/default`
      );
    } catch (error) {
      // The provider row exists at this point — a bare failure would read as
      // "nothing happened" and a retried create then 409s on the slug.
      console.error(
        chalk.yellow(
          `\n  Provider ${slug} was created, but setting it as org default failed.` +
            `\n  Retry with: lobu providers set-default ${slug}\n`
        )
      );
      throw error;
    }
  }

  // The server auto-promotes an org's first runnable provider, so "is it the
  // default" is NOT knowable from the flags alone — trust what it returned.
  // `--default` above issues an explicit PUT that throws on failure, so
  // reaching here with the flag set means that call succeeded.
  const isDefault = options.default || provider.isDefault;

  if (options.json) {
    printJson({ ...provider, isDefault });
    return;
  }
  const defaultNote = isDefault ? " and set as org default" : "";
  console.log(
    chalk.green(`\n  Created provider ${slug} in ${orgSlug}${defaultNote}.\n`)
  );
}

/** Merge `--capabilities <json>` with the `--model` shorthand (text model). */
function buildCapabilities(
  capabilitiesJson: string | undefined,
  model: string | undefined
): Partial<Record<InferenceModality, InferenceCapabilityBlock>> | undefined {
  let capabilities:
    | Partial<Record<InferenceModality, InferenceCapabilityBlock>>
    | undefined;
  if (capabilitiesJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(capabilitiesJson);
    } catch (error) {
      throw new Error(
        `--capabilities is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        '--capabilities must be a JSON object like {"text":{"model":"gpt-4o"}}.'
      );
    }
    for (const modality of Object.keys(parsed)) {
      if (!MODALITIES.has(modality)) {
        throw new Error(
          `--capabilities has unknown modality "${modality}" (use text, image, stt, tts).`
        );
      }
    }
    capabilities = parsed as Partial<
      Record<InferenceModality, InferenceCapabilityBlock>
    >;
  }
  if (model) {
    capabilities = {
      ...capabilities,
      text: { ...capabilities?.text, model },
    };
  }
  return capabilities;
}

export async function providersUpdateCommand(
  slug: string,
  options: CloudCommandOptions & { name: string }
): Promise<void> {
  // requiredOption guarantees presence, not substance — the server treats a
  // blank displayName as "leave unchanged", which would print "Renamed" for
  // a no-op.
  const displayName = options.name.trim();
  if (!displayName) {
    throw new Error("--name must not be blank.");
  }
  const { client, orgSlug } = await resolveApiClient(options);
  const { provider } = await client.request<{ provider: OrgProviderRow }>(
    "PUT",
    `${providersBase(orgSlug)}/${encodeURIComponent(slug)}`,
    { displayName }
  );

  if (options.json) {
    printJson(provider);
    return;
  }
  console.log(chalk.green(`\n  Renamed provider ${slug}.\n`));
}

export async function providersSetKeyCommand(
  slug: string,
  options: CloudCommandOptions & { key: string }
): Promise<void> {
  const value = resolveSecretFlag(options.key, "--key");
  const { client, orgSlug } = await resolveApiClient(options);
  await client.request(
    "PUT",
    `${providersBase(orgSlug)}/${encodeURIComponent(slug)}/key`,
    { value }
  );
  console.log(chalk.green(`\n  Rotated API key for provider ${slug}.\n`));
}

export async function providersSetCapabilityCommand(
  slug: string,
  modality: string,
  options: CloudCommandOptions & {
    model?: string;
    baseUrl?: string;
    modelsEndpoint?: string;
  }
): Promise<void> {
  if (!MODALITIES.has(modality)) {
    console.error(
      chalk.red(`\n  Modality must be one of: text, image, stt, tts.\n`)
    );
    process.exit(1);
  }
  const block: InferenceCapabilityBlock = {
    ...(options.model ? { model: options.model } : {}),
    ...(options.baseUrl ? { base_url: options.baseUrl } : {}),
    ...(options.modelsEndpoint
      ? { models_endpoint: options.modelsEndpoint }
      : {}),
  };
  if (Object.keys(block).length === 0) {
    console.error(
      chalk.red(
        "\n  Pass at least one of --model, --base-url, --models-endpoint.\n"
      )
    );
    process.exit(1);
  }

  const { client, orgSlug } = await resolveApiClient(options);
  await client.request(
    "PUT",
    `${providersBase(orgSlug)}/${encodeURIComponent(slug)}/capabilities/${encodeURIComponent(modality)}`,
    { block }
  );
  console.log(
    chalk.green(`\n  Updated ${modality} capabilities for provider ${slug}.\n`)
  );
}

export async function providersSetDefaultCommand(
  slug: string,
  options: CloudCommandOptions = {}
): Promise<void> {
  const { client, orgSlug } = await resolveApiClient(options);
  await client.request(
    "PUT",
    `${providersBase(orgSlug)}/${encodeURIComponent(slug)}/default`
  );
  console.log(chalk.green(`\n  Provider ${slug} is now the org default.\n`));
}

export async function providersDeleteCommand(
  slug: string,
  options: CloudCommandOptions & { yes?: boolean } = {}
): Promise<void> {
  if (!options.yes) {
    console.error(chalk.red("\n  Refusing to delete without --yes.\n"));
    process.exit(1);
  }
  const { client, orgSlug } = await resolveApiClient(options);
  await client.delete(`${providersBase(orgSlug)}/${encodeURIComponent(slug)}`);
  console.log(chalk.green(`\n  Deleted provider ${slug}.\n`));
}
