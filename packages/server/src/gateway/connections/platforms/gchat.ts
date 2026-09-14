/**
 * Google Chat capability descriptor. Lobu resolves stored service-account JSON
 * as a string, while Chat SDK expects an object/auth client. Google also
 * sends standalone Chat API interaction events in a different envelope from
 * the Workspace Add-on envelope Chat SDK currently parses. Both translations
 * stay at this adapter boundary so storage and the cross-platform message
 * pipeline remain platform-neutral.
 */

import type {
  GoogleChatAdapter,
  GoogleChatAdapterConfig,
  ServiceAccountCredentials,
} from "@chat-adapter/gchat";
import type { WebhookOptions } from "chat";
import { extractWhatsAppStyleRoutingInfo } from "./shared.js";
import type {
  AdapterCreationContext,
  ChatPlatformDescriptor,
} from "./types.js";

type JsonObject = Record<string, any>;

export const GOOGLE_CHAT_WELCOME_TEXT = [
  "Welcome 👋",
  "",
  "In a direct message, just ask. In a space, mention this app when you want a response.",
  "Use `/lobu help` at any time to see commands and setup options.",
].join("\n");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function actionParameters(value: unknown): Record<string, string> | undefined {
  if (isObject(value)) {
    const entries = Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return entries.length > 0
      ? Object.fromEntries(entries)
      : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const entries = value.flatMap((parameter) =>
    isObject(parameter) &&
    typeof parameter.key === "string" &&
    typeof parameter.value === "string"
      ? [[parameter.key, parameter.value] as const]
      : []
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Canonicalize the Marketplace help command before Chat SDK parses the event.
 * Google can deliver it as plain message text or slash-form text, and users can
 * vary casing. Keeping this translation here prevents the shared message
 * pipeline from needing Google-specific command rules.
 */
function isDirectSpace(space: unknown): boolean {
  return (
    isObject(space) &&
    (space.type === "DM" || space.spaceType === "DIRECT_MESSAGE")
  );
}

function normalizeGoogleChatHelpMessage(
  message: JsonObject,
  allowBareHelp: boolean,
): JsonObject {
  const text = typeof message.text === "string" ? message.text : undefined;
  if (!text) return message;

  if (allowBareHelp && /^\/?help$/i.test(text.trim())) {
    return { ...message, text: "/help" };
  }

  const annotations = Array.isArray(message.annotations)
    ? message.annotations
    : [];
  for (const annotation of annotations) {
    if (
      !isObject(annotation) ||
      annotation.type !== "USER_MENTION" ||
      !isObject(annotation.userMention) ||
      !isObject(annotation.userMention.user) ||
      annotation.userMention.user.type !== "BOT" ||
      typeof annotation.startIndex !== "number" ||
      typeof annotation.length !== "number"
    ) {
      continue;
    }

    const mentionStart = annotation.startIndex;
    const mentionEnd = mentionStart + annotation.length;
    if (
      text.slice(0, mentionStart).trim().length === 0 &&
      /^\/?help$/i.test(text.slice(mentionEnd).trim())
    ) {
      // Preserve the original mention span so the pinned adapter can normalize
      // it from its annotation without invalidating the recorded offsets.
      return {
        ...message,
        text: `${text.slice(0, mentionEnd)} /help`,
      };
    }
  }

  return message;
}

/**
 * Convert the one registered Google command into Lobu's shared command text.
 * Google projects own their numeric command IDs, while Lobu intentionally uses
 * the same `/lobu <subcommand>` wrapper as Slack. Older projects that registered
 * this ID as `/help` keep their existing mapping.
 */
function registeredGoogleChatCommandText(
  message: JsonObject | undefined,
): string {
  const messageText =
    typeof message?.text === "string" ? message.text.trim() : "";
  const lobuCommand = messageText.match(/^\/?lobu(?:\s+([\s\S]*))?$/i);
  if (lobuCommand) {
    const args = lobuCommand[1]?.trim() || "";
    return args ? `/lobu ${args}` : "/help";
  }
  if (/^\/?help$/i.test(messageText)) return "/help";

  // Google exposes a mention-free copy of the message in argumentText. Use it
  // when text is absent, and accept both full `/lobu ...` and args-only forms.
  const argumentText =
    typeof message?.argumentText === "string"
      ? message.argumentText.trim()
      : "";
  if (argumentText) {
    const withoutWrapper = argumentText
      .replace(/^\/?lobu(?:\s+|$)/i, "")
      .trim();
    if (!withoutWrapper || /^\/?help$/i.test(withoutWrapper)) return "/help";
    return `/lobu ${withoutWrapper}`;
  }

  return "/help";
}

/**
 * Workspace Events arrive through Pub/Sub with the Chat resource encoded in
 * message.data. Normalize that embedded resource too: the Pub/Sub and direct
 * webhook copies share a message ID, so whichever arrives first wins Chat
 * SDK's deduplication.
 */
function normalizePubSubHelpMessage(body: JsonObject): JsonObject {
  const pushMessage = isObject(body.message) ? body.message : undefined;
  if (
    !pushMessage ||
    typeof pushMessage.data !== "string" ||
    typeof body.subscription !== "string"
  ) {
    return body;
  }

  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(pushMessage.data, "base64").toString("utf8"),
    );
    if (!isObject(decoded) || !isObject(decoded.message)) return body;

    const message = normalizeGoogleChatHelpMessage(
      decoded.message,
      isDirectSpace(decoded.message.space),
    );
    if (message === decoded.message) return body;

    return {
      ...body,
      message: {
        ...pushMessage,
        data: Buffer.from(
          JSON.stringify({ ...decoded, message }),
          "utf8",
        ).toString("base64"),
      },
    };
  } catch {
    // Leave malformed envelopes untouched so the adapter keeps ownership of
    // validation and its existing retry/acknowledgement semantics.
    return body;
  }
}

function normalizeWorkspaceAddOnAppCommand(
  body: JsonObject,
  botUserName: string,
  helpCommandId?: string,
): JsonObject {
  const chat = isObject(body.chat) ? body.chat : undefined;
  const payload = isObject(chat?.appCommandPayload)
    ? chat.appCommandPayload
    : undefined;
  const metadata = isObject(payload?.appCommandMetadata)
    ? payload.appCommandMetadata
    : undefined;
  const message = isObject(payload?.message) ? payload.message : undefined;
  const space = isObject(payload?.space) ? payload.space : undefined;
  if (!(chat && payload && metadata && space)) return body;

  const commandType = metadata.appCommandType;
  // Workspace Add-ons deliver registered commands as appCommandPayload, which
  // the current @chat-adapter/gchat release does not parse. Command IDs are
  // local to each Google Cloud project, so the connection owns the mapping.
  // Keep the text fallback for legacy payloads where Google supplies it.
  const messageText = typeof message?.text === "string" ? message.text : "";
  const invokedCommandId = commandId(metadata.appCommandId);
  const matchesConfiguredId =
    helpCommandId !== undefined &&
    invokedCommandId === helpCommandId;
  if (
    (commandType !== "SLASH_COMMAND" && commandType !== "QUICK_COMMAND") ||
    (!matchesConfiguredId && !/^\/?help$/i.test(messageText.trim()))
  ) {
    return body;
  }

  const eventTime =
    typeof message?.createTime === "string"
      ? message.createTime
      : typeof chat.eventTime === "string"
        ? chat.eventTime
        : undefined;
  if (!eventTime) return body;

  const isDm = isDirectSpace(space);
  // Chat SDK routes group messages only when the bot is mentioned. Commands
  // are already explicitly addressed to this app but don't carry a mention,
  // so use its normalized mention form at the adapter boundary. The message
  // bridge removes this prefix again before command dispatch.
  const commandText = registeredGoogleChatCommandText(message);
  const text = isDm ? commandText : `@${botUserName} ${commandText}`;
  const sender = isObject(message?.sender)
    ? message.sender
    : isObject(chat.user)
      ? chat.user
      : undefined;
  const thread = isObject(message?.thread)
    ? message.thread
    : isObject(payload.thread)
      ? payload.thread
      : undefined;
  const messageName =
    typeof message?.name === "string"
      ? message.name
      : `${space.name}/messages/app-command-${Buffer.from(
          JSON.stringify([
            invokedCommandId,
            commandType,
            eventTime,
            typeof sender?.name === "string" ? sender.name : "unknown",
          ]),
          "utf8",
        ).toString("base64url")}`;

  return {
    ...body,
    chat: {
      ...chat,
      messagePayload: {
        space,
        message: {
          ...(message ? normalizeGoogleChatHelpMessage(message, isDm) : {}),
          name: messageName,
          createTime: eventTime,
          text,
          ...(sender ? { sender } : {}),
          space,
          ...(thread ? { thread } : {}),
        },
      },
    },
  };
}

/** Translate Google interaction events into the envelope Chat SDK parses. */
function normalizeGoogleChatInteractionEvent(
  body: unknown,
  botUserName: string,
  helpCommandId?: string,
): unknown {
  if (!isObject(body)) return body;
  const normalizedPubSub = normalizePubSubHelpMessage(body);
  if (normalizedPubSub !== body) return normalizedPubSub;
  if (isObject(body.chat)) {
    const normalizedCommand = normalizeWorkspaceAddOnAppCommand(
      body,
      botUserName,
      helpCommandId,
    );
    const chat = isObject(normalizedCommand.chat)
      ? normalizedCommand.chat
      : undefined;
    const payload = isObject(chat?.messagePayload)
      ? chat.messagePayload
      : undefined;
    const message = isObject(payload?.message) ? payload.message : undefined;
    if (!(chat && payload && message)) return normalizedCommand;
    return {
      ...normalizedCommand,
      chat: {
        ...chat,
        messagePayload: {
          ...payload,
          message: normalizeGoogleChatHelpMessage(
            message,
            isDirectSpace(payload.space),
          ),
        },
      },
    };
  }

  const eventType =
    typeof body.type === "string"
      ? body.type
      : typeof body.eventType === "string"
        ? body.eventType
        : undefined;
  if (!eventType) return body;

  if (eventType === "APP_COMMAND") {
    const metadata = isObject(body.appCommandMetadata)
      ? body.appCommandMetadata
      : undefined;
    const space = isObject(body.space) ? body.space : undefined;
    if (!(metadata && space)) return body;
    const user = isObject(body.user) ? body.user : undefined;
    const message = isObject(body.message) ? body.message : undefined;
    const thread = isObject(body.thread) ? body.thread : undefined;
    return normalizeWorkspaceAddOnAppCommand(
      {
        ...body,
        chat: {
          ...(user ? { user } : {}),
          ...(typeof body.eventTime === "string"
            ? { eventTime: body.eventTime }
            : {}),
          appCommandPayload: {
            appCommandMetadata: metadata,
            space,
            ...(message ? { message } : {}),
            ...(thread ? { thread } : {}),
          },
        },
      },
      botUserName,
      helpCommandId,
    );
  }

  const rawMessage = isObject(body.message) ? body.message : undefined;
  const space = isObject(body.space)
    ? body.space
    : isObject(rawMessage?.space)
      ? rawMessage.space
      : undefined;
  let message = rawMessage
    ? normalizeGoogleChatHelpMessage(rawMessage, isDirectSpace(space))
    : undefined;
  const annotationCommandId = Array.isArray(rawMessage?.annotations)
    ? rawMessage.annotations
        .map((annotation: unknown) =>
          isObject(annotation) &&
          annotation.type === "SLASH_COMMAND" &&
          isObject(annotation.slashCommand)
            ? commandId(annotation.slashCommand.commandId)
            : undefined,
        )
        .find((value: string | undefined) => value !== undefined)
    : undefined;
  const standaloneCommandId = isObject(rawMessage?.slashCommand)
    ? commandId(rawMessage.slashCommand.commandId)
    : annotationCommandId;
  if (
    eventType === "MESSAGE" &&
    message &&
    space &&
    helpCommandId !== undefined &&
    standaloneCommandId === helpCommandId
  ) {
    const commandText = registeredGoogleChatCommandText(rawMessage);
    message = {
      ...message,
      text: isDirectSpace(space)
        ? commandText
        : `@${botUserName} ${commandText}`,
    };
  }
  const user = isObject(body.user)
    ? body.user
    : isObject(message?.sender)
      ? message.sender
      : undefined;
  const chat = {
    ...(user ? { user } : {}),
    ...(typeof body.eventTime === "string" ? { eventTime: body.eventTime } : {}),
  } as JsonObject;

  if (eventType === "MESSAGE" && message && space) {
    chat.messagePayload = { message, space };
  } else if (eventType === "ADDED_TO_SPACE" && space) {
    chat.addedToSpacePayload = { space };
  } else if (eventType === "REMOVED_FROM_SPACE" && space) {
    chat.removedFromSpacePayload = { space };
  } else if (eventType === "CARD_CLICKED" && space) {
    chat.buttonClickedPayload = {
      space,
      ...(message ? { message } : {}),
      ...(user ? { user } : {}),
    };
  } else {
    return body;
  }

  const common = isObject(body.common) ? body.common : {};
  const action = isObject(body.action) ? body.action : {};
  const parameters =
    actionParameters(common.parameters) ?? actionParameters(action.parameters);
  const invokedFunction =
    typeof common.invokedFunction === "string"
      ? common.invokedFunction
      : typeof action.actionMethodName === "string"
        ? action.actionMethodName
        : undefined;
  const formInputs = isObject(common.formInputs)
    ? common.formInputs
    : isObject(action.formInputs)
      ? action.formInputs
      : undefined;

  return {
    ...body,
    chat,
    ...(invokedFunction || parameters || formInputs
      ? {
          commonEventObject: {
            ...(invokedFunction ? { invokedFunction } : {}),
            ...(parameters ? { parameters } : {}),
            ...(formInputs ? { formInputs } : {}),
          },
        }
      : {}),
  };
}

async function normalizeWebhookRequest(
  request: Request,
  botUserName: string,
  helpCommandId?: string,
): Promise<{
  request: Request;
  addedToSpaceEnvelope: "standalone" | "workspaceAddOn" | null;
}> {
  const rawBody = await request.text();
  let body: unknown;
  let addedToSpaceEnvelope: "standalone" | "workspaceAddOn" | null = null;
  try {
    const originalBody: unknown = JSON.parse(rawBody);
    const workspaceAddOnAddedToSpace =
      isObject(originalBody) &&
      isObject(originalBody.chat) &&
      isObject(originalBody.chat.addedToSpacePayload);
    body = normalizeGoogleChatInteractionEvent(
      originalBody,
      botUserName,
      helpCommandId,
    );
    const addedToSpace =
      isObject(body) &&
      isObject(body.chat) &&
      isObject(body.chat.addedToSpacePayload);
    if (addedToSpace) {
      addedToSpaceEnvelope = workspaceAddOnAddedToSpace
        ? "workspaceAddOn"
        : "standalone";
    }
  } catch {
    body = rawBody;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return {
    request: new Request(request.url, {
      method: request.method,
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: request.signal,
    }),
    addedToSpaceEnvelope,
  };
}

function parseGoogleChatCredentials(
  value: unknown
): ServiceAccountCredentials {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Google Chat service account JSON is invalid");
    }
  }
  if (
    !isObject(parsed) ||
    typeof parsed.client_email !== "string" ||
    parsed.client_email.trim().length === 0 ||
    typeof parsed.private_key !== "string" ||
    parsed.private_key.trim().length === 0
  ) {
    throw new Error(
      "Google Chat service account JSON requires client_email and private_key"
    );
  }
  return parsed as ServiceAccountCredentials;
}

async function createAdapter(
  config: JsonObject,
  context?: AdapterCreationContext
): Promise<GoogleChatAdapter> {
  // Preserve the platform registry's existing lazy adapter boundary.
  const { createGoogleChatAdapter } = await import("@chat-adapter/gchat");
  const adapterConfig = { ...config };
  delete adapterConfig.platform;
  const helpCommandId =
    typeof adapterConfig.helpCommandId === "string"
      ? adapterConfig.helpCommandId.trim()
      : undefined;
  // Lobu consumes this project-local mapping at its compatibility boundary;
  // it is not a @chat-adapter/gchat configuration option.
  delete adapterConfig.helpCommandId;

  // Workspace Add-on webhooks use the manager-owned connection URL as their
  // JWT audience and sign as the Google-managed identity derived from the
  // configured project number. Neither value needs a second config field that
  // can drift from the connection URL or project number.
  if (context?.webhookUrl) {
    adapterConfig.endpointUrl = context.webhookUrl;
  }
  const projectNumber = adapterConfig.googleChatProjectNumber;
  if (
    !adapterConfig.workspaceAddOnServiceAccountEmail &&
    typeof projectNumber === "string" &&
    /^\d+$/.test(projectNumber.trim())
  ) {
    adapterConfig.workspaceAddOnServiceAccountEmail =
      `service-${projectNumber.trim()}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
  }

  const normalizedConfig = adapterConfig.credentials
    ? {
        ...adapterConfig,
        credentials: parseGoogleChatCredentials(adapterConfig.credentials),
      }
    : adapterConfig;

  const adapter = createGoogleChatAdapter(
    normalizedConfig as GoogleChatAdapterConfig
  );
  const handleWebhook = adapter.handleWebhook.bind(adapter);
  adapter.handleWebhook = async (
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> => {
    const normalized = await normalizeWebhookRequest(
      request,
      adapter.userName || "lobu",
      helpCommandId,
    );
    const response = await handleWebhook(normalized.request, options);
    if (normalized.addedToSpaceEnvelope && response.ok) {
      // Marketplace review requires an unprompted welcome when a DM starts or
      // the app is added to a space. Keep the adapter's subscription side
      // effect above, then replace its empty success body with the synchronous
      // Google Chat response so the welcome cannot depend on agent/model
      // availability.
      if (normalized.addedToSpaceEnvelope === "workspaceAddOn") {
        return Response.json({
          hostAppDataAction: {
            chatDataAction: {
              createMessageAction: {
                message: { text: GOOGLE_CHAT_WELCOME_TEXT },
              },
            },
          },
        });
      }
      return Response.json({ text: GOOGLE_CHAT_WELCOME_TEXT });
    }
    return response;
  };
  return adapter;
}

export const gchatPlatform: ChatPlatformDescriptor = {
  // Either a service-account JSON key or ADC — never neither.
  requiredConfigKeys: [
    ["credentials", "useApplicationDefaultCredentials"],
    "googleChatProjectNumber",
  ],

  assertCredentialsUsable: (config) => {
    if (typeof config.credentials === "string") {
      parseGoogleChatCredentials(config.credentials);
    }
  },

  createAdapter,

  extractRoutingInfo: extractWhatsAppStyleRoutingInfo,
};
