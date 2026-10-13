/** Serialized into the signed-in page. All bindings must remain inside this function. */
export function linkedInInboxProgram() {
  const key = "__lobuLinkedInInboxV1";
  const version = 1;
  if (globalThis[key]?.version === version) return;
  globalThis[key]?.detach();
  const listeners = new Map();
  const pagerId = "com.linkedin.sdui.pagers.notificationsList";
  const encode = (value) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    );
  const clean = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  function fail(message) {
    throw new Error(`LinkedIn inbox: ${message}`);
  }
  function headers() {
    const cookie = document.cookie
      .split("; ")
      .find((value) => value.startsWith("JSESSIONID="));
    if (!cookie) fail("Sign in to LinkedIn in the paired browser");
    return {
      "csrf-token": decodeURIComponent(cookie.slice(11)).replace(/^"|"$/g, ""),
      "x-restli-protocol-version": "2.0.0",
    };
  }
  async function request(url, init = {}) {
    const response = await fetch(url, {
      credentials: "include",
      signal: AbortSignal.timeout(20000),
      ...init,
      headers: { ...headers(), ...init.headers },
    });
    if (!response.ok) fail(`Source request failed (HTTP ${response.status})`);
    if (
      response.redirected &&
      /\/login|\/checkpoint|\/authwall/.test(new URL(response.url).pathname)
    ) {
      fail("Sign in to LinkedIn in the paired browser");
    }
    return response;
  }
  async function account() {
    const self = await (await request("/voyager/api/me")).json();
    const urn = self.miniProfile?.entityUrn;
    if (typeof urn !== "string" || !urn.startsWith("urn:li:fs_miniProfile:"))
      fail("Account identity is unavailable");
    return urn.replace("fs_miniProfile", "fsd_profile");
  }
  async function graph(query, variables, collection) {
    const json = await (
      await request(
        `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${query}&variables=(${variables})`
      )
    ).json();
    const result = json.data?.[collection];
    if (!Array.isArray(result?.elements))
      fail("Messaging source format changed");
    return result;
  }
  function decodeFlight(stream) {
    // Flight's T records count UTF-8 bytes, not UTF-16 characters or lines.
    const bytes = new TextEncoder().encode(stream);
    const decoder = new TextDecoder();
    const records = new Map();
    let position = 0;
    while (position < bytes.length) {
      if (bytes[position] === 10) {
        position++;
        continue;
      }
      const colon = bytes.indexOf(58, position);
      if (colon < 0) break;
      const id = decoder.decode(bytes.slice(position, colon));
      if (!/^[0-9a-f]+$/.test(id)) fail("Invalid notification stream record");
      position = colon + 1;
      if (bytes[position] === 84) {
        const comma = bytes.indexOf(44, position);
        const hex = decoder.decode(bytes.slice(position + 1, comma));
        if (comma < 0 || !/^[0-9a-f]+$/.test(hex))
          fail("Invalid notification text record");
        const end = comma + 1 + Number.parseInt(hex, 16);
        if (end > bytes.length) fail("Truncated notification text");
        records.set(id, decoder.decode(bytes.slice(comma + 1, end)));
        position = end;
      } else {
        const newline = bytes.indexOf(10, position);
        const end = newline < 0 ? bytes.length : newline;
        const value = decoder.decode(bytes.slice(position, end));
        if (/^[[{"]/.test(value)) records.set(id, JSON.parse(value));
        position = end + 1;
      }
    }
    return records;
  }
  function parseNotifications(stream) {
    const records = decodeFlight(stream);
    let visits = 0;
    function resolve(value, depth = 0) {
      if (++visits > 250000 || depth > 120)
        fail("Notification structure exceeds the read budget");
      if (typeof value === "string" && /^\$(?:L|Q)?[0-9a-f]+$/.test(value)) {
        const id = value.replace(/^\$(L|Q)?/, "");
        return records.has(id) ? resolve(records.get(id), depth + 1) : null;
      }
      if (Array.isArray(value))
        return value.map((child) => resolve(child, depth + 1));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([name, child]) => [
            name,
            resolve(child, depth + 1),
          ])
        );
      return value;
    }
    function walk(value, callback) {
      if (!value || typeof value !== "object") return;
      callback(value);
      for (const child of Object.values(value)) walk(child, callback);
    }
    function text(value) {
      if (typeof value === "string")
        return value.startsWith("$$")
          ? value.slice(1)
          : value.startsWith("$")
            ? ""
            : value;
      if (!Array.isArray(value)) return "";
      if (value[0] === "$")
        return text(value[3]?.textProps?.children ?? value[3]?.children);
      return value.map(text).join("");
    }
    const rows = new Map();
    let next = null;
    let recognized = false;
    for (const raw of records.values()) {
      if (
        typeof raw === "string" &&
        raw.startsWith(
          '{"$type":"proto.sdui.actions.requests.PaginationRequest"'
        )
      ) {
        const request = JSON.parse(raw);
        if (request.pagerId === pagerId) {
          next = request.requestedArguments?.payload;
          recognized = true;
        }
      }
      if (raw?.[3]?.nextPageRequest?.pagerId === pagerId) {
        next = raw[3].nextPageRequest.requestedArguments?.payload;
        recognized = true;
      }
      if (!Array.isArray(raw) || raw[0]?.[0] !== "Original") continue;
      recognized = true;
      visits = 0;
      const card = resolve(raw[0][1]);
      let id = null;
      let headline = "";
      let url = null;
      let age = null;
      walk(card, (node) => {
        const state = node.selectedStateKey?.key?.value?.id;
        if (
          typeof state === "string" &&
          state.startsWith("NotificationReadState_FeNotificationV2Urn(")
        ) {
          id = state.slice("NotificationReadState_".length);
        }
        const props = node.textProps ?? node;
        if (
          String(props.componentkey ?? props.componentKey ?? "").startsWith(
            "notification-card-headline_"
          )
        ) {
          headline ||= clean(text(props.children));
        }
        const ageText = clean(text(node.textProps?.children));
        if (/^\d+\s*(m|h|d|w|mo|yr)$/.test(ageText)) age ||= ageText;
        if (
          typeof node.url === "string" &&
          node.url.startsWith("https://www.linkedin.com/")
        )
          url ||= node.url;
      });
      if (!id || !headline)
        fail("Notification card identity or headline is unavailable");
      // Unread state, relative age, and per-render tracking IDs are not content changes.
      rows.set(id, {
        id,
        text: headline,
        url: url ?? "https://www.linkedin.com/notifications/",
        notification_type: /notificationType=([^)]*)\)$/.exec(id)?.[1] ?? null,
        occurred_at: null,
        source_age: age,
        revision: headline,
      });
    }
    // A changed layout must not become a successful empty inbox. LinkedIn's
    // known empty-state component is the only permitted zero-card response.
    if (!recognized && !stream.includes("notifications-empty-state"))
      fail("Notification source format changed");
    return { rows: [...rows.values()], next };
  }
  function pagePayload(value) {
    if (
      !value ||
      !Number.isSafeInteger(value.startIndex) ||
      value.startIndex < 0 ||
      value.filterPillType !== "All" ||
      !Array.isArray(value.trackingIdsToDrop) ||
      value.trackingIdsToDrop.length > 1000 ||
      value.trackingIdsToDrop.some(
        (id) =>
          typeof id !== "string" ||
          !id.startsWith("EntityUrn(") ||
          id.length > 2000
      )
    ) {
      fail("Invalid notification cursor");
    }
    return {
      startIndex: value.startIndex,
      filterPillType: "All",
      trackingIdsToDrop: value.trackingIdsToDrop,
    };
  }
  async function notificationsPage(payload) {
    let stream;
    if (payload) {
      const requestedArguments = {
        $type: "proto.sdui.actions.requests.RequestedArguments",
        requestedStateKeys: [],
        payload: pagePayload(payload),
        requestMetadata: { $type: "proto.sdui.common.RequestMetadata" },
      };
      // This one verified pagination action is read-only. Never replay arbitrary
      // actions or headers from the provider response or from a caller's cursor.
      const body = {
        pagerId,
        clientArguments: {
          ...requestedArguments,
          states: [],
          screenId:
            "com.linkedin.sdui.flagshipnav.notifications.NotificationPillType",
          knownTemplateIds: [],
        },
        paginationRequest: {
          $type: "proto.sdui.actions.requests.PaginationRequest",
          pagerId,
          retryCount: 2,
          trigger: {
            $case: "itemDistanceTrigger",
            itemDistanceTrigger: {
              $type: "proto.sdui.actions.requests.ItemDistanceTrigger",
              preloadDistance: 3,
              preloadLength: 250,
            },
          },
          requestedArguments,
        },
      };
      stream = await (
        await request(
          `/flagship-web/rsc-action/actions/pagination?sduiid=${pagerId}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-li-rsc-stream": "true",
            },
            body: JSON.stringify(body),
          }
        )
      ).text();
    } else {
      const html = await (await request("/notifications/")).text();
      const assignment = [
        ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
      ]
        .map((match) => match[1])
        .find((value) => value.startsWith("window.__como_rehydration__"));
      if (!assignment)
        fail("Notification source is unavailable; check sign-in");
      const chunks = JSON.parse(
        assignment
          .slice(assignment.indexOf("=") + 1)
          .trim()
          .replace(/;$/, "")
      );
      if (
        !Array.isArray(chunks) ||
        chunks.some((chunk) => typeof chunk !== "string")
      )
        fail("Invalid notification stream");
      stream = chunks.join("");
    }
    return parseNotifications(stream);
  }
  async function conversationsPage(mailbox, cursor) {
    return graph(
      "messengerConversations.9501074288a12f3ae9e3c7ea243bccbf",
      `query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),count:20,mailboxUrn:${encode(mailbox)}${cursor ? `,nextCursor:${encode(cursor)}` : ""}`,
      "messengerConversationsByCategoryQuery"
    );
  }
  async function messagesPage(conversation, mailbox) {
    if (
      typeof conversation !== "string" ||
      !conversation.startsWith(`urn:li:msg_conversation:(${mailbox},`)
    )
      fail("Invalid conversation identity");
    const result = await graph(
      "messengerMessages.5846eeb71c981f11e0134cb6626cc314",
      `conversationUrn:${encode(conversation)}`,
      "messengerMessagesBySyncToken"
    );
    return result.elements
      .map((message) => {
        if (
          typeof message.entityUrn !== "string" ||
          !Number.isFinite(message.deliveredAt)
        )
          fail("Message identity or timestamp is unavailable");
        const member = message.sender?.participantType?.member;
        const thread = conversation.slice(
          `urn:li:msg_conversation:(${mailbox},`.length,
          -1
        );
        if (!/^[A-Za-z0-9_-]+=*$/.test(thread))
          fail("Unsupported conversation URL identity");
        return {
          id: message.entityUrn,
          conversation_id: conversation,
          // LinkedIn's router retains base64 padding in its canonical URL.
          // Encoding '=' here leaves page-activated drafts waiting on a URL
          // that differs from the one the user actually visits.
          conversation_url: `https://www.linkedin.com/messaging/thread/${thread}/`,
          text: message.body?.text ?? message.renderContentFallbackText ?? "",
          has_attachments:
            Array.isArray(message.renderContent) &&
            message.renderContent.length > 0,
          sender_id: message.sender?.hostIdentityUrn ?? null,
          sender_name: clean(
            `${member?.firstName?.text ?? ""} ${member?.lastName?.text ?? ""}`
          ),
          from_me: message.sender?.hostIdentityUrn === mailbox,
          occurred_at: new Date(message.deliveredAt).toISOString(),
        };
      })
      .sort(
        (a, b) =>
          b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id)
      );
  }
  function cursorOf(raw, feed, mailbox) {
    if (!raw) return {};
    if (typeof raw !== "string" || raw.length > 100000) fail("Invalid cursor");
    const cursor = JSON.parse(raw);
    if (cursor.v !== 1 || cursor.feed !== feed || cursor.account !== mailbox)
      fail("Cursor belongs to a different source or account");
    return cursor;
  }
  async function read(input) {
    const mailbox = await account();
    const cursor = cursorOf(input.cursor, input.feed, mailbox);
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    let rows;
    let continuation;
    if (input.feed === "notifications") {
      const page = await notificationsPage(cursor.page);
      const after = cursor.after
        ? page.rows.findIndex((row) => row.id === cursor.after) + 1
        : 0;
      if (cursor.after && !after)
        fail("Notification cursor expired; restart the read");
      rows = page.rows.slice(after, after + limit);
      continuation =
        after + limit < page.rows.length
          ? { page: cursor.page, after: rows.at(-1).id }
          : page.next
            ? { page: pagePayload(page.next) }
            : null;
    } else if (input.feed === "live_messages") {
      let threads = cursor.threads;
      let next = cursor.next;
      if (!threads) {
        const page = await conversationsPage(mailbox, cursor.page);
        threads = page.elements.map((thread) => thread.entityUrn);
        next = page.metadata?.nextCursor;
      }
      if (!Array.isArray(threads) || threads.length > 20)
        fail("Invalid message cursor");
      if (!threads.length) return { rows: [], hasMore: false };
      const messages = await messagesPage(threads[0], mailbox);
      const after = cursor.after
        ? messages.findIndex((row) => row.id === cursor.after) + 1
        : 0;
      if (cursor.after && !after)
        fail("Message cursor expired; restart the read");
      rows = messages.slice(after, after + limit);
      continuation =
        after + limit < messages.length
          ? { threads, next, after: rows.at(-1).id }
          : threads.length > 1
            ? { threads: threads.slice(1), next }
            : next
              ? { page: next }
              : null;
    } else fail("Unknown source feed");
    if ((await account()) !== mailbox)
      fail("LinkedIn account changed during the read");
    return {
      rows,
      hasMore: !!continuation,
      ...(continuation
        ? {
            nextCursor: JSON.stringify({
              v: 1,
              feed: input.feed,
              account: mailbox,
              ...continuation,
            }),
          }
        : {}),
    };
  }
  async function digest(value) {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    );
    return [...new Uint8Array(bytes)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  async function snapshot(feed, previous, mailbox) {
    const observedAt = Date.now();
    const startedAt = previous
      ? Math.max(previous.started_at, previous.after - 60000)
      : observedAt;
    const seen = { ...(previous?.seen ?? {}) };
    const events = [];
    let cursor;
    let complete = false;
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      let rows;
      let next;
      if (feed === "notifications") {
        const page = await notificationsPage(cursor);
        rows = page.rows;
        next = page.next;
      } else {
        const page = await conversationsPage(mailbox, cursor);
        const active = page.elements.filter(
          (thread) => thread.lastActivityAt >= startedAt
        );
        rows = [];
        for (const thread of active) {
          const messages = await messagesPage(thread.entityUrn, mailbox);
          // A full provider page newer than the checkpoint could hide more
          // arrivals. Surface the gap instead of advancing beyond unseen data.
          if (
            messages.length >= 20 &&
            messages.every((row) => Date.parse(row.occurred_at) >= startedAt)
          ) {
            fail(
              "Message catch-up exceeds the recent source page; recovery is required"
            );
          }
          rows.push(
            ...messages.filter(
              (row) => Date.parse(row.occurred_at) >= startedAt
            )
          );
        }
        next =
          active.length === page.elements.length
            ? page.metadata?.nextCursor
            : null;
      }
      let anchored = false;
      for (const row of rows) {
        const identity = await digest(row.id);
        const revision =
          feed === "notifications" ? await digest(row.revision) : identity;
        if (previous?.seen?.[identity]) anchored = true;
        if (previous && previous.seen[identity] !== revision) {
          events.push({
            id: `${identity}:${revision}`,
            event_type:
              feed === "notifications"
                ? "notification.changed"
                : "message.created",
            resource_type:
              feed === "notifications" ? "notification" : "message",
            resource_ref: row.id,
            occurred_at: row.occurred_at ?? new Date().toISOString(),
          });
        }
        delete seen[identity];
        seen[identity] = revision;
      }
      if (!previous || !next || (feed === "notifications" && anchored)) {
        complete = true;
        break;
      }
      cursor = next;
    }
    if (!complete || events.length > 250)
      fail(
        "Source catch-up exceeds the observation budget; recovery is required"
      );
    if ((await account()) !== mailbox)
      fail("LinkedIn account changed during observation");
    return {
      checkpoint: {
        feed,
        account: mailbox,
        started_at: previous?.started_at ?? startedAt,
        after: observedAt,
        seen: Object.fromEntries(Object.entries(seen).slice(-256)),
      },
      events,
    };
  }
  function detach(id) {
    for (const state of id ? [listeners.get(id)] : listeners.values()) {
      if (!state) continue;
      clearTimeout(state.timer);
      window.removeEventListener("message", state.onReply);
      listeners.delete(state.id);
    }
  }
  async function listen(input) {
    if (!input.bridge_id || !input.token)
      fail("Source subscription binding is required");
    const mailbox = await account();
    const previous = input.checkpoint?.linkedin_inbox;
    if (
      previous &&
      (previous.feed !== input.feed || previous.account !== mailbox)
    )
      fail("Source checkpoint belongs to another account or feed");
    detach(input.bridge_id);
    const state = {
      id: input.bridge_id,
      sequence: 0,
      checkpoint: input.checkpoint ?? null,
      pending: null,
      timer: null,
    };
    const post = (record) =>
      window.postMessage(
        {
          type: "lobu-feed-record",
          token: input.token,
          sequence: ++state.sequence,
          record,
        },
        location.origin
      );
    async function poll() {
      if (listeners.get(state.id) !== state) return;
      try {
        if (!state.pending) {
          if ((await account()) !== mailbox)
            fail("LinkedIn account changed; reconnect this source");
          const result = await snapshot(
            input.feed,
            state.checkpoint?.linkedin_inbox,
            mailbox
          );
          const next = { linkedin_inbox: result.checkpoint };
          state.pending = {
            id: `${input.feed}:${await digest(JSON.stringify([state.checkpoint, next, result.events]))}`,
            events: result.events,
            checkpoint: { previous: state.checkpoint, next },
          };
          if (
            new TextEncoder().encode(JSON.stringify(state.pending)).length >
            128 * 1024
          )
            fail("Source reference batch exceeds the browser record limit");
        }
        if (listeners.get(state.id) === state) post(state.pending);
      } catch {
        if (listeners.get(state.id) === state) {
          post({
            id: `linkedin:${input.feed}:source-observation-error`,
            source_error:
              "LinkedIn source observation failed; reconnect to recover without skipping changes",
          });
          detach(state.id);
        }
      }
      if (listeners.get(state.id) === state)
        state.timer = setTimeout(poll, 60000);
    }
    state.onReply = (event) => {
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        event.data?.token !== input.token
      )
        return;
      if (event.data.type === "lobu-feed-record:stop") {
        detach(state.id);
        return;
      }
      if (
        event.data.type !== "lobu-feed-record:ack" ||
        event.data.sequence !== state.sequence
      )
        return;
      if (event.data.ok && state.pending) {
        // Receipt means the browser durably buffered the batch. Only the server
        // commits this checkpoint; a reattach starts from that server value.
        state.checkpoint = state.pending.checkpoint.next;
        state.pending = null;
      } else if (event.data.ok === false) {
        post({
          id: `linkedin:${input.feed}:source-observation-error`,
          source_error:
            "LinkedIn source delivery was rejected; reattach from the durable checkpoint",
        });
        detach(state.id);
      }
    };
    listeners.set(state.id, state);
    window.addEventListener("message", state.onReply);
    await poll();
    if (!listeners.has(state.id)) fail("Unable to attach source subscription");
    return { listening: true };
  }
  globalThis[key] = { version, read, listen, detach, parseNotifications };
}
