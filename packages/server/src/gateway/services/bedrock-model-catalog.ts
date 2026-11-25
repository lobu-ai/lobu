import {
  BedrockClient,
  InferenceType,
  ListFoundationModelsCommand,
  ModelModality,
  type FoundationModelSummary,
} from "@aws-sdk/client-bedrock";
import { getModels, type Model } from "@mariozechner/pi-ai";
const CACHE_TTL_MS = 5 * 60 * 1000;

interface BedrockCatalogModel {
  id: string;
  label: string;
  providerName?: string;
  modelName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
}

interface BedrockModelCatalogOptions {
  cacheTtlMs?: number;
  loadModels?: () => Promise<BedrockCatalogModel[]>;
}

export function resolveAwsRegion(): string | undefined {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || undefined;
}

function hasTextOutput(summary: FoundationModelSummary): boolean {
  return (summary.outputModalities || []).includes(ModelModality.TEXT);
}

function hasTextInput(summary: FoundationModelSummary): boolean {
  return (summary.inputModalities || []).includes(ModelModality.TEXT);
}

function supportsStreaming(summary: FoundationModelSummary): boolean {
  return summary.responseStreamingSupported === true;
}

function supportsOnDemand(summary: FoundationModelSummary): boolean {
  const inferenceTypes = summary.inferenceTypesSupported || [];
  return (
    inferenceTypes.length === 0 ||
    inferenceTypes.includes(InferenceType.ON_DEMAND)
  );
}

function buildModelLabel(model: {
  providerName?: string;
  modelName?: string;
  id: string;
}): string {
  const provider = model.providerName?.trim();
  const name = model.modelName?.trim();
  if (provider && name) return `${provider} / ${name}`;
  return name || model.id;
}

function normalizeFoundationModel(
  summary: FoundationModelSummary
): BedrockCatalogModel | null {
  const id = summary.modelId?.trim();
  if (!id) return null;
  if (!hasTextOutput(summary) || !hasTextInput(summary)) return null;
  if (!supportsStreaming(summary) || !supportsOnDemand(summary)) return null;

  return {
    id,
    label: buildModelLabel({
      providerName: summary.providerName,
      modelName: summary.modelName,
      id,
    }),
    providerName: summary.providerName,
    modelName: summary.modelName,
    inputModalities: summary.inputModalities,
    outputModalities: summary.outputModalities,
  };
}

function sortModels(a: BedrockCatalogModel, b: BedrockCatalogModel): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

export function buildDynamicBedrockModel(
  modelId: string,
  discovered?: Pick<
    BedrockCatalogModel,
    "inputModalities" | "modelName" | "providerName"
  > | null
): Model<"bedrock-converse-stream"> {
  const staticModel = getModels("amazon-bedrock").find((m) => m.id === modelId);
  if (staticModel) {
    return staticModel as Model<"bedrock-converse-stream">;
  }

  const input = (discovered?.inputModalities || [])
    .map((value) => value.toLowerCase())
    .filter(
      (value): value is "text" | "image" =>
        value === "text" || value === "image"
    );

  return {
    id: modelId,
    name:
      buildModelLabel({
        providerName: discovered?.providerName,
        modelName: discovered?.modelName,
        id: modelId,
      }) || modelId,
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    baseUrl: "",
    reasoning: false,
    input: input.length > 0 ? input : ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

async function loadBedrockModelsFromAws(): Promise<BedrockCatalogModel[]> {
  const region = resolveAwsRegion();
  if (!region) {
    throw new Error("AWS region is not configured");
  }

  const client = new BedrockClient({ region });
  const response = await client.send(
    new ListFoundationModelsCommand({
      byOutputModality: ModelModality.TEXT,
    })
  );

  return (response.modelSummaries || [])
    .map(normalizeFoundationModel)
    .filter((model): model is BedrockCatalogModel => Boolean(model))
    .sort(sortModels);
}

export class BedrockModelCatalog {
  private readonly cacheTtlMs: number;
  private readonly loadModelsImpl: () => Promise<BedrockCatalogModel[]>;
  private cachedModels:
    | { expiresAt: number; models: BedrockCatalogModel[] }
    | undefined;

  constructor(options: BedrockModelCatalogOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.loadModelsImpl = options.loadModels || loadBedrockModelsFromAws;
  }

  async listModels(): Promise<BedrockCatalogModel[]> {
    const now = Date.now();
    if (this.cachedModels && this.cachedModels.expiresAt > now) {
      return this.cachedModels.models;
    }

    // The live AWS catalog is the only source: a failure propagates so callers
    // report it instead of offering a stale bundled list.
    const models = await this.loadModelsImpl();
    this.cachedModels = {
      expiresAt: now + this.cacheTtlMs,
      models,
    };
    return models;
  }

  async listModelOptions(): Promise<Array<{ id: string; label: string }>> {
    const models = await this.listModels();
    return models.map((model) => ({
      id: model.id,
      label: model.label,
    }));
  }

  async getModel(modelId: string): Promise<BedrockCatalogModel | null> {
    const normalized = modelId.trim();
    if (!normalized) return null;
    const models = await this.listModels();
    return models.find((model) => model.id === normalized) || null;
  }
}
