import type { GoogleChatAdapter } from "@chat-adapter/gchat";
import type { AdapterCreationContext, ChatRuntimeConfig } from "./types.js";

export class GoogleChatScopeError extends Error {
  readonly code = "GOOGLE_CHAT_SCOPE_DENIED";
  constructor() {
    super("Google Chat operation is outside the installed space");
  }
}

function resource(value: string, space: string): void {
  if (!/^spaces\/[\w-]+(?:\/(?:messages|threads|attachments|reactions)\/[\w.-]+)*$/.test(value) ||
    value.split("/").some((part) => part === "." || part === "..") ||
    (value !== space && !value.startsWith(`${space}/`))) {
    throw new GoogleChatScopeError();
  }
}

/** Check all resource-bearing fields before SDK reactions or downloads can run. */
export function googleChatEventSpace(body: any): string {
  const spaces = new Set<string>();
  const visit = (value: any, key = "") => {
    if (typeof value === "string" &&
      ["name", "resourceName", "targetResource", "ce-subject"].includes(key)) {
      const name = value.replace(/^\/\/chat\.googleapis\.com\//, "");
      if (name.includes("spaces/")) {
        // The SDK extracts reaction message names with an unanchored regex.
        // Reject prefixed resources before it can fetch the embedded name.
        const space = name.split("/").slice(0, 2).join("/");
        resource(name, space);
        spaces.add(space);
      }
    } else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  };
  visit(body);
  if (body?.message?.data && body.subscription) {
    visit(JSON.parse(Buffer.from(body.message.data, "base64").toString("utf8")));
  }
  if (spaces.size !== 1) throw new GoogleChatScopeError();
  return [...spaces][0]!;
}

/** A scoped facade: raw Google clients and protected SDK methods are not exposed. */
export function scopeGoogleChatAdapter(
  initial: GoogleChatAdapter,
  runtime: NonNullable<AdapterCreationContext["runtime"]>,
  create: (config: ChatRuntimeConfig) => Promise<GoogleChatAdapter>,
): GoogleChatAdapter {
  const space = runtime.scope;
  resource(space, space);
  let delegate = initial;
  let revision = runtime.revision;
  let chat: any;
  const current = async () => {
    const next = await runtime.refresh();
    if (next.scope !== space) throw new GoogleChatScopeError();
    // Return each caller's own delegate: concurrent rotation reads must not
    // accidentally send through the mutable delegate selected by another call.
    if (next.revision === revision) return delegate;
    const replacement = await create(next);
    if (chat) await replacement.initialize(chat);
    delegate = replacement;
    revision = next.revision;
    return replacement;
  };
  const channel = (id: string) => {
    if (id !== `gchat:${space}`) throw new GoogleChatScopeError();
  };
  const thread = (id: string) => {
    const decoded = initial.decodeThreadId(id);
    resource(decoded.spaceName, space);
    if (decoded.spaceName !== space || initial.encodeThreadId(decoded) !== id) {
      throw new GoogleChatScopeError();
    }
    if (decoded.threadName) resource(decoded.threadName, space);
    return decoded;
  };
  const attachment = (value: any): any => {
    const name = value.fetchMetadata?.resourceName;
    if (!name) {
      // Unscoped fetch closures cannot survive serialization into this facade.
      const { fetchData: _fetchData, ...safe } = value;
      return safe;
    }
    resource(name, space);
    return { ...value, fetchData: async () => {
      const adapter = await current();
      // Retained attachments expose mutable metadata; use the name we checked.
      const rebound = adapter.rehydrateAttachment({
        ...value, fetchData: undefined,
        fetchMetadata: { ...value.fetchMetadata, resourceName: name },
      });
      return rebound.fetchData!();
    } };
  };
  const message = (value: any): any => {
    if (value && typeof value === "object") {
      if (typeof value.id === "string" && value.id.startsWith("spaces/")) resource(value.id, space);
      if (value.attachments) return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
        attachments: value.attachments.map(attachment),
      });
      if (value.messages) return { ...value, messages: value.messages.map(message) };
      if (value.threads) return { ...value, threads: value.threads.map(message) };
      if (value.rootMessage) return { ...value, rootMessage: message(value.rootMessage) };
    }
    return value;
  };
  const wrappedChat = (original: any) => new Proxy(original, {
    get(target, key) {
      if (key === "getState") return () => new Proxy(target.getState(), {
        get(state, method) {
          const fn = state[method];
          if (typeof fn !== "function") return fn;
          if (["get", "set", "delete", "setIfNotExists"].includes(String(method))) {
            return (key: string, ...args: any[]) => fn.call(state, `gchat-install:${runtime.stateKey}:${key}`, ...args);
          }
          return fn.bind(state);
        },
      });
      if (key === "processMessage") return (_adapter: any, id: string, parser: any, ...args: any[]) => {
        thread(id);
        const safe = typeof parser === "function"
          ? async () => message(await parser()) : message(parser);
        return target.processMessage(scoped, id, safe, ...args);
      };
      if (key === "processAction" || key === "processReaction") {
        return (event: any, ...args: any[]) => {
          if (event.threadId) thread(event.threadId);
          if (event.messageId) resource(event.messageId, space);
          return target[key]({ ...event, adapter: scoped }, ...args);
        };
      }
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const scoped: any = {
    name: initial.name,
    userName: initial.userName,
    get botUserId() { return delegate.botUserId; },
    initialize: async (original: any) => {
      chat = wrappedChat(original);
      await (await current()).initialize(chat);
    },
    encodeThreadId: (data: any) => {
      resource(data.spaceName, space);
      if (data.spaceName !== space) throw new GoogleChatScopeError();
      if (data.threadName) resource(data.threadName, space);
      return initial.encodeThreadId(data);
    },
    decodeThreadId: thread,
    channelIdFromThreadId: (id: string) => { thread(id); return `gchat:${space}`; },
    isDM: (id: string) => { thread(id); return initial.isDM(id); },
    renderFormatted: initial.renderFormatted.bind(initial),
    parseMessage: (raw: any) => {
      if (googleChatEventSpace(raw) !== space) throw new GoogleChatScopeError();
      return message(delegate.parseMessage(raw));
    },
    rehydrateAttachment: attachment,
    getUser: async (id: string) => (await current()).getUser(id),
    openDM: async () => { throw new GoogleChatScopeError(); },
    handleWebhook: async (request: Request, options: any) => {
      try {
        if (googleChatEventSpace(await request.clone().json()) !== space) throw new GoogleChatScopeError();
      } catch {
        return new Response("Invalid Google Chat space", { status: 403 });
      }
      return (await current()).handleWebhook(request, options);
    },
  };
  for (const name of ["postMessage", "postEphemeral", "fetchMessages", "fetchThread", "onThreadSubscribe", "startTyping"]) {
    scoped[name] = async (id: string, ...args: any[]) => {
      thread(id);
      return message(await (await current() as any)[name](id, ...args));
    };
  }
  for (const name of ["editMessage", "deleteMessage", "addReaction", "removeReaction"]) {
    scoped[name] = async (id: string, messageId: string, ...args: any[]) => {
      thread(id);
      resource(messageId, space);
      return message(await (await current() as any)[name](id, messageId, ...args));
    };
  }
  for (const name of ["postChannelMessage", "fetchChannelMessages", "fetchChannelInfo", "listThreads"]) {
    scoped[name] = async (id: string, ...args: any[]) => {
      channel(id);
      return message(await (await current() as any)[name](id, ...args));
    };
  }
  return scoped;
}
