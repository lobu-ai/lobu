/**
 * WhatsApp Web MAIN-world adapter.
 *
 * Ported statement-for-statement from the Owletto extension's
 * whatsapp-web-main-v1.js. Three changes, all mechanical: the IIFE wrapper
 * became a named function, this repo's Biome profile reformatted it (the
 * extension is linted under Owletto's own scope, which uses tabs), and each
 * intentional empty `catch` carries a note so the shared lint config needs no
 * exemption for this file. Nothing else moved. Do not "clean it up" beyond
 * that: it reaches into WhatsApp's own module registry via window.require and
 * its shape is load-bearing.
 *
 * How it gets into the page: the connector serialises this function with
 * Function.prototype.toString() and runs `(<source>)()` through the generic
 * chrome `evaluate` op, which executes in the page's MAIN world. That is the
 * same mechanism the extension used with chrome.scripting.executeScript({func}),
 * minus the extension. The adapter is idempotent and self-versioning
 * (__owlettoWhatsAppAdapterV1 + ADAPTER_VERSION), so re-injecting is safe.
 *
 * INVARIANT — every binding this function needs must live INSIDE it. A constant
 * hoisted to module scope would vanish from toString() output and the page would
 * throw a ReferenceError at runtime, with nothing failing at build time.
 * whatsapp-web-adapter.test.ts pins that invariant; do not delete it.
 *
 * It is a .js file on purpose. It is not TypeScript and never was: it reaches
 * into WhatsApp's own undeclared module registry via window.require, and its
 * globals are the page's, not Node's. Giving it a .ts extension bought nothing
 * and cost a @ts-nocheck plus a set of `declare const` shims.
 */

export function whatsAppWebAdapterProgram() {
  const GLOBAL_KEY = "__owlettoWhatsAppAdapterV1";
  const ADAPTER_VERSION = 9;
  const SYSTEM_TYPES = new Set([
    "gp2",
    "notification_template",
    "e2e_notification",
  ]);
  let readinessSignature = null;
  let readinessStableSince = 0;

  // A WhatsApp tab outlives any one connector version, so an adapter from an
  // earlier version can already be resident. Leave it alone when the versions
  // match and replace it otherwise, so newly advertised operations stop
  // calling the pre-update invoke table.
  const existing = globalThis[GLOBAL_KEY];
  if (existing?.version === ADAPTER_VERSION) {
    return;
  }

  function requireFirst(names) {
    for (const name of names) {
      try {
        const module = window.require?.(name);
        if (module) return module;
      } catch {
        /* WhatsApp's private module graph throws freely; a miss is not fatal. */
      }
    }
    return null;
  }

  /**
   * The authenticated account's own WID.
   *
   * WhatsApp Web renamed this surface: `WAWebUserPrefsMe` / `WAWebUserPrefs` no
   * longer resolve at all (window.require returns null, it does not throw), and
   * the accessors `getMaybeMeUser` / `getMeUser` are gone with them. The current
   * module is `WAWebUserPrefsMeUser`, which splits the identity into a
   * phone-number WID and a LID WID. Prefer the phone-number form — every JID the
   * adapter canonicalizes elsewhere is `@s.whatsapp.net`/`@c.us`, so returning a
   * `@lid` WID here would silently fail to match the self chat.
   *
   * Verified live against WhatsApp Web on 2026-09-02: the legacy names returned
   * null while getMaybeMePnUser() returned {server:"c.us", user, _serialized}.
   * The old names stay in the list — they cost one lookup and this module has
   * now been renamed once.
   */
  function meUser() {
    const module = requireFirst([
      "WAWebUserPrefsMeUser",
      "WAWebUserPrefsMe",
      "WAWebUserPrefs",
    ]);
    if (!module) return null;
    for (const accessor of [
      "getMaybeMePnUser",
      "getMaybeMeUser",
      "getMeUser",
      "getMeUserOrThrow",
      "getMaybeMeLidUser",
    ]) {
      try {
        const value = module[accessor]?.();
        if (value) return value;
      } catch {
        /* An OrThrow accessor throws while signed out; try the next one. */
      }
    }
    try {
      return module.me ?? null;
    } catch {
      /* WhatsApp's private module graph throws freely; a miss is not fatal. */
    }
    return null;
  }

  /**
   * Module names for each write op, most-current first.
   *
   * WhatsApp Web renames these; the failure is silent because window.require
   * returns null for a dead name instead of throwing, so a stale list degrades
   * into "capability unavailable" rather than an error anyone sees. Verified
   * live on 2026-09-02: the FIRST entry in each list below is the one that
   * currently resolves, and every legacy name after it returned null. Keep the
   * legacy names — they cost one lookup and cover older builds.
   *
   * These lists are consumed by BOTH operationCapabilities() and the write
   * implementations. They were duplicated before, which let the capability
   * probe and the implementation disagree about what exists.
   */
  const SEND_MODULES = [
    "WAWebSendTextMsgChatAction",
    "WAWebSendMsgChatAction",
    "WAWebSendMessage",
  ];
  const REACTION_MODULES = [
    "WAWebSendReactionMsgAction",
    "WAWebSendReactionMsg",
    "WAWebReactionAction",
  ];
  const REVOKE_MODULES = [
    "WAWebChatSendMessages",
    "WAWebRevokeMsgAction",
    "WAWebDeleteChatAction",
    "WAWebRevokeMessage",
  ];
  const EDIT_MODULES = ["WAWebSendMessageEditAction", "WAWebEditMessage"];
  const DRAFT_MODULES = [
    "WAWebChatDraftUtils",
    "WAWebSetDraft",
    "WAWebComposeBoxActions",
  ];

  function modelData(model) {
    return model?.attributes ?? model?._data ?? model ?? {};
  }

  function models(collection) {
    if (Array.isArray(collection?._models)) return collection._models;
    if (Array.isArray(collection?.models)) return collection.models;
    if (typeof collection?.toArray === "function") {
      try {
        return collection.toArray();
      } catch {
        /* WhatsApp's private module graph throws freely; a miss is not fatal. */
      }
    }
    return [];
  }

  function widString(value) {
    if (typeof value === "string") return value;
    if (!value) return null;
    if (typeof value._serialized === "string") return value._serialized;
    try {
      const rendered = value.toString?.();
      return rendered && rendered !== "[object Object]"
        ? String(rendered)
        : null;
    } catch {
      return null;
    }
  }

  function rawId(value) {
    if (typeof value === "string")
      return value && !/^(?:true|false)_/i.test(value) ? value : null;
    if (typeof value?.id === "string")
      return value.id && !/^(?:true|false)_/i.test(value.id) ? value.id : null;
    return null;
  }

  function unixSeconds(row) {
    const value = Number(
      row?.t ?? row?.timestamp ?? row?.ephemeralStartTimestamp ?? 0
    );
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  async function canonicalJid(value) {
    const original = widString(value);
    if (!original) return { jid: null, lid: null };
    let jid = original.toLowerCase();
    if (jid.endsWith("@c.us")) jid = `${jid.slice(0, -5)}@s.whatsapp.net`;
    if (!jid.endsWith("@lid")) return { jid, lid: null };
    const migration = requireFirst([
      "WAWebLidMigrationUtils",
      "WAWebLidMigration",
    ]);
    const toPn =
      migration?.toPn ?? migration?.getPnForLid ?? migration?.lidToPhone;
    if (typeof toPn === "function") {
      try {
        const converted = await toPn.call(migration, value);
        const phoneJid = widString(converted);
        if (phoneJid) {
          return {
            jid: phoneJid.endsWith("@c.us")
              ? `${phoneJid.slice(0, -5)}@s.whatsapp.net`
              : phoneJid,
            lid: jid,
          };
        }
      } catch {
        /* WhatsApp's private module graph throws freely; a miss is not fatal. */
      }
    }
    return { jid, lid: jid };
  }

  function collectionByRawId(collection, id) {
    if (!id) return null;
    for (const model of models(collection)) {
      const row = modelData(model);
      if (rawId(row.id ?? model?.id) === id) return model;
    }
    return null;
  }

  function reactionTargetId(row) {
    return (
      rawId(row.reactionParentKey) ??
      rawId(row.parentMsgKey) ??
      rawId(row.parentMessageKey) ??
      (typeof row.quotedStanzaID === "string" ? row.quotedStanzaID : null)
    );
  }

  function normalizeReactions(row) {
    const source =
      row.reactions ?? row.reactionCollection ?? row.reactionsBySender;
    const rows = Array.isArray(source) ? source : models(source);
    return rows
      .map((reaction) => {
        const data = modelData(reaction);
        return {
          emoji: data.text ?? data.reactionText ?? data.emoji ?? null,
          sender_jid: widString(
            data.senderUserJid ?? data.sender ?? data.author
          ),
          from_me: Boolean(data.fromMe),
        };
      })
      .filter(
        (reaction) =>
          typeof reaction.emoji === "string" && reaction.emoji.length > 0
      );
  }

  /**
   * Name lookups for one collect.
   *
   * `normalizeMessage` runs per message and used to walk a whole collection on
   * each call -- the chat name over 947 chats, the sender name over 5323
   * contacts. That is O(messages x collection) of SYNCHRONOUS work: measured on
   * a live prod tab the contact scan alone projects to ~6.8s, a real collect
   * never yielded the main thread, and the extension's 90s run fence killed the
   * run. Every run was slower than the last as backfill grew the store.
   *
   * Built once per collect and thrown away with it -- no cache to invalidate,
   * and nothing here outlives the call. Only names are indexed: they read
   * static fields, whereas `collectionByRawId` serves the reaction paths, which
   * mutate a model in place without changing the collection, so that one keeps
   * scanning.
   */
  function nameIndex(collections) {
    const byId = (collection) => {
      const map = new Map();
      for (const model of models(collection)) {
        const id = widString(modelData(model).id ?? model?.id);
        // First writer wins, like the scans this replaces.
        if (id && !map.has(id)) map.set(id, model);
      }
      return map;
    };
    return { chats: byId(collections?.Chat), contacts: byId(collections?.Contact) };
  }

  function contactName(names, jid) {
    if (!jid) return null;
    const contact = names?.contacts?.get(jid);
    if (!contact) return null;
    const row = modelData(contact);
    return (
      row.name ?? row.pushname ?? row.shortName ?? row.formattedName ?? null
    );
  }

  function chatName(names, jid) {
    if (!jid) return null;
    const chat = names?.chats?.get(jid);
    if (!chat) return null;
    const row = modelData(chat);
    return (
      row.name ??
      row.formattedTitle ??
      row.contact?.name ??
      row.contact?.pushname ??
      null
    );
  }

  async function normalizeMessage(
    model,
    eventType = "snapshot",
    collectionsOverride = null,
    names = null
  ) {
    const collections =
      collectionsOverride ?? requireFirst(["WAWebCollections"]);
    if (!collections) return null;
    // A single normalise (the watch path) builds its own; a collect passes one
    // in so the whole run shares it.
    const nameLookup = names ?? nameIndex(collections);
    let row = modelData(model);
    let key = row.id ?? model?.id;
    let id = rawId(key);
    if (!id) return null;

    if (row.type === "reaction") {
      const targetId = reactionTargetId(row);
      const target = collectionByRawId(collections.Msg, targetId);
      if (target) {
        model = target;
        row = modelData(model);
        key = row.id ?? model?.id;
        id = rawId(key);
      }
    }

    const fromMe = Boolean(key?.fromMe ?? row.fromMe);
    const remoteRaw = key?.remote ?? row.chatId;
    const fromRaw = row.from;
    const toRaw = row.to;
    const authorRaw = row.author ?? key?.participant;
    const chatRaw = remoteRaw ?? (fromMe ? toRaw : fromRaw);
    const chat = await canonicalJid(chatRaw);
    if (
      !chat.jid ||
      chat.jid === "status@broadcast" ||
      chat.jid.endsWith("@newsletter")
    ) {
      return null;
    }
    const senderRaw = fromMe ? fromRaw : (authorRaw ?? fromRaw);
    const sender = await canonicalJid(senderRaw);
    const participant = await canonicalJid(
      key?.participant ?? row.participant ?? (fromMe ? toRaw : null)
    );
    const timestamp = unixSeconds(row);
    const body = typeof row.body === "string" ? row.body : "";
    const caption = typeof row.caption === "string" ? row.caption : "";
    const quotedId =
      typeof row.quotedStanzaID === "string"
        ? row.quotedStanzaID
        : rawId(row.quotedMsg?.id ?? row.quotedMsgKey);
    const type = typeof row.type === "string" ? row.type : "unknown";
    return {
      id,
      chat_jid: chat.jid,
      chat_lid: chat.lid,
      chat_name: chatName(nameLookup, widString(chatRaw)),
      sender_jid: sender.jid,
      sender_lid: sender.lid,
      push_name:
        contactName(nameLookup, widString(senderRaw)) ??
        row.notifyName ??
        null,
      participant: participant.jid,
      from_me: fromMe,
      is_group: chat.jid.endsWith("@g.us"),
      timestamp,
      occurred_at:
        timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
      body,
      caption,
      message_type: type,
      media_kind:
        type === "ptt"
          ? "audio"
          : ["image", "video", "audio", "document", "sticker"].includes(type)
            ? type
            : null,
      media_type: typeof row.mimetype === "string" ? row.mimetype : null,
      media_size: Number.isFinite(Number(row.size ?? row.fileSize))
        ? Number(row.size ?? row.fileSize)
        : null,
      media_filename: row.filename ?? row.fileName ?? row.title ?? null,
      quoted_id: quotedId,
      is_forwarded: Boolean(row.isForwarded || Number(row.forwardingScore) > 0),
      is_starred: Boolean(row.star ?? row.isStarred),
      is_system_event: SYSTEM_TYPES.has(type),
      edited: Boolean(row.isEdited || row.editVersion || row.latestEditMsgKey),
      edit_timestamp:
        Number(row.editTimestamp ?? row.lastEditTimestamp) || null,
      revoked: Boolean(row.isRevoked || row.revoked || type === "revoked"),
      reactions: normalizeReactions(row),
      event_type: eventType,
    };
  }

  function readiness() {
    if (typeof window.require !== "function") {
      return {
        ready: false,
        state: "hydrating",
        reason: "whatsapp_runtime_unavailable",
      };
    }
    const collections = requireFirst(["WAWebCollections"]);
    if (!collections?.Msg || !collections?.Chat) {
      return {
        ready: false,
        state: "hydrating",
        reason: "collections_unavailable",
      };
    }
    const me = meUser();
    const qrVisible = Boolean(
      document.querySelector(
        '[data-testid="qrcode"], canvas[aria-label*="Scan" i], [data-ref] canvas'
      )
    );
    if (!me && qrVisible) {
      return { ready: false, state: "logged_out", reason: "qr_code_visible" };
    }
    if (!me) {
      return {
        ready: false,
        state: "hydrating",
        reason: "authenticated_self_identity_unavailable",
      };
    }
    const connection = requireFirst([
      "WAWebSocketState",
      "WAWebConn",
      "WAWebConnectionState",
    ]);
    const connectionState = String(
      connection?.getSocketState?.() ??
        connection?.state ??
        connection?.socketState ??
        ""
    ).toLowerCase();
    if (/disconnected|unpaired|conflict|timeout/.test(connectionState)) {
      return {
        ready: false,
        state: "not_ready",
        reason: `connection_${connectionState}`,
      };
    }
    if (
      connectionState &&
      !/^(connected|open|ready|syncing)$/.test(connectionState)
    ) {
      return {
        ready: false,
        state: "not_ready",
        reason: `connection_${connectionState}`,
      };
    }
    const offlineDelivery = requireFirst([
      "WAWebOfflineDelivery",
      "WAWebOfflineDeliveryState",
    ]);
    const offlineDeliveryComplete =
      offlineDelivery?.isOfflineDeliveryComplete?.() ??
      offlineDelivery?.offlineDeliveryComplete ??
      offlineDelivery?.isComplete;
    if (offlineDeliveryComplete === false) {
      return {
        ready: false,
        state: "hydrating",
        reason: "offline_delivery_incomplete",
      };
    }
    const hydration = requireFirst([
      "WAWebInitialSyncInfo",
      "WAWebHistorySync",
      "WAWebAppState",
    ]);
    const hydrationComplete =
      hydration?.isInitialSyncComplete?.() ??
      hydration?.initialSyncComplete ??
      hydration?.isHydrated ??
      true;
    if (hydrationComplete !== true) {
      return {
        ready: false,
        state: "hydrating",
        reason: "initial_sync_incomplete",
      };
    }
    if (
      !Array.isArray(collections.Chat._models) &&
      !Array.isArray(collections.Chat.models)
    ) {
      return {
        ready: false,
        state: "hydrating",
        reason: "chat_store_placeholder",
      };
    }
    const signature = `${widString(me)}:${models(collections.Chat).length}:${models(collections.Msg).length}`;
    if (signature !== readinessSignature) {
      readinessSignature = signature;
      readinessStableSince = Date.now();
      return { ready: false, state: "hydrating", reason: "stores_settling" };
    }
    if (Date.now() - readinessStableSince < 500) {
      return { ready: false, state: "hydrating", reason: "stores_settling" };
    }
    return {
      ready: true,
      state: "ready",
      message_count: models(collections.Msg).length,
      chat_count: models(collections.Chat).length,
    };
  }

  function operationCapabilities() {
    const history = requireFirst(["WAWebChatLoadMessages"]);
    const search = requireFirst([
      "WAWebChatMessageSearch",
      "WAWebMessageSearch",
      "WAWebSearchMessages",
    ]);
    const draft = requireFirst(DRAFT_MODULES);
    const send = requireFirst(SEND_MODULES);
    const edit = requireFirst(EDIT_MODULES);
    const reaction = requireFirst(REACTION_MODULES);
    const revoke = requireFirst(REVOKE_MODULES);
    // Same nesting as the download path: the module root only exports
    // `{ enforceKaleidoscopeScore, downloadManager }`.
    const mediaModule = requireFirst(["WAWebDownloadManager"]);
    const media = mediaModule?.downloadManager ?? mediaModule;
    const hasFunction = (module, names) =>
      names.some((name) => typeof module?.[name] === "function");
    return {
      collect: hasFunction(history, ["loadEarlierMsgs"]),
      download_media:
        hasFunction(media, ["downloadAndMaybeDecrypt"]) ||
        models(requireFirst(["WAWebCollections"])?.Msg).some(
          (model) => typeof model?.downloadMedia === "function"
        ),
      search_messages:
        hasFunction(search, ["searchMessages", "searchMsgs", "search"]) ||
        Boolean(requireFirst(["WAWebCollections"])?.Msg),
      draft_message: hasFunction(draft, [
        "setDraft",
        "setChatDraft",
        "saveDraft",
      ]),
      // `addAndSendTextMsg` is the two-step API's delivery half; a build that
      // offers only that pair can still send, so probing for the one-shot
      // names alone would report the capability unavailable while it works.
      send_message: hasFunction(send, [
        "sendTextMsgToChat",
        "sendMessage",
        "addAndSendTextMsg",
      ]),
      edit_message: hasFunction(edit, ["sendMessageEdit", "editMessage"]),
      react_message: hasFunction(reaction, [
        "sendReactionToMsg",
        "sendReaction",
      ]),
      revoke_message: hasFunction(revoke, ["sendRevokeMsgs", "revokeMessage"]),
    };
  }

  function oldestMessage(chat) {
    let oldest = null;
    for (const message of models(modelData(chat).msgs ?? chat?.msgs)) {
      const row = modelData(message);
      const timestamp = unixSeconds(row);
      const id = rawId(row.id ?? message?.id);
      if (!id) continue;
      if (
        !oldest ||
        timestamp < oldest.timestamp ||
        (timestamp === oldest.timestamp && id < oldest.id)
      ) {
        oldest = { timestamp, id };
      }
    }
    return oldest;
  }

  function chatHasEarlier(chat) {
    const row = modelData(chat);
    const state =
      row.msgs?.msgLoadState ??
      chat?.msgs?.msgLoadState ??
      row.msgLoadState ??
      {};
    if (state.noEarlierMsgs === true || state.hasEarlierMsgs === false)
      return false;
    if (row.hasEarlierMsgs === false) return false;
    return true;
  }

  async function loadEarlier(chat, limit, deadline) {
    const loader = requireFirst(["WAWebChatLoadMessages"]);
    if (typeof loader?.loadEarlierMsgs !== "function") {
      return {
        available: false,
        reason: "WAWebChatLoadMessages.loadEarlierMsgs unavailable",
        loads: 0,
      };
    }
    let loads = 0;
    const beforeIds = new Set(
      models(modelData(chat).msgs ?? chat?.msgs)
        .map((message) => rawId(modelData(message).id ?? message?.id))
        .filter(Boolean)
    );
    let previous = oldestMessage(chat);
    let madeProgress = false;
    while (loads < limit && chatHasEarlier(chat)) {
      if (deadline && Date.now() >= deadline)
        throw new Error("history deadline budget exhausted");
      await loader.loadEarlierMsgs({ chat, msgCollection: chat.msgs });
      loads += 1;
      const next = oldestMessage(chat);
      if (
        !next ||
        (previous &&
          next.id === previous.id &&
          next.timestamp === previous.timestamp)
      )
        break;
      madeProgress = true;
      previous = next;
    }
    let hasMore = chatHasEarlier(chat);
    const loadedIds = () =>
      models(modelData(chat).msgs ?? chat?.msgs)
        .map((message) => rawId(modelData(message).id ?? message?.id))
        .filter((id) => id && !beforeIds.has(id));
    if (hasMore && !madeProgress) {
      return {
        available: true,
        loads,
        has_more: true,
        loaded_ids: loadedIds(),
        frontier_advanced: false,
        error: "WhatsApp history loader made no progress",
      };
    }
    if (hasMore) {
      const phone =
        loader.loadEarlierMsgsFromPhone ??
        loader.requestEarlierMsgsFromPhone ??
        loader.loadEarlierMsgsFromServer;
      const state =
        modelData(chat).msgs?.msgLoadState ?? chat?.msgs?.msgLoadState ?? {};
      const wantsPhone =
        state.canRequestFromPhone === true || state.hasMoreFromPhone === true;
      if (wantsPhone && typeof phone !== "function") {
        return {
          available: true,
          loads,
          has_more: true,
          loaded_ids: loadedIds(),
          frontier_advanced: false,
          error:
            "phone-assisted WhatsApp history is advertised but its loader is unavailable",
        };
      }
      if (typeof phone === "function" && wantsPhone) {
        try {
          await phone.call(loader, { chat, msgCollection: chat.msgs });
          hasMore = chatHasEarlier(chat);
        } catch (error) {
          return {
            available: true,
            loads,
            has_more: true,
            loaded_ids: loadedIds(),
            frontier_advanced: false,
            error: `phone-assisted history failed: ${String(error)}`,
          };
        }
      }
    }
    return {
      available: true,
      loads,
      has_more: hasMore,
      loaded_ids: loadedIds(),
      frontier_advanced: true,
    };
  }

  function uniqueMessageModels(collections) {
    const byId = new Map();
    for (const message of models(collections.Msg)) {
      const id = rawId(modelData(message).id ?? message?.id);
      if (id) byId.set(id, message);
    }
    for (const chat of models(collections.Chat)) {
      for (const message of models(modelData(chat).msgs ?? chat?.msgs)) {
        const id = rawId(modelData(message).id ?? message?.id);
        if (id) byId.set(id, message);
      }
    }
    return [...byId.values()];
  }

  async function collect(request) {
    const status = readiness();
    if (!status.ready) return { ok: false, error: status };
    const collections = requireFirst(["WAWebCollections"]);
    const chatFilter = ["all", "individual", "group"].includes(
      request.chat_filter
    )
      ? request.chat_filter
      : "all";
    const chatRows = [];
    for (const chat of models(collections.Chat)) {
      const raw = widString(modelData(chat).id ?? chat?.id);
      const jid = (await canonicalJid(raw)).jid;
      if (
        !jid ||
        jid === "status@broadcast" ||
        jid.endsWith("@newsletter") ||
        (chatFilter === "group" && !jid.endsWith("@g.us")) ||
        (chatFilter === "individual" && jid.endsWith("@g.us"))
      )
        continue;
      chatRows.push({ chat, jid });
    }
    chatRows.sort((a, b) => a.jid.localeCompare(b.jid));
    const backfill = request.backfill ?? { complete: false, chats: {} };
    const updates = {};
    let cursor = backfill.cursor_chat_jid ?? null;
    const loadedByChat = new Map();
    const backfillMessageIds = new Set();
    const eligible = request.backfill_disabled
      ? []
      : chatRows.filter(
          (entry) => backfill.chats?.[entry.jid]?.has_more !== false
        );
    if (eligible.length > 0) {
      let start = cursor
        ? eligible.findIndex((entry) => entry.jid > cursor)
        : 0;
      if (start < 0) start = 0;
      const rotated = [...eligible.slice(start), ...eligible.slice(0, start)];
      const selected = rotated.slice(
        0,
        Math.max(1, Number(request.max_chats) || 1)
      );
      // The connector sends a relative budget, not an absolute instant: it runs
      // on a different machine than this page, so any shared epoch would be off
      // by the clock skew between them. Resolving it here against this page's
      // own clock keeps the budget exact.
      const budgetMs = Number(request.budget_ms);
      const historyDeadline =
        Number.isFinite(budgetMs) && budgetMs > 0
          ? Date.now() + budgetMs
          : null;
      for (const entry of selected) {
        if (historyDeadline && Date.now() >= historyDeadline) break;
        try {
          const loaded = await loadEarlier(
            entry.chat,
            Math.max(1, Number(request.max_loads_per_chat) || 1),
            historyDeadline
          );
          if (!loaded.available) {
            return {
              ok: false,
              error: {
                state: "capability_unavailable",
                reason: loaded.reason,
              },
            };
          }
          const oldest = oldestMessage(entry.chat);
          for (const id of loaded.loaded_ids) backfillMessageIds.add(id);
          loadedByChat.set(entry.jid, loaded.loaded_ids);
          if (loaded.frontier_advanced === false) {
            updates[entry.jid] = {
              ...(backfill.chats?.[entry.jid] ?? {}),
              error: loaded.error,
              has_more: true,
              loads: loaded.loads,
            };
            continue;
          }
          updates[entry.jid] = {
            oldest_timestamp: oldest?.timestamp ?? null,
            oldest_id: oldest?.id ?? null,
            has_more: loaded.has_more,
            loads: loaded.loads,
          };
          cursor = entry.jid;
        } catch (error) {
          if (/unavailable/i.test(String(error))) {
            return {
              ok: false,
              error: {
                state: "capability_unavailable",
                reason: String(error),
              },
            };
          }
          updates[entry.jid] = {
            ...(backfill.chats?.[entry.jid] ?? {}),
            error: String(error),
            has_more: true,
          };
        }
      }
    }

    const minimum = Number.isFinite(Number(request.minimum_timestamp))
      ? Number(request.minimum_timestamp)
      : null;
    const recent = Number.isFinite(Number(request.recent_since))
      ? Number(request.recent_since)
      : null;
    const dirtyRanges = Array.isArray(request.dirty_ranges)
      ? request.dirty_ranges
      : [];
    const dirtyByMessageId = new Map(
      dirtyRanges
        .filter((marker) => marker?.message_id)
        .map((marker) => [marker.message_id, marker])
    );
    const normalized = [];
    const quarantined = [];
    const names = nameIndex(collections);
    for (const model of uniqueMessageModels(collections)) {
      const message = await normalizeMessage(
        model,
        "reconcile",
        collections,
        names
      );
      if (!message) continue;
      if (message.timestamp <= 0) {
        quarantined.push({
          key: `${message.chat_jid}:${message.id}`,
          message_id: message.id,
          chat_jid: message.chat_jid,
          reason: "missing_stable_timestamp",
        });
        continue;
      }
      if (chatFilter === "group" && !message.is_group) continue;
      if (chatFilter === "individual" && message.is_group) continue;
      if (minimum != null && message.timestamp < minimum) continue;
      if (
        recent != null &&
        message.timestamp < recent &&
        !backfillMessageIds.has(message.id) &&
        !dirtyByMessageId.has(message.id)
      )
        continue;
      normalized.push(message);
    }
    normalized.sort(
      (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)
    );
    const maxMessages = Math.max(
      1,
      Math.min(Number(request.max_messages) || 1_000, 2_000)
    );
    const byId = new Map(normalized.map((message) => [message.id, message]));
    const historyPages = [];
    for (const [chatJid, ids] of loadedByChat) {
      historyPages.push({
        chat_jid: chatJid,
        ...(updates[chatJid] ?? {}),
        messages: ids.map((id) => byId.get(id)).filter(Boolean),
      });
    }
    const messages = normalized
      .filter((message) => !backfillMessageIds.has(message.id))
      .slice(-maxMessages)
      .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const mergedChats = { ...(backfill.chats ?? {}), ...updates };
    return {
      ok: true,
      status,
      messages,
      history_pages: historyPages,
      quarantined,
      dirty_reconciled: normalized
        .filter((message) => dirtyByMessageId.has(message.id))
        .map((message) => ({
          key: dirtyByMessageId.get(message.id).key,
          message_id: message.id,
        })),
      backfill: {
        // `chatRows` is empty when the tab answered `probe` but its Chat
        // collection has not populated yet. A bare `.every()` is vacuously true
        // there, which would record a finished backfill that never ran.
        complete:
          request.backfill_disabled === true ||
          (chatRows.length > 0 &&
            chatRows.every((entry) => mergedChats[entry.jid]?.has_more === false)),
        cursor_chat_jid: cursor,
        inventory: chatRows.map((entry) => entry.jid),
        chats: updates,
      },
    };
  }

  async function resolveChat(collections, input) {
    if (input?.self_chat === true) {
      const me = meUser();
      const selfJid = (await canonicalJid(me)).jid;
      let self = null;
      for (const chat of models(collections.Chat)) {
        const candidate = await canonicalJid(modelData(chat).id ?? chat?.id);
        if (candidate.jid === selfJid) {
          self = chat;
          break;
        }
      }
      if (!self) throw new Error("WhatsApp self chat is not loaded");
      return self;
    }
    const requestedJidRaw =
      typeof input?.chat_jid === "string"
        ? input.chat_jid.trim().toLowerCase()
        : null;
    const requestedJid = requestedJidRaw
      ? (await canonicalJid(requestedJidRaw)).jid
      : null;
    const requestedName =
      typeof input?.chat_name === "string"
        ? input.chat_name.trim().toLowerCase()
        : null;
    const matches = [];
    for (const chat of models(collections.Chat)) {
      const row = modelData(chat);
      const jid = (await canonicalJid(row.id ?? chat?.id)).jid;
      const name = String(
        row.name ?? row.formattedTitle ?? row.contact?.name ?? ""
      )
        .trim()
        .toLowerCase();
      if (
        requestedJid
          ? jid === requestedJid
          : requestedName && name === requestedName
      )
        matches.push(chat);
    }
    if (matches.length === 0)
      throw new Error(
        "WhatsApp chat not found; pass an exact canonical chat_jid or exact chat_name"
      );
    if (matches.length > 1)
      throw new Error("WhatsApp chat name is ambiguous; pass chat_jid");
    return matches[0];
  }

  async function waitForPostState(check, label, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    do {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`WhatsApp did not confirm ${label}`);
  }

  async function searchMessages(input) {
    const collections = requireFirst(["WAWebCollections"]);
    const query = String(input?.query ?? "").trim();
    if (!query) throw new Error("query is required");
    const offset = Math.max(0, Number(input?.offset) || 0);
    const requestedLimit = Math.max(
      1,
      Math.min(Number(input?.limit) || 50, 100)
    );
    if (offset >= 100) {
      throw new Error(
        "WhatsApp source search supports only the first 100 matches"
      );
    }
    // A caller keeps the same page size while following cursors. Let the last
    // page shrink to the remaining source window instead of advertising a
    // cursor whose next request would be rejected (for example 60 + 60).
    const limit = Math.min(requestedLimit, 100 - offset);
    // WhatsApp's private FTS API has no offset. Fetch its complete bounded
    // source window before discarding placeholder/system rows; otherwise an
    // invalid raw hit can make a valid page look short or terminal.
    const searchSourceLimit = 100;
    const chatFilter = ["all", "individual", "group"].includes(
      input?.chat_filter
    )
      ? input.chat_filter
      : "all";
    const chat =
      input?.chat_jid || input?.chat_name || input?.self_chat === true
        ? await resolveChat(collections, input)
        : null;
    let scopedChats = chat ? [chat] : undefined;
    if (!chat && chatFilter !== "all") {
      scopedChats = [];
      for (const candidate of models(collections.Chat)) {
        const jid = (
          await canonicalJid(modelData(candidate).id ?? candidate?.id)
        ).jid;
        if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter"))
          continue;
        const isGroup = jid.endsWith("@g.us");
        if (chatFilter === "group" ? isGroup : !isGroup) {
          scopedChats.push(candidate);
        }
      }
    }
    const search = requireFirst([
      "WAWebChatMessageSearch",
      "WAWebMessageSearch",
      "WAWebSearchMessages",
    ]);
    let found = null;
    for (const fn of [
      search?.searchMessages,
      search?.searchMsgs,
      search?.search,
    ]) {
      if (typeof fn !== "function") continue;
      try {
        found = await fn.call(search, query, scopedChats, searchSourceLimit);
        break;
      } catch {
        /* WhatsApp's private module graph throws freely; a miss is not fatal. */
      }
    }
    let source = "whatsapp_fts";
    let candidates = Array.isArray(found)
      ? found
      : models(found?.messages ?? found);
    if (!found) {
      source = "loaded_model_fallback";
      const needle = query.toLowerCase();
      candidates = uniqueMessageModels(collections).filter((model) => {
        const row = modelData(model);
        if (chat) {
          const chatId = widString(modelData(chat).id ?? chat?.id);
          if (widString(row.id?.remote ?? row.chatId) !== chatId) return false;
        }
        return String(row.body ?? row.caption ?? "")
          .toLowerCase()
          .includes(needle);
      });
    }
    const normalized = [];
    const names = nameIndex(collections);
    for (const candidate of candidates) {
      const model = candidate?.msg ?? candidate?.message ?? candidate;
      const message = await normalizeMessage(
        model,
        "search",
        collections,
        names
      );
      // The relay boundary rejects placeholder rows without a stable
      // timestamp. Exclude them before slicing/counting so a page cannot
      // collapse to zero rows after transport and replay the same cursor.
      if (!message || Number(message.timestamp) <= 0) continue;
      if (chatFilter === "group" && !message.is_group) continue;
      if (chatFilter === "individual" && message.is_group) continue;
      normalized.push(message);
      if (normalized.length >= searchSourceLimit) break;
    }
    return {
      source,
      results: normalized.slice(offset, offset + limit),
      // WhatsApp's private search API is deliberately fenced to the first
      // 100 matches. Never advertise a cursor beyond that hard cap.
      hasMore: offset + limit < normalized.length,
    };
  }

  async function draftMessage(input) {
    const collections = requireFirst(["WAWebCollections"]);
    const chat = await resolveChat(collections, input);
    const text = String(input?.text ?? "");
    if (!text.trim()) throw new Error("text is required");
    const draft = {
      body: text,
      timestamp: Math.floor(Date.now() / 1_000),
      type: "chat",
      mentionedJidList: [],
      quotedMsg: null,
    };
    const module = requireFirst(DRAFT_MODULES);
    let applied = false;
    for (const fn of [
      module?.setDraft,
      module?.setChatDraft,
      module?.saveDraft,
    ]) {
      if (typeof fn !== "function") continue;
      try {
        await fn.call(module, chat, draft);
        applied = true;
        break;
      } catch {
        try {
          await fn.call(module, draft, chat);
          applied = true;
          break;
        } catch {
          /* WhatsApp's private module graph throws freely; a miss is not fatal. */
        }
      }
    }
    if (!applied && typeof chat?.setDraft === "function") {
      await chat.setDraft(draft);
      applied = true;
    }
    if (!applied)
      throw new Error(
        "WhatsApp draft capability is unavailable in this web build"
      );
    const stored = modelData(chat).draft ?? chat.get?.("draft") ?? null;
    if (!stored || typeof stored !== "object" || stored.body !== text) {
      throw new Error("WhatsApp rejected the persistent draft shape");
    }
    return {
      drafted: true,
      sent: false,
      chat_jid: widString(modelData(chat).id ?? chat?.id),
      draft,
    };
  }

  async function sendMessage(input) {
    const collections = requireFirst(["WAWebCollections"]);
    const chat = await resolveChat(collections, input);
    const text = String(input?.text ?? "");
    if (!text.trim()) throw new Error("text is required");
    const module = requireFirst(SEND_MODULES);
    // Build the message first when the web build lets us, because the id has
    // to come from the message rather than from the send acknowledgment.
    // `sendTextMsgToChat` resolves to `{ messageSendResult, t, count }` — it
    // carries no id in any form, so deriving one from the ack reported every
    // successful send as a failure, and a caller that retries on failure sent
    // the message twice. `createTextMsgData` mints the id without sending;
    // `addAndSendTextMsg` then delivers under exactly that id.
    if (
      typeof module?.createTextMsgData === "function" &&
      typeof module?.addAndSendTextMsg === "function"
    ) {
      const data = await module.createTextMsgData(chat, text);
      const plannedId = rawId(data?.id);
      if (!plannedId)
        throw new Error("WhatsApp did not assign an id to the outgoing message");
      await module.addAndSendTextMsg(chat, data);
      return {
        sent: true,
        chat_jid: widString(modelData(chat).id ?? chat?.id),
        message_id: plannedId,
      };
    }
    const fn =
      module?.sendTextMsgToChat ?? module?.sendMessage ?? chat?.sendMessage;
    if (typeof fn !== "function")
      throw new Error(
        "WhatsApp send capability is unavailable in this web build"
      );
    const result =
      fn === chat?.sendMessage
        ? await fn.call(chat, text)
        : await fn.call(module, chat, text);
    const messageId = rawId(modelData(result).id ?? result?.id);
    if (!messageId)
      throw new Error("WhatsApp send acknowledgment has no raw message ID");
    return {
      sent: true,
      chat_jid: widString(modelData(chat).id ?? chat?.id),
      message_id: messageId,
    };
  }

  /**
   * Whether WhatsApp currently permits an action on a message.
   *
   * The model used to carry `canEdit` / `canRevoke` booleans. This build
   * carries neither — the predicates moved into `WAWebMsgActionCapability`
   * as functions taking the model. Reading the absent booleans made edit and
   * revoke refuse EVERY message, including ones the UI offers the action for,
   * with a message that blamed WhatsApp rather than the probe.
   *
   * Legacy flags are still consulted first so a build that has them keeps
   * working, and a predicate that throws is not treated as an affirmation.
   */
  function messageActionAllowed(message, predicateNames, legacyFlags) {
    const row = modelData(message);
    for (const flag of legacyFlags) {
      if (row[flag] === true) return true;
    }
    const capability = requireFirst(["WAWebMsgActionCapability"]);
    for (const name of predicateNames) {
      if (typeof capability?.[name] !== "function") continue;
      try {
        if (capability[name](message) === true) return true;
      } catch {
        /* WhatsApp's private module graph throws freely; a miss is not fatal. */
      }
    }
    return false;
  }

  function resolveMessage(collections, id) {
    const raw = String(id ?? "").trim();
    if (!raw) throw new Error("message_id is required");
    const message = collectionByRawId(collections.Msg, raw);
    if (!message)
      throw new Error(
        `WhatsApp message ${raw} is not loaded; sync or search it first`
      );
    return message;
  }

  async function editMessage(input) {
    const collections = requireFirst(["WAWebCollections"]);
    const message = resolveMessage(collections, input?.message_id);
    const before = modelData(message);
    if (!(before.id?.fromMe ?? before.fromMe))
      throw new Error("WhatsApp only permits editing outgoing messages");
    if (
      !messageActionAllowed(
        message,
        // The same pair `sendMessageEdit` itself checks, plus the flow
        // predicate, so a caption edit is not refused before it is tried.
        ["canEditText", "canEditCaption", "canEnterEditingFlow"],
        ["canEdit", "isEditable"]
      )
    )
      throw new Error(
        "WhatsApp did not affirm that this message is currently editable"
      );
    const text = String(input?.text ?? "");
    if (!text.trim()) throw new Error("text is required");
    const module = requireFirst(EDIT_MODULES);
    const fn = module?.sendMessageEdit ?? module?.editMessage ?? message?.edit;
    if (typeof fn !== "function")
      throw new Error(
        "WhatsApp edit capability is unavailable in this web build"
      );
    // `sendMessageEdit(msg, text, options)` — the MESSAGE comes first, not
    // the chat. Passing the chat made WhatsApp's own internal
    // `canEditText(chat)` check fail and reject with "Cannot edit message",
    // an error that reads like the message was ineligible when in fact it
    // was being handed the wrong object.
    await (fn === message?.edit
      ? fn.call(message, text)
      : fn.call(module, message, text, {}));
    await waitForPostState(() => {
      const row = modelData(message);
      return (
        row.body === text &&
        Boolean(row.isEdited || row.editVersion || row.latestEditMsgKey)
      );
    }, "message edit");
    return {
      edited: true,
      message_id: rawId(modelData(message).id ?? message?.id),
    };
  }

  async function reactMessage(input) {
    const collections = requireFirst(["WAWebCollections"]);
    const message = resolveMessage(collections, input?.message_id);
    const emoji = input?.remove ? "" : String(input?.emoji ?? "");
    if (!input?.remove && !emoji)
      throw new Error("emoji is required unless remove=true");
    const module = requireFirst(REACTION_MODULES);
    const fn =
      module?.sendReactionToMsg ?? module?.sendReaction ?? message?.react;
    if (typeof fn !== "function")
      throw new Error(
        "WhatsApp reaction capability is unavailable in this web build"
      );
    await (fn === message?.react
      ? fn.call(message, emoji)
      : fn.call(module, message, emoji));
    // Confirmation has to tolerate a build that exposes no per-message
    // reaction list. This one does not: `row.reactions` is undefined and the
    // ReactionsCollection stays empty, so the list check never became true
    // and a reaction that WAS delivered reported failure — verified live,
    // the parent's `hasReaction` had flipped to true while this threw.
    // Prefer the precise list when a build offers one; fall back to the
    // boolean the model always carries.
    await waitForPostState(() => {
      const row = modelData(message);
      const reactions = normalizeReactions(row);
      if (reactions.length > 0) {
        return input?.remove
          ? !reactions.some((reaction) => reaction.from_me)
          : reactions.some(
              (reaction) => reaction.from_me && reaction.emoji === emoji
            );
      }
      // Adding is observable through `hasReaction`. REMOVING is not: the
      // flag does not clear on this build (verified live — it stayed true
      // after a successful removal), so there is nothing left to observe.
      // Waiting on it would fail every successful removal, which is the very
      // bug this function is meant to avoid.
      return input?.remove ? true : row.hasReaction === true;
    }, "reaction state");
    // Say plainly whether the page confirmed the end state, rather than
    // implying a check that did not happen. A build exposing a reaction list
    // confirms both directions; this one can only confirm an add.
    const confirmed = input?.remove
      ? normalizeReactions(modelData(message)).length > 0
      : true;
    return {
      reacted: true,
      confirmed,
      removed: Boolean(input?.remove),
      emoji: emoji || null,
      message_id: rawId(modelData(message).id ?? message?.id),
    };
  }

  async function revokeMessage(input) {
    const collections = requireFirst(["WAWebCollections"]);
    const message = resolveMessage(collections, input?.message_id);
    const before = modelData(message);
    if (!(before.id?.fromMe ?? before.fromMe))
      throw new Error("WhatsApp only permits revoking outgoing messages");
    // Deliberately NOT `canDeleteMsg`: that is delete-for-me, a different
    // operation. Accepting it would let revoke report success having only
    // removed the message from this device.
    if (
      !messageActionAllowed(
        message,
        ["canSenderRevokeMsg", "canAdminRevokeMsg"],
        ["canRevoke", "isRevokable"]
      )
    )
      throw new Error(
        "WhatsApp did not affirm that this message is currently revokable"
      );
    const module = requireFirst(REVOKE_MODULES);
    const fn =
      module?.sendRevokeMsgs ??
      module?.sendRevoke ??
      module?.revokeMessage ??
      message?.sendRevoke ??
      message?.revoke;
    if (typeof fn !== "function")
      throw new Error(
        "WhatsApp revoke capability is unavailable in this web build"
      );
    if (fn === message?.sendRevoke || fn === message?.revoke)
      await fn.call(message);
    else await fn.call(module, [message], modelData(message).id?.remote);
    await waitForPostState(() => {
      const row = modelData(message);
      return Boolean(row.isRevoked || row.revoked || row.type === "revoked");
    }, "message revoke");
    return {
      revoked: true,
      message_id: rawId(modelData(message).id ?? message?.id),
    };
  }

  async function blobFromMedia(model) {
    const row = modelData(model);
    let result = null;
    if (typeof model?.downloadMedia === "function") {
      result = await model.downloadMedia({
        downloadEvenIfExpensive: true,
        rmrReason: 1,
      });
    }
    result =
      result ??
      modelData(model).mediaData?.mediaBlob ??
      model?.mediaData?.mediaBlob ??
      row.mediaBlob ??
      null;
    if (!result) {
      // The module exports `{ enforceKaleidoscopeScore, downloadManager }` —
      // the method sits on the nested object, so probing the module root only
      // ever found `undefined` and this fallback never ran.
      const managerModule = requireFirst(["WAWebDownloadManager"]);
      const manager = managerModule?.downloadManager ?? managerModule;
      if (typeof manager?.downloadAndMaybeDecrypt === "function") {
        // `downloadQpl` is NOT optional: the very first thing the function
        // does is call `downloadQpl.addAnnotations(...)`, so omitting it threw
        // "Cannot read properties of undefined" before a byte was fetched.
        // It is only WhatsApp's performance logger, so a stub that answers
        // every method with a no-op satisfies it — and a permissive proxy
        // keeps working when a future build calls a method we have not seen
        // (this already happened once: `addAnnotations` alone was not enough,
        // the build also calls `addPoint`).
        result = await manager.downloadAndMaybeDecrypt({
          directPath: row.directPath,
          encFilehash: row.encFilehash,
          filehash: row.filehash,
          mediaKey: row.mediaKey,
          mediaKeyTimestamp: row.mediaKeyTimestamp,
          type: row.type,
          mimetype: row.mimetype,
          downloadOrigin: null,
          partialVideoOpts: null,
          downloadQpl: new Proxy(
            {},
            {
              get: () => () => {
                /* WhatsApp's QPL telemetry; nothing to record here. */
              },
            }
          ),
          signal: new AbortController().signal,
        });
      }
    }
    if (result === "NEED_POKE" || result?.status === "NEED_POKE")
      return { status: "NEED_POKE" };
    const candidate = result?.blob ?? result?.mediaBlob ?? result;
    if (candidate instanceof Blob)
      return { status: "downloaded", blob: candidate };
    // `downloadAndMaybeDecrypt` resolves the decrypted bytes as a raw
    // ArrayBuffer, not a Blob. Falling through to the Blob checks below
    // reported a perfectly good download as `unavailable`.
    if (candidate instanceof ArrayBuffer || ArrayBuffer.isView(candidate))
      return {
        status: "downloaded",
        blob: new Blob([candidate], {
          type: row.mimetype || "application/octet-stream",
        }),
      };
    if (candidate?.getData) {
      const data = await candidate.getData();
      if (data instanceof Blob) return { status: "downloaded", blob: data };
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data))
        return {
          status: "downloaded",
          blob: new Blob([data], { type: row.mimetype }),
        };
    }
    return { status: row.directPath ? "unavailable" : "expired" };
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function downloadMedia(input) {
    const collections = requireFirst(["WAWebCollections"]);
    const model = resolveMessage(collections, input?.message_id);
    const row = modelData(model);
    if (row.isViewOnce || row.viewOnce || row.type === "view_once")
      return { status: "view_once" };
    const limit = Math.max(1, Number(input?.max_bytes) || 1);
    const size = Number(row.size ?? row.fileSize ?? 0);
    if (size > limit) return { status: "too_large", size_bytes: size };
    const isVideo =
      row.type === "video" || String(row.mimetype ?? "").startsWith("video/");
    if (isVideo && size <= 0) {
      return { status: "metadata_only", retryable: true, size_bytes: null };
    }
    // Bound the fetch HERE, where the work happens, so the dispatch always
    // answers. A caller-side timer cannot cancel an in-flight dispatch: it only
    // stops the caller waiting, and the reply then arrives with nobody left to
    // receive it. Racing inside the page is safe — there is no IPC child to
    // outlive — and it turns "too slow" into an ordinary retryable answer.
    const budgetMs = Math.max(0, Number(input?.timeout_ms) || 0);
    let downloaded;
    // Held so a download that wins the race can cancel its own timer. A sync
    // collects several items, and a stray rejecting timer per item would keep
    // firing into the page long after its answer shipped.
    let budgetTimer = null;
    try {
      downloaded = budgetMs
        ? await Promise.race([
            blobFromMedia(model),
            new Promise((_, reject) => {
              budgetTimer = setTimeout(
                () =>
                  reject(
                    Object.assign(
                      new Error("media download exceeded its budget"),
                      { state: "timeout_retryable" }
                    )
                  ),
                budgetMs
              );
            }),
          ])
        : await blobFromMedia(model);
    } catch (error) {
      const detail = String(error);
      const reported = String(error?.state ?? error?.status ?? "");
      const explicit = [
        "NEED_POKE",
        "awaiting_primary_device",
        "view_once",
        "expired",
        "too_large",
        "timeout_retryable",
        "metadata_only",
        "unavailable",
      ].find(
        (state) =>
          reported === state ||
          detail.toLowerCase().includes(state.toLowerCase())
      );
      return {
        status: explicit ?? "unavailable",
        retryable: [
          "NEED_POKE",
          "awaiting_primary_device",
          "timeout_retryable",
          "metadata_only",
          "unavailable",
        ].includes(explicit ?? "unavailable"),
        detail: detail.slice(0, 200),
      };
    } finally {
      if (budgetTimer !== null) clearTimeout(budgetTimer);
    }
    if (!downloaded.blob) return downloaded;
    if (downloaded.blob.size > limit)
      return { status: "too_large", size_bytes: downloaded.blob.size };
    const bytes = new Uint8Array(await downloaded.blob.arrayBuffer());
    if (bytes.length === 0) return { status: "unavailable", detail: "empty" };
    const mime =
      downloaded.blob.type || row.mimetype || "application/octet-stream";
    const kind = mime.startsWith("audio/")
      ? "audio"
      : mime.startsWith("image/")
        ? "image"
        : "file";
    return {
      status: "downloaded",
      attachment: {
        kind,
        filename:
          row.filename ??
          row.fileName ??
          `whatsapp-${rawId(row.id ?? model?.id)}`,
        mime_type: mime,
        data: bytesToBase64(bytes),
        size_bytes: bytes.length,
      },
    };
  }

  async function invoke(request) {
    try {
      if (Number(request?.adapter_version) !== ADAPTER_VERSION) {
        return {
          ok: false,
          error: {
            state: "adapter_mismatch",
            reason: `expected ${ADAPTER_VERSION}`,
          },
        };
      }
      if (request.op === "probe") {
        const status = readiness();
        return status.ready
          ? { ok: true, status, capabilities: operationCapabilities() }
          : { ok: false, error: status };
      }
      const capabilities = operationCapabilities();
      if (capabilities[request.op] !== true) {
        return {
          ok: false,
          error: {
            state: "capability_unavailable",
            reason: `${request.op} is unavailable in this WhatsApp Web build`,
          },
        };
      }
      if (request.op === "collect") return await collect(request);
      if (request.op === "download_media")
        return { ok: true, ...(await downloadMedia(request)) };
      if (request.op === "search_messages")
        return { ok: true, ...(await searchMessages(request.input)) };
      if (request.op === "draft_message")
        return { ok: true, ...(await draftMessage(request.input)) };
      if (request.op === "send_message")
        return { ok: true, ...(await sendMessage(request.input)) };
      if (request.op === "edit_message")
        return { ok: true, ...(await editMessage(request.input)) };
      if (request.op === "react_message")
        return { ok: true, ...(await reactMessage(request.input)) };
      if (request.op === "revoke_message")
        return { ok: true, ...(await revokeMessage(request.input)) };
      return {
        ok: false,
        error: { state: "unsupported_operation", reason: String(request?.op) },
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          state: "operation_failed",
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  globalThis[GLOBAL_KEY] = { version: ADAPTER_VERSION, invoke };
}
