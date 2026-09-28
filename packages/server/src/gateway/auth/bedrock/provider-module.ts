import type { ModelOption } from "@lobu/core";
import type { BedrockModelCatalog } from "../../services/bedrock-model-catalog.js";
import { BaseProviderModule } from "../base-provider-module.js";
import type { AuthProfilesManager } from "../settings/auth-profiles-manager.js";

const BEDROCK_ROUTE_PREFIX = "/api/bedrock/openai";
const BEDROCK_BASE_URL_ENV = "AMAZON_BEDROCK_BASE_URL";
const BEDROCK_CREDENTIAL_ENV = "AMAZON_BEDROCK_API_KEY";
const WORKER_TOKEN_ENV = "WORKER_TOKEN";

function hasAwsCredentialHint(): boolean {
  // Explicit opt-in always wins
  if (process.env.BEDROCK_ENABLED === "true") return true;

  // Only auto-enable when an actual credential source is present.
  // Region alone is not sufficient — it doesn't provide authentication.
  return Boolean(
    process.env.AWS_PROFILE ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI ||
      process.env.AWS_BEARER_TOKEN_BEDROCK
  );
}

export class BedrockProviderModule extends BaseProviderModule {
  constructor(
    authProfilesManager: AuthProfilesManager,
    private readonly modelCatalog: BedrockModelCatalog
  ) {
    super(
      {
        providerId: "amazon-bedrock",
        providerDisplayName: "Amazon Bedrock",
        providerIconUrl:
          "https://www.google.com/s2/favicons?domain=aws.amazon.com&sz=128",
        credentialEnvVarName: BEDROCK_CREDENTIAL_ENV,
        secretEnvVarNames: [BEDROCK_CREDENTIAL_ENV],
        authType: "api-key",
        apiKeyInstructions:
          "No end-user API key is required. Run the gateway on AWS with IAM credentials available to the gateway process and set AWS_REGION (or AWS_DEFAULT_REGION).",
        apiKeyPlaceholder: "Not required",
        catalogDescription:
          "Use Amazon Bedrock models through gateway-owned AWS credentials",
      },
      authProfilesManager
    );
    this.name = "amazon-bedrock-provider";
  }

  override hasSystemKey(): boolean {
    return hasAwsCredentialHint();
  }

  override injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string> {
    // The Bedrock service authenticates callers with a worker JWT, so the
    // SDK-facing "API key" is populated with the worker's own token. That
    // way the OpenAI SDK's `Authorization: Bearer <key>` header carries a
    // verifiable worker credential to /api/bedrock/*.
    const workerToken = envVars[WORKER_TOKEN_ENV];
    if (workerToken) {
      envVars[BEDROCK_CREDENTIAL_ENV] = workerToken;
    }
    return envVars;
  }

  override async buildEnvVars(
    _agentId: string,
    envVars: Record<string, string>
  ): Promise<Record<string, string>> {
    const workerToken = envVars[WORKER_TOKEN_ENV];
    if (workerToken) {
      envVars[BEDROCK_CREDENTIAL_ENV] = workerToken;
    }
    return envVars;
  }

  override getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string,
    context?: import("../../embedded.js").ProviderCredentialContext
  ): Record<string, string> {
    const gatewayBase = proxyUrl.replace(/\/api\/proxy\/?$/, "");
    const base = `${gatewayBase}${BEDROCK_ROUTE_PREFIX}`;
    return {
      [BEDROCK_BASE_URL_ENV]: `${base}${this.buildAgentScopedSuffix(
        agentId,
        context
      )}`,
    };
  }

  buildCredentialPlaceholder(
    _agentId: string,
    context?: import("../../embedded.js").ProviderCredentialContext
  ): string {
    // The /api/bedrock/* route authenticates callers with a worker JWT.
    // Workers forward their WORKER_TOKEN as the Bearer credential via the
    // OpenAI SDK's `Authorization` header, so the "placeholder" handed to
    // the runtime is the worker's own token. Orchestrated deploys inject
    // the same value through `buildEnvVars` / `injectSystemKeyFallback`;
    // isolate turns receive it through the turn envelope.
    return context?.workerToken ?? "";
  }

  async getModelOptions(
    _agentId: string,
    _userId: string
  ): Promise<ModelOption[]> {
    const models = await this.modelCatalog.listModelOptions();
    return models.map((model) => ({
      value: `amazon-bedrock/${model.id}`,
      label: model.label,
    }));
  }
}
