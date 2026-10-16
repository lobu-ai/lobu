/**
 * WhatsApp Web MAIN-world adapter.
 *
 * Ported from the Owletto extension's whatsapp-web-main-v1.js. WhatsApp's
 * normalization and action code retain the extension implementation; the
 * connector-owned feed listener below observes new messages and emits
 * references only (never content) through the generic browser transport. It
 * reaches into WhatsApp's own module registry via window.require; those private
 * module shapes are load-bearing.
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
  // Bumped whenever the program changes at all, not only its RPC surface.
  // A WhatsApp tab outlives a deploy, so the resident adapter is replaced only
  // when this number moves: shipping a fix under the old number leaves every
  // already-open tab running the previous code with nothing to show for it.
  // Keep in lockstep with WHATSAPP_ADAPTER_VERSION in whatsapp-web-helpers.ts.
  const ADAPTER_VERSION = 23;
  const SOURCE_ERROR_ID = "whatsapp-web:source-observation-error";
  const MAX_RECORD_BYTES = 128 * 1024;
  const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
  const MAX_BUFFER_ENTRIES = 10_000;
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
  existing?.detach?.();
  const listeners = new Map();

  function detach(bindingId) {
    const selected = bindingId ? [listeners.get(bindingId)] : [...listeners.values()];
    for (const state of selected) {
      if (!state) continue;
      state.collection.off("add", state.onAdd);
      state.collection.off("change", state.onChange);
      window.removeEventListener("message", state.onReply);
      listeners.delete(state.id);
    }
  }

  function listen(request) {
    const collection = requireFirst(["WAWebCollections"])?.Msg;
    if (typeof collection?.on !== "function" || typeof collection?.off !== "function") {
      throw new Error("WhatsApp message observation is unavailable in this build");
    }
    if (!request.bridge_id || !request.token) throw new Error("A feed bridge is required");
    const post = (state, entry) => window.postMessage({
      type: "lobu-feed-record", token: state.token,
      sequence: entry.sequence, record: entry.record,
    }, location.origin);
    const reportError = (state, message, sequence = ++state.sequence) => {
      state.error = message;
      // The transport is connector-agnostic. Persist this connector-owned
      // marker like any other record so the same path wakes a manual feed.
      post(state, {
        sequence,
        record: {
          id: SOURCE_ERROR_ID,
          source_error: message,
        },
      });
    };
    const resident = listeners.get(request.bridge_id);
    const previous = resident?.request.chat_filter === request.chat_filter
      && resident?.request.minimum_timestamp === request.minimum_timestamp ? resident : null;
    detach(request.bridge_id);
    // A new listener identity fences pending normalization from the detached
    // handlers. Keep unaccepted records only within the same source scope, and
    // retry transient failures by attaching fresh handlers to the collection.
    const state = {
      ...(previous ?? {
      id: request.bridge_id, collection, sequence: 0,
      pending: new Map(), fingerprints: new Map(),
      pendingBytes: 0, fingerprintBytes: 0, error: null,
      }),
      collection, error: null,
    };
    state.token = request.token;
    state.request = request;
    state.post = (entry) => post(state, entry);
    const observe = (model, kind) => {
      if (state.error) return;
      const sequence = ++state.sequence;
      // A throwing model getter must reach the error record below, not escape
      // the collection handler, so the reference is read inside the promise.
      void new Promise((resolve) => resolve(messageReference(model))).then((record) => {
        if (listeners.get(state.id) !== state || !record || record.timestamp <= 0) return;
        if (state.request.chat_filter === "group" && !record.is_group) return;
        if (state.request.chat_filter === "individual" && record.is_group) return;
        if (state.request.minimum_timestamp != null && record.timestamp < state.request.minimum_timestamp) return;
        // Loading historical models also emits add. A change still passes: a
        // placeholder that hydrates after subscription start is a new message.
        if (kind === "add" && record.timestamp < state.request.recent_since) return;
        record = {
          id: record.id,
          events: [{ id: record.id, event_type: "message.created", resource_ref: record.id,
            resource_type: "message", occurred_at: new Date(record.timestamp * 1000).toISOString() }],
        };
        const previous = state.pending.get(record.id);
        const seen = state.fingerprints.get(record.id);
        if (seen && seen.sequence >= sequence) return;
        const fingerprint = JSON.stringify(record);
        if (seen?.fingerprint === fingerprint) { seen.sequence = sequence; return; }
        const bytes = new TextEncoder().encode(fingerprint).length;
        if (bytes > MAX_RECORD_BYTES || state.pendingBytes - (previous?.bytes ?? 0) + bytes > MAX_BUFFER_BYTES ||
          (state.pending.size >= MAX_BUFFER_ENTRIES && !previous)) {
          reportError(state, "WhatsApp page observation buffer overflowed; recovery is required", sequence);
          return;
        }
        const entry = { sequence, record, bytes };
        state.pendingBytes += bytes - (previous?.bytes ?? 0);
        state.pending.set(record.id, entry);
        state.fingerprintBytes += bytes - (seen?.bytes ?? 0);
        state.fingerprints.delete(record.id);
        state.fingerprints.set(record.id, { fingerprint, sequence, bytes });
        while (state.fingerprints.size > MAX_BUFFER_ENTRIES || state.fingerprintBytes > MAX_BUFFER_BYTES) {
          const oldest = state.fingerprints.keys().next().value;
          state.fingerprintBytes -= state.fingerprints.get(oldest).bytes;
          state.fingerprints.delete(oldest);
        }
        post(state, entry);
      }).catch(() => {
        if (listeners.get(state.id) !== state) return;
        reportError(state, "WhatsApp source observation failed; recovery is required", sequence);
      });
    };
    state.onAdd = (model) => observe(model, "add");
    state.onChange = (model) => observe(model, "change");
    state.onReply = (event) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.token !== state.token) return;
      if (event.data.type === "lobu-feed-record:stop") { detach(state.id); return; }
      if (event.data.type !== "lobu-feed-record:ack") return;
      for (const [id, entry] of state.pending) {
        if (entry.sequence !== event.data.sequence) continue;
        if (event.data.ok) {
          state.pendingBytes -= entry.bytes; state.pending.delete(id); entry.resolve?.();
        } else entry.reject?.(new Error("Browser rejected the source reference batch"));
        break;
      }
    };
    listeners.set(state.id, state);
    try {
      collection.on("add", state.onAdd);
      collection.on("change", state.onChange);
      window.addEventListener("message", state.onReply);
    } catch (error) {
      reportError(state, "WhatsApp source observation failed; recovery is required");
      throw error;
    }
    // Repost the failure under the fresh token. The durable bridge retains it
    // until a successful connector checkpoint acknowledges its exact revision.
    if (previous?.error) post(state, {
      sequence: ++state.sequence,
      record: { id: SOURCE_ERROR_ID, source_error: previous.error },
    });
    for (const entry of state.pending.values()) post(state, entry);
    return { ok: true, listening: true };
  }

  // Replay shares the live listener's durable browser buffer. Await its receipt,
  // not server delivery: the server advances the cursor only with its own commit.
  async function publishChanges(request) {
    const state = listeners.get(request.bridge_id);
    if (!state || state.token !== request.token) throw new Error("Source listener is unavailable");
    const record = request.batch;
    const bytes = new TextEncoder().encode(JSON.stringify(record)).length;
    const previous = state.pending.get(record.id);
    if (bytes > MAX_RECORD_BYTES || state.pendingBytes - (previous?.bytes ?? 0) + bytes > MAX_BUFFER_BYTES ||
      (state.pending.size >= MAX_BUFFER_ENTRIES && !previous)) throw new Error("Source replay buffer is full");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Source replay was not accepted by the browser")), 10_000);
      const entry = { record, bytes, sequence: ++state.sequence,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); } };
      state.pendingBytes += bytes - (previous?.bytes ?? 0);
      state.pending.set(record.id, entry);
      state.post(entry);
    });
    return { ok: true };
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

  function messageReference(model) {
    const row = modelData(model);
    const key = row.id ?? model?.id;
    const id = rawId(key);
    const remote = widString(key?.remote ?? row.chatId ?? (key?.fromMe ? row.to : row.from));
    if (!id || !remote || remote === "status@broadcast" || remote.endsWith("@newsletter") || SYSTEM_TYPES.has(row.type)) return null;
    return { id, timestamp: unixSeconds(row), is_group: remote.endsWith("@g.us") };
  }

  /** Resume insertion order after reconnect without exporting any message body. */
  async function observeMessages(input = {}) {
    const after = input.after ?? null;
    if (after !== null && (!Number.isSafeInteger(after) || after < 0)) throw new Error("Invalid WhatsApp observation cursor");
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("model-storage");
      request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error("WhatsApp source history database is unavailable")); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("WhatsApp source history database is blocked"));
      request.onsuccess = () => resolve(request.result);
    });
    let rows;
    try {
      rows = await new Promise((resolve, reject) => {
        const transaction = database.transaction("message", "readonly");
        transaction.onabort = () => reject(transaction.error ?? new Error("WhatsApp source observation aborted"));
        const index = transaction.objectStore("message").index("rowId");
        const request = index.openCursor(after === null ? null : IDBKeyRange.lowerBound(after, true), after === null ? "prev" : "next");
        const page = [];
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(page); return; }
          if (!Number.isSafeInteger(cursor.key) || cursor.key <= 0 || typeof cursor.value.id !== "string") {
            reject(new Error("WhatsApp source history has an unsupported key layout")); return;
          }
          page.push({ position: cursor.key, id: cursor.value.id, timestamp: unixSeconds(cursor.value), type: cursor.value.type });
          if (after === null || page.length > 500) resolve(page);
          else cursor.continue();
        };
      });
    } finally { database.close(); }
    if (after === null) return { after: rows[0]?.position ?? 0, references: [], hasMore: false };
    const page = rows.slice(0, 500);
    const references = [];
    if (page.length) {
      const keys = requireFirst(["WAWebMsgKey"]);
      if (typeof keys?.fromString !== "function") throw new Error("WhatsApp source message keys are unavailable");
      for (const row of page) {
        // IndexedDB already contains routing and time metadata. Loading message
        // models would hydrate private content and fails for status entries.
        const reference = messageReference({ id: keys.fromString(row.id), t: row.timestamp, type: row.type });
        if (!reference) continue;
        // Timestamp-zero rows are source placeholders, not messages. A later
        // hydration change is also observed by the reference listener.
        if (reference.timestamp <= 0) continue;
        if (reference.timestamp < input.started_at) continue;
        if (input.chat_filter === "group" && !reference.is_group) continue;
        if (input.chat_filter === "individual" && reference.is_group) continue;
        references.push(reference);
      }
    }
    return { after: page[page.length - 1]?.position ?? after, references, hasMore: rows.length > 500 };
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
   * Build name lookups once per read or search so normalizing each message
   * does not rescan every chat and contact. Nothing here outlives the call.
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
    // Reads and searches share one name index across their result batch.
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
    // Verified on WhatsApp Web (2026-09-10): Socket.state was CONNECTED while
    // Socket.stream was DISCONNECTED, then both were CONNECTED after reload.
    // Current WhatsApp exposes account and transport state separately. An
    // authenticated account can retain hydrated stores while its stream is
    // disconnected; those cached messages are not a successful live read.
    const socket = requireFirst(["WAWebSocketModel"])?.Socket;
    const connection =
      socket ??
      requireFirst(["WAWebSocketState", "WAWebConn", "WAWebConnectionState"]);
    const connectionState = String(
      connection?.getSocketState?.() ??
        connection?.state ??
        connection?.socketState ??
        ""
    ).toLowerCase();
    if (!connectionState) {
      return {
        ready: false,
        state: "capability_unavailable",
        reason: "connection_state_unavailable",
      };
    }
    if (!/^(connected|open|ready|syncing)$/.test(connectionState)) {
      return {
        ready: false,
        state: "not_ready",
        reason: `connection_${connectionState}`,
      };
    }
    if (socket) {
      const stream = String(socket.stream ?? "").toLowerCase();
      if (!stream) {
        return {
          ready: false,
          state: "capability_unavailable",
          reason: "stream_state_unavailable",
        };
      }
      if (!/^(connected|open|ready)$/.test(stream)) {
        return { ready: false, state: "not_ready", reason: `stream_${stream}` };
      }
      if (socket.hasSynced === false) {
        return {
          ready: false,
          state: "hydrating",
          reason: "initial_sync_incomplete",
        };
      }
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
    const hasFunction = (module, names) =>
      names.some((name) => typeof module?.[name] === "function");
    return {
      read_messages:
        typeof indexedDB !== "undefined" &&
        typeof requireFirst(["WAWebMsgKey"])?.fromString === "function" &&
        typeof requireFirst(["WAWebCollections"])?.Msg?.getMessagesById === "function",
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

  /**
   * Enumerate WhatsApp's own local history, not just the models loaded in the
   * page. Opaque message bodies stay with WhatsApp: its native loader hydrates
   * the selected keys. Each read scans at most one source page, so callers must
   * follow cursors even when filtering leaves an empty page. An exact
   * `id:<message ID>` read is the exception: ids are unique, so it walks
   * history until that message and answers in one read.
   */
  async function readMessages(input = {}) {
    const query = String(input.query ?? "").trim();
    const chatFilter = input.chat_filter ?? "all";
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(input.limit) || 50)));
    let before = null;
    if (input.cursor) {
      const cursor = JSON.parse(input.cursor);
      if (cursor.v !== 1 || !Number.isSafeInteger(cursor.before) || cursor.before <= 0 ||
        cursor.query !== query || cursor.chat_filter !== chatFilter) {
        throw new Error("Invalid WhatsApp source cursor or changed query scope");
      }
      before = cursor.before;
    }
    const keyModule = requireFirst(["WAWebMsgKey"]);
    const exactId = query.startsWith("id:") ? query.slice(3) : null;
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("model-storage");
      // Never create an empty replacement database when WhatsApp changes its
      // storage layout. That would turn unavailable history into false success.
      request.onupgradeneeded = () => {
        request.transaction.abort();
        reject(new Error("WhatsApp source history database is unavailable"));
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("WhatsApp source history database is blocked"));
      request.onsuccess = () => resolve(request.result);
    });
    let sourceRows;
    try {
      sourceRows = await new Promise((resolve, reject) => {
        const transaction = database.transaction("message", "readonly");
        transaction.onabort = () => reject(transaction.error ?? new Error("WhatsApp source read aborted"));
        const index = transaction.objectStore("message").index("rowId");
        const range = before === null ? null : IDBKeyRange.upperBound(before, true);
        const request = index.openCursor(range, "prev");
        const rows = [];
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { resolve(rows); return; }
          if (!Number.isSafeInteger(cursor.key) || cursor.key <= 0 || typeof cursor.value.id !== "string") {
            reject(new Error("WhatsApp source history has an unsupported key layout"));
            return;
          }
          if (exactId !== null) {
            if (keyModule.fromString(cursor.value.id).id !== exactId) { cursor.continue(); return; }
            resolve([{ position: cursor.key, id: cursor.value.id }]);
            return;
          }
          rows.push({ position: cursor.key, id: cursor.value.id });
          if (rows.length > limit) resolve(rows);
          else cursor.continue();
        };
      });
    } finally {
      database.close();
    }
    const hasMore = sourceRows.length > limit;
    const page = sourceRows.slice(0, limit);
    const collections = requireFirst(["WAWebCollections"]);
    const selected = page.filter((row) => {
      const key = keyModule.fromString(row.id);
      if (exactId !== null && key.id !== exactId) return false;
      const remote = widString(key.remote);
      if (remote === "status@broadcast" || remote.endsWith("@newsletter")) return false;
      const isGroup = remote.endsWith("@g.us");
      return !(chatFilter === "group" && !isGroup) && !(chatFilter === "individual" && isGroup);
    });
    const results = [];
    if (selected.length) {
      const loaded = await collections.Msg.getMessagesById(selected.map((row) => row.id));
      if (loaded?.canceled || !Array.isArray(loaded?.messages)) {
        throw new Error("Source message loading was canceled or unavailable");
      }
      const byKey = new Map(loaded.messages.map((model) => [String(model.id ?? modelData(model).id), model]));
      const names = nameIndex(collections);
      for (const row of selected) {
        const model = byKey.get(row.id);
        if (!model) throw new Error("Source message could not be loaded; retry the read");
        const message = await normalizeMessage(model, "snapshot", collections, names);
        // The relay boundary drops placeholder rows without a stable timestamp.
        // Skip them like search does; throwing would pin every later read to
        // the same cursor.
        if (!message || message.timestamp <= 0) continue;
        if (exactId === null && query && !`${message.body}\n${message.caption}`.toLowerCase().includes(query.toLowerCase())) continue;
        results.push(message);
      }
    }
    return {
      results,
      hasMore,
      ...(hasMore ? { nextCursor: JSON.stringify({ v: 1, before: page[page.length - 1].position, query, chat_filter: chatFilter }) } : {}),
    };
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
        `WhatsApp message ${raw} is not loaded; read it with id:${raw} from the live messages feed or search it first`
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
      if (request.op === "account_identity") {
        const accountId = widString(meUser());
        return accountId ? { accountId } : null;
      }
      if (request.op === "probe") {
        const status = readiness();
        return status.ready
          ? { ok: true, status, capabilities: operationCapabilities() }
          : { ok: false, error: status };
      }
      if (request.op === "listen") return listen(request);
      if (request.op === "publish_changes") return await publishChanges(request);
      if (request.op === "observe_messages") return { ok: true, ...(await observeMessages(request.input)) };
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
      if (request.op === "read_messages")
        return { ok: true, ...(await readMessages(request.input)) };
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

  globalThis[GLOBAL_KEY] = { version: ADAPTER_VERSION, invoke, detach };
}
