/** Serialized into the signed-in page. All bindings must remain inside this function. */
export function linkedInInboxProgram() {
  const key = "__lobuLinkedInInboxV1";
  // An identical program keeps a warm tab's listeners; any code change reinstalls
  // and asks the replaced program's listeners to reattach.
  const version = linkedInInboxProgram.toString();
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
      // Extract JSON as text; the live page strips scripts during DOM parsing.
      // This is not an HTML sanitizer: nothing is rendered or
      // executed. Honor quoted attributes and whitespace on closing tags.
      const assignment = [
        ...html.matchAll(
          /<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script\b[^>]*>/gi
        ),
      ]
        .map((match) => match[1].trimStart())
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
    const thread = conversation.slice(
      `urn:li:msg_conversation:(${mailbox},`.length,
      -1
    );
    if (!/^[A-Za-z0-9_-]+=*$/.test(thread))
      fail("Unsupported conversation URL identity");
    const result = await graph(
      "messengerMessages.5846eeb71c981f11e0134cb6626cc314",
      `conversationUrn:${encode(conversation)}`,
      "messengerMessagesBySyncToken"
    );
    const messages = await Promise.all(
      result.elements.map(async (message) => {
        if (
          typeof message.entityUrn !== "string" ||
          !Number.isFinite(message.deliveredAt)
        )
          fail("Message identity or timestamp is unavailable");
        const member = message.sender?.participantType?.member;
        const recalled = message.messageBodyRenderFormat === "RECALLED";
        return {
          id: message.entityUrn,
          conversation_id: conversation,
          // LinkedIn's router retains base64 padding in its canonical URL.
          // Encoding '=' here leaves page-activated drafts waiting on a URL
          // that differs from the one the user actually visits.
          conversation_url: `https://www.linkedin.com/messaging/thread/${thread}/`,
          text: recalled
            ? ""
            : (message.body?.text ?? message.renderContentFallbackText ?? ""),
          recalled,
          source_revision: await digest(
            JSON.stringify([
              message.entityUrn,
              conversation,
              message.body,
              message.renderContentFallbackText,
              message.renderContent,
              message.messageBodyRenderFormat,
              message.sender?.hostIdentityUrn,
              message.deliveredAt,
              message.lastEditedAt,
            ])
          ),
          has_attachments:
            Array.isArray(message.renderContent) &&
            message.renderContent.length > 0,
          sender_id: message.sender?.hostIdentityUrn ?? null,
          sender_name: clean(
            `${member?.firstName?.text ?? ""} ${member?.lastName?.text ?? ""}`
          ),
          from_me:
            typeof message.sender?.hostIdentityUrn === "string"
              ? message.sender.hostIdentityUrn === mailbox
              : null,
          occurred_at: new Date(message.deliveredAt).toISOString(),
        };
      })
    );
    return messages.sort(
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
  // Resumes a source page after the cursor's last returned row.
  function resume(rows, cursor, limit, source) {
    const start = cursor.after
      ? rows.findIndex((row) => row.id === cursor.after) + 1
      : 0;
    if (cursor.after && !start)
      fail(`${source} cursor expired; restart the read`);
    const page = rows.slice(start, start + limit);
    return { rows: page, more: start + limit < rows.length };
  }
  async function readNotifications(cursor, limit) {
    const source = await notificationsPage(cursor.page);
    const { rows, more } = resume(source.rows, cursor, limit, "Notification");
    const continuation = more
      ? { page: cursor.page, after: rows.at(-1).id }
      : source.next
        ? { page: pagePayload(source.next) }
        : null;
    return { rows, continuation };
  }
  // Pages conversations, then each conversation's recent message page.
  async function readMessages(cursor, limit, mailbox) {
    let threads = cursor.threads;
    let next = cursor.next;
    if (!threads) {
      const source = await conversationsPage(mailbox, cursor.page);
      threads = source.elements.map((thread) => thread.entityUrn);
      next = source.metadata?.nextCursor;
    }
    if (!Array.isArray(threads) || threads.length > 20)
      fail("Invalid message cursor");
    const messages = threads.length
      ? await messagesPage(threads[0], mailbox)
      : [];
    const { rows, more } = resume(messages, cursor, limit, "Message");
    const continuation = more
      ? { threads, next, after: rows.at(-1).id }
      : threads.length > 1
        ? { threads: threads.slice(1), next }
        : next
          ? { page: next }
          : null;
    return { rows, continuation };
  }
  async function read(input) {
    const mailbox = await account();
    const cursor = cursorOf(input.cursor, input.feed, mailbox);
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const { rows, continuation } =
      input.feed === "notifications"
        ? await readNotifications(cursor, limit)
        : input.feed === "live_messages"
          ? await readMessages(cursor, limit, mailbox)
          : fail("Unknown source feed");
    if ((await account()) !== mailbox)
      fail("LinkedIn account changed during the read");
    return {
      rows: await Promise.all(
        rows.map(async (row) => ({
          ...row,
          source_revision:
            row.source_revision ??
            (await digest(
              JSON.stringify([row.id, row.text, row.url, row.notification_type])
            )),
        }))
      ),
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
  // One observation pass is bounded source work. Message catch-up resumes from
  // its checkpoint; notifications reorder at the top and report a gap instead.
  const NOTIFICATION_PAGES_PER_PASS = 10;
  const CONVERSATION_PAGES_PER_PASS = 2;
  const RECENT_MESSAGE_PAGE = 20;
  const SEEN_LIMIT = 256;
  const BATCH_EVENTS = 500;
  const BATCH_BYTES = 128 * 1024;
  // Each observer returns its checkpoint position, plus `more` when the round
  // continues on the next pass.
  async function observeNotifications({ previous, observe, gap }) {
    let payload;
    for (let page = 1; ; page++) {
      const { rows, next } = await notificationsPage(payload);
      let anchored = false;
      for (const row of rows) {
        if (
          await observe(
            row,
            "notification.changed",
            "notification",
            row.revision
          )
        )
          anchored = true;
      }
      if (!previous || anchored || !next) break;
      if (page === NOTIFICATION_PAGES_PER_PASS) {
        await gap(
          "notification",
          "https://www.linkedin.com/notifications/",
          rows.at(-1)?.id ?? page
        );
        break;
      }
      payload = next;
    }
    // `seen` is the whole position: an unchanged inbox repeats its checkpoint.
    return {};
  }
  async function catchUpConversation(
    { previous, observe, gap },
    thread,
    round,
    mailbox
  ) {
    const messages = await messagesPage(thread.entityUrn, mailbox);
    let reachedSeen = false;
    for (const row of messages) {
      if (Date.parse(row.occurred_at) < round.floor) continue;
      if (await observe(row, "message.created", "message")) reachedSeen = true;
    }
    const oldest = messages.at(-1);
    // A full recent page that neither reaches the floor nor a message already
    // observed may hide older arrivals. LinkedIn offers no further page here,
    // so report the gap and continue.
    if (
      previous &&
      messages.length >= RECENT_MESSAGE_PAGE &&
      !reachedSeen &&
      Date.parse(oldest.occurred_at) >= round.floor
    ) {
      await gap(
        "conversation",
        thread.entityUrn,
        oldest.id,
        oldest.occurred_at
      );
    }
  }
  async function catchUpMessages(pass, mailbox) {
    const { previous, observedAt } = pass;
    const startedAt = previous?.started_at ?? observedAt;
    // A round reads threads active since `since` and their messages since
    // `floor`. A round that spans passes keeps its lower bounds, and the next
    // round keeps its floor: a thread that moved above the resume cursor is
    // then read again from the top with the earlier floor.
    const round = previous?.round ?? {
      since: previous
        ? Math.max(startedAt, previous.after - 60000)
        : observedAt,
      until: observedAt,
      floor: previous?.floor ?? observedAt,
      cursor: null,
    };
    round.floor = Math.min(round.floor, round.since);
    let cursor = round.cursor;
    for (let page = 1; ; page++) {
      const result = await conversationsPage(mailbox, cursor);
      const active = result.elements.filter((thread) => {
        if (!Number.isFinite(thread.lastActivityAt))
          fail("Conversation activity is unavailable");
        return thread.lastActivityAt >= round.since;
      });
      for (const thread of active)
        await catchUpConversation(pass, thread, round, mailbox);
      const next =
        active.length === result.elements.length
          ? (result.metadata?.nextCursor ?? null)
          : null;
      if (next !== null && (typeof next !== "string" || next.length > 4096))
        fail("Invalid conversation cursor");
      if (!previous || next === null) break;
      cursor = next;
      if (page === CONVERSATION_PAGES_PER_PASS) {
        return {
          started_at: startedAt,
          after: previous.after,
          floor: previous.floor,
          round: { ...round, cursor },
          more: true,
        };
      }
    }
    return {
      started_at: startedAt,
      after: round.until,
      floor: previous?.round ? round.floor : round.since,
    };
  }
  async function snapshot(feed, previous, mailbox) {
    const observedAt = Date.now();
    const observed = new Map();
    const events = [];
    // Returns whether the previous checkpoint already held this identity.
    async function observe(row, eventType, resourceType, revisionText) {
      const identity = await digest(row.id);
      const revision =
        revisionText === undefined ? identity : await digest(revisionText);
      const prior = previous?.seen[identity];
      if (previous && prior !== revision && !observed.has(identity)) {
        events.push({
          id: `${identity}:${revision}`,
          event_type: eventType,
          resource_type: resourceType,
          resource_ref: row.id,
          occurred_at: row.occurred_at ?? new Date(observedAt).toISOString(),
        });
      }
      observed.set(identity, revision);
      return prior !== undefined;
    }
    // The provider cannot show what lies beyond this position. Report it once
    // per position and advance, rather than retrying or claiming completeness.
    async function gap(resourceType, resourceRef, beyond, occurredAt) {
      events.push({
        id: `gap:${await digest(JSON.stringify([resourceRef, beyond]))}`,
        event_type: "source.gap",
        resource_type: resourceType,
        resource_ref: resourceRef,
        occurred_at: occurredAt ?? new Date(observedAt).toISOString(),
      });
    }
    const pass = { previous, observedAt, observe, gap };
    const { more = false, ...position } =
      feed === "notifications"
        ? await observeNotifications(pass)
        : await catchUpMessages(pass, mailbox);
    if ((await account()) !== mailbox)
      fail("LinkedIn account changed during observation");
    const checkpoint = {
      feed,
      account: mailbox,
      ...position,
      // Keep this pass's identities first, in source order, then older ones.
      seen: Object.fromEntries(
        [
          ...observed,
          ...Object.entries(previous?.seen ?? {}).filter(
            ([identity]) => !observed.has(identity)
          ),
        ].slice(0, SEEN_LIMIT)
      ),
    };
    return { checkpoint, events, more };
  }
  // Ordered batches of at most 500 references and 128 KiB. Only the final
  // batch carries the checkpoint, so an interruption cannot skip references.
  async function batchesOf(feed, previous, result) {
    const next = { linkedin_inbox: result.checkpoint };
    const { events } = result;
    const base = `${feed}:${await digest(JSON.stringify([previous, next, events]))}`;
    const size = (batch) =>
      new TextEncoder().encode(JSON.stringify(batch)).length;
    const batches = [];
    for (let offset = 0; ; ) {
      const through = (end) => ({
        id: `${base}:${offset}`,
        events: events.slice(offset, end),
        ...(end === events.length
          ? { checkpoint: { previous, next }, more: result.more }
          : {}),
      });
      let end = Math.min(offset + BATCH_EVENTS, events.length);
      let batch = through(end);
      while (size(batch) > BATCH_BYTES && end - offset > 1) {
        end = offset + Math.floor((end - offset) / 2);
        batch = through(end);
      }
      if (size(batch) > BATCH_BYTES)
        fail("Source reference batch exceeds the browser record limit");
      batches.push(batch);
      if (end === events.length) return batches;
      offset = end;
    }
  }
  const active = (listener) => listeners.get(listener.id) === listener;
  function post(listener, record) {
    window.postMessage(
      {
        type: "lobu-feed-record",
        token: listener.token,
        sequence: ++listener.sequence,
        record,
      },
      location.origin
    );
  }
  // The one way a listener ends. A reason asks the bridge to reattach from the
  // durable checkpoint; only an explicit stop or a same-binding relisten is silent.
  function stop(listener, reason) {
    if (!active(listener)) return;
    clearTimeout(listener.timer);
    window.removeEventListener("message", listener.onReply);
    listeners.delete(listener.id);
    if (reason)
      post(listener, {
        id: `linkedin:${listener.feed}:source-observation-error`,
        source_error: reason,
      });
  }
  // Called by a replacing program version: its listeners cannot inherit this
  // one's undelivered batches, so each reattaches instead of going silent.
  function detach() {
    for (const listener of [...listeners.values()])
      stop(
        listener,
        "LinkedIn source program was replaced; reattach from the durable checkpoint"
      );
  }
  // Unacknowledged batches are reposted unchanged on the next tick.
  async function poll(listener) {
    if (!active(listener)) return;
    try {
      if (!listener.batches.length) {
        if ((await account()) !== listener.mailbox)
          fail("LinkedIn account changed; reconnect this source");
        const { feed, checkpoint, mailbox } = listener;
        const result = await snapshot(
          feed,
          checkpoint?.linkedin_inbox,
          mailbox
        );
        listener.batches = await batchesOf(feed, checkpoint, result);
      }
      if (active(listener)) post(listener, listener.batches[0]);
    } catch {
      stop(
        listener,
        "LinkedIn source observation failed; reconnect to recover without skipping changes"
      );
    }
    if (active(listener))
      listener.timer = setTimeout(() => poll(listener), 60000);
  }
  function receive(listener, event) {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.token !== listener.token
    )
      return;
    if (event.data.type === "lobu-feed-record:stop") return stop(listener);
    if (
      event.data.type !== "lobu-feed-record:ack" ||
      event.data.sequence !== listener.sequence
    )
      return;
    if (event.data.ok === false)
      return stop(
        listener,
        "LinkedIn source delivery was rejected; reattach from the durable checkpoint"
      );
    if (event.data.ok && listener.batches.length) {
      // Receipt means the browser durably buffered the batch. Only the server
      // commits the final batch's checkpoint; a reattach starts from that value.
      const done = listener.batches.shift();
      if (done.checkpoint) listener.checkpoint = done.checkpoint.next;
      else post(listener, listener.batches[0]);
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
    const prior = listeners.get(input.bridge_id);
    if (prior) stop(prior);
    const listener = {
      id: input.bridge_id,
      token: input.token,
      feed: input.feed,
      mailbox,
      // The last posted record; only its receipt may advance delivery.
      sequence: 0,
      // The checkpoint the next snapshot starts from, set by the final batch's receipt.
      checkpoint: input.checkpoint ?? null,
      // Undelivered batches of the current snapshot, in order.
      batches: [],
      timer: null,
    };
    listener.onReply = (event) => receive(listener, event);
    listeners.set(listener.id, listener);
    window.addEventListener("message", listener.onReply);
    await poll(listener);
    if (!listeners.has(listener.id))
      fail("Unable to attach source subscription");
    return { listening: true };
  }
  globalThis[key] = { version, read, listen, detach };
}
