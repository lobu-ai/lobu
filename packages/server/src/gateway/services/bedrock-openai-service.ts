import { getModel, type Model } from "@mariozechner/pi-ai";
// pi-ai 0.73 tightened its `exports` map: the bedrock provider is no longer
// reachable at the deep `dist/providers/amazon-bedrock.js` path and is exposed
// as `bedrockProviderModule` from the `./bedrock-provider` subpath instead.
import { bedrockProviderModule } from "@mariozechner/pi-ai/bedrock-provider";

const streamBedrock = bedrockProviderModule.streamBedrock;
import type { Context } from "hono";
import { Hono } from "hono";
import { createLogger, getErrorMessage } from "@lobu/core";
import { authenticateWorker } from "../routes/internal/middleware.js";
import {
  BedrockModelCatalog,
  buildDynamicBedrockModel,
  resolveAwsRegion,
} from "./bedrock-model-catalog.js";

const logger = createLogger("bedrock-openai-service");

type BedrockStreamEvent = {
  type: string;
  contentIndex?: number;
  delta?: string;
  toolCall?: { id: string; name: string };
  reason?: string;
  message?: {
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
    };
  };
  error?: { errorMessage?: string };
};

interface OpenAITextPart {
  type: "text";
  text: string;
}

interface OpenAIImagePart {
  type: "image_url";
  image_url?: {
    url?: string;
  };
}

type OpenAIMessageContent = string | Array<OpenAITextPart | OpenAIImagePart>;

interface OpenAIChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: OpenAIMessageContent | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface OpenAIChatTool {
  type?: "function";
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  tools?: OpenAIChatTool[];
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | {
        type?: "function";
        function?: {
          name?: string;
        };
      };
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
}

type PiMessage =
  | {
      role: "user";
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; mimeType: string; data: string }
      >;
    }
  | {
      role: "assistant";
      content: Array<
        | { type: "text"; text: string }
        | {
            type: "toolCall";
            id: string;
            name: string;
            arguments: Record<string, unknown>;
          }
      >;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      content: Array<
        | { type: "text"; text: string }
        | { type: "image"; mimeType: string; data: string }
      >;
      isError?: boolean;
    };

interface BedrockContextPayload {
  messages: PiMessage[];
  systemPrompt?: string;
  tools?: Array<{
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  }>;
}

type ModelResolver = typeof getModel;
type BedrockStreamer = typeof streamBedrock;

function parseDataUrl(url?: string): { mimeType: string; data: string } | null {
  if (!url) return null;
  const match = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1]!,
    data: match[2]!,
  };
}

function normalizeMessageContent(
  content: OpenAIMessageContent | null | undefined
): Array<OpenAITextPart | OpenAIImagePart> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return Array.isArray(content) ? content : [];
}

function parseToolArguments(raw?: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildBedrockContext(
  request: OpenAIChatCompletionRequest
): BedrockContextPayload {
  const messages: PiMessage[] = [];
  const systemPrompts: string[] = [];

  for (const message of request.messages || []) {
    if (message.role === "system" || message.role === "developer") {
      const text = normalizeMessageContent(message.content)
        .filter((part): part is OpenAITextPart => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) systemPrompts.push(text);
      continue;
    }

    if (message.role === "tool") {
      if (!message.tool_call_id) continue;
      const content = normalizeMessageContent(message.content)
        .map((part) => {
          if (part.type === "text") {
            return { type: "text" as const, text: part.text };
          }
          const image = parseDataUrl(part.image_url?.url);
          return image
            ? {
                type: "image" as const,
                mimeType: image.mimeType,
                data: image.data,
              }
            : null;
        })
        .filter(
          (
            part
          ): part is
            | { type: "text"; text: string }
            | { type: "image"; mimeType: string; data: string } => Boolean(part)
        );

      messages.push({
        role: "toolResult",
        toolCallId: message.tool_call_id,
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
      });
      continue;
    }

    if (message.role === "assistant") {
      const content = normalizeMessageContent(message.content)
        .filter((part): part is OpenAITextPart => part.type === "text")
        .map((part) => ({ type: "text" as const, text: part.text }));

      const toolCalls = (message.tool_calls || []).map((toolCall) => ({
        type: "toolCall" as const,
        id: toolCall.id || crypto.randomUUID(),
        name: toolCall.function?.name || "",
        arguments: parseToolArguments(toolCall.function?.arguments),
      }));

      const assistantContent = [...content, ...toolCalls];
      if (assistantContent.length > 0) {
        messages.push({
          role: "assistant",
          content: assistantContent,
        });
      }
      continue;
    }

    const content = normalizeMessageContent(message.content)
      .map((part) => {
        if (part.type === "text") {
          return { type: "text" as const, text: part.text };
        }
        const image = parseDataUrl(part.image_url?.url);
        return image
          ? {
              type: "image" as const,
              mimeType: image.mimeType,
              data: image.data,
            }
          : null;
      })
      .filter(
        (
          part
        ): part is
          | { type: "text"; text: string }
          | { type: "image"; mimeType: string; data: string } => Boolean(part)
      );

    if (content.length > 0) {
      messages.push({
        role: "user",
        content,
      });
    }
  }

  const tools = (request.tools || [])
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => ({
      name: tool.function!.name!,
      description: tool.function?.description,
      parameters: tool.function?.parameters || {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    }));

  return {
    messages,
    ...(systemPrompts.length > 0
      ? { systemPrompt: systemPrompts.join("\n\n") }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function mapToolChoice(choice: OpenAIChatCompletionRequest["tool_choice"]):
  | "none"
  | "auto"
  | "any"
  | {
      type: "tool";
      name: string;
    }
  | undefined {
  if (choice === "none" || choice === "auto") return choice;
  if (choice === "required") return "any";
  const toolName = choice?.function?.name?.trim();
  return toolName ? { type: "tool", name: toolName } : undefined;
}

function mapStopReason(reason?: string): "stop" | "length" | "tool_calls" {
  switch (reason) {
    case "length":
      return "length";
    case "toolUse":
      return "tool_calls";
    default:
      return "stop";
  }
}

function createChunk(
  requestModel: string,
  created: number,
  chunkId: string,
  choices: unknown[],
  extra?: Record<string, unknown>
) {
  return {
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model: requestModel,
    choices,
    ...extra,
  };
}

function createSseStream(
  requestModel: string,
  stream: AsyncIterable<BedrockStreamEvent>,
  includeUsage: boolean
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const chunkId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
  const toolIndexes = new Map<number, number>();
  let nextToolIndex = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const writeData = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
        );
      };

      writeData(
        createChunk(requestModel, created, chunkId, [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ])
      );

      try {
        for await (const event of stream) {
          if (event.type === "text_delta" && event.delta) {
            writeData(
              createChunk(requestModel, created, chunkId, [
                {
                  index: 0,
                  delta: { content: event.delta },
                  finish_reason: null,
                },
              ])
            );
            continue;
          }

          if (event.type === "thinking_delta" && event.delta) {
            writeData(
              createChunk(requestModel, created, chunkId, [
                {
                  index: 0,
                  delta: { reasoning_content: event.delta },
                  finish_reason: null,
                },
              ])
            );
            continue;
          }

          if (
            event.type === "toolcall_start" &&
            event.contentIndex !== undefined
          ) {
            const toolIndex = nextToolIndex++;
            toolIndexes.set(event.contentIndex, toolIndex);
            writeData(
              createChunk(requestModel, created, chunkId, [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolIndex,
                        id: event.toolCall?.id || "",
                        type: "function",
                        function: {
                          name: event.toolCall?.name || "",
                          arguments: "",
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ])
            );
            continue;
          }

          if (
            event.type === "toolcall_delta" &&
            event.contentIndex !== undefined
          ) {
            const toolIndex = toolIndexes.get(event.contentIndex) ?? 0;
            writeData(
              createChunk(requestModel, created, chunkId, [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolIndex,
                        function: {
                          arguments: event.delta || "",
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ])
            );
            continue;
          }

          if (event.type === "done") {
            writeData(
              createChunk(requestModel, created, chunkId, [
                {
                  index: 0,
                  delta: {},
                  finish_reason: mapStopReason(event.reason),
                },
              ])
            );

            if (includeUsage) {
              const usage = event.message?.usage || {};
              const promptTokens = (usage.input || 0) + (usage.cacheRead || 0);
              const completionTokens = usage.output || 0;
              writeData(
                createChunk(requestModel, created, chunkId, [], {
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens:
                      usage.totalTokens || promptTokens + completionTokens,
                    prompt_tokens_details: {
                      cached_tokens: usage.cacheRead || 0,
                    },
                  },
                })
              );
            }

            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }

          if (event.type === "error") {
            controller.error(
              new Error(event.error?.errorMessage || "Bedrock request failed")
            );
            return;
          }
        }

        writeData(
          createChunk(requestModel, created, chunkId, [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ])
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

interface BedrockOpenAIServiceOptions {
  modelCatalog?: BedrockModelCatalog;
  modelResolver?: ModelResolver;
  bedrockStreamer?: BedrockStreamer;
}

export class BedrockOpenAIService {
  private readonly app = new Hono();
  private readonly modelCatalog: BedrockModelCatalog;
  private readonly modelResolver: ModelResolver;
  private readonly bedrockStreamer: BedrockStreamer;

  constructor(options: BedrockOpenAIServiceOptions = {}) {
    this.modelCatalog = options.modelCatalog || new BedrockModelCatalog();
    this.modelResolver = options.modelResolver || getModel;
    this.bedrockStreamer = options.bedrockStreamer || streamBedrock;
    this.setupRoutes();
  }

  getApp(): Hono {
    return this.app;
  }

  private setupRoutes(): void {
    this.app.get("/health", (c) =>
      c.json({
        service: "bedrock-openai-service",
        status: "enabled",
        region: resolveAwsRegion() || null,
      })
    );

    // All routes below this line require a valid worker JWT. Without auth
    // anyone on the network could burn AWS Bedrock spend through this
    // gateway-owned IAM bridge and exfiltrate model outputs.
    this.app.use("/openai/*", authenticateWorker);

    this.app.get("/openai/a/:agentId/v1/models", async (c) => {
      let models: Array<{ id: string; label: string }>;
      try {
        models = await this.modelCatalog.listModelOptions();
      } catch (error) {
        logger.warn(
          { error: getErrorMessage(error) },
          "Bedrock model catalog unavailable"
        );
        return c.json(
          {
            error: {
              type: "api_error",
              message: "Bedrock model catalog is unavailable",
            },
          },
          503
        );
      }
      return c.json({
        object: "list",
        data: models.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "amazon-bedrock",
        })),
      });
    });

    this.app.post("/openai/a/:agentId/v1/chat/completions", async (c) =>
      this.handleChatCompletions(c)
    );
  }

  private async resolveRuntimeModel(
    requestedModel: string
  ): Promise<Model<"bedrock-converse-stream">> {
    const staticModel = this.modelResolver(
      "amazon-bedrock" as never,
      requestedModel as never
    ) as Model<"bedrock-converse-stream"> | undefined;

    if (staticModel) return staticModel;

    // The catalog only enriches the label and input modalities; an AWS listing
    // failure must not block a turn on a model id the caller already chose.
    const discoveredModel = await this.modelCatalog
      .getModel(requestedModel)
      .catch((error: unknown) => {
        logger.warn(
          { error: getErrorMessage(error), model: requestedModel },
          "Bedrock model catalog unavailable; using defaults for the model"
        );
        return null;
      });
    return buildDynamicBedrockModel(requestedModel, discoveredModel);
  }

  private async handleChatCompletions(c: Context): Promise<Response> {
    const request = (await c.req
      .json()
      .catch(() => null)) as OpenAIChatCompletionRequest | null;

    if (!request?.model) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Missing required field: model",
          },
        },
        400
      );
    }

    if (request.stream === false) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "Only stream=true is supported for Amazon Bedrock",
          },
        },
        400
      );
    }

    const region = resolveAwsRegion();
    if (!region) {
      return c.json(
        {
          error: {
            type: "invalid_request_error",
            message: "AWS region is not configured on the gateway",
          },
        },
        503
      );
    }

    const runtimeModel = await this.resolveRuntimeModel(request.model);
    const context = buildBedrockContext(request);
    const stopSequences = Array.isArray(request.stop)
      ? request.stop
      : typeof request.stop === "string"
        ? [request.stop]
        : [];
    const toolChoice = mapToolChoice(request.tool_choice);

    logger.info(
      {
        modelId: request.model,
        region,
        toolCount: context.tools?.length || 0,
      },
      "Proxying OpenAI-style Bedrock request"
    );

    const stream = this.bedrockStreamer(
      runtimeModel as never,
      context as never,
      {
        signal: c.req.raw.signal,
        region,
        maxTokens: request.max_completion_tokens ?? request.max_tokens,
        temperature: request.temperature,
        ...(stopSequences.length > 0 ? { stopSequences } : {}),
        ...(toolChoice ? { toolChoice } : {}),
      }
    ) as AsyncIterable<BedrockStreamEvent>;

    return new Response(
      createSseStream(
        request.model,
        stream,
        request.stream_options?.include_usage === true
      ),
      {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      }
    );
  }
}
