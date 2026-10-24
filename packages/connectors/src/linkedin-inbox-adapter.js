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
  // `denied` names what a 401/403 means for this request, when it means more
  // than a failed request.
  async function request(url, init = {}, denied = null) {
    const response = await fetch(url, {
      credentials: "include",
      signal: AbortSignal.timeout(20000),
      ...init,
      headers: { ...headers(), ...init.headers },
    });
    if (denied && (response.status === 401 || response.status === 403))
      fail(denied);
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
  const PAGE_MAILBOX = /^urn:li:fsd_pageMailbox:[0-9]+$/;
  const NOT_ADMIN =
    "The signed-in LinkedIn account does not administer this page inbox";
  // The page's own inbox answers its admins only: LinkedIn's page inbox reads
  // these counts first, and a non-admin is refused.
  async function assertAdministers(mailbox) {
    const json = await (
      await request(
        `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerMailboxCounts.fc528a5a81a76dff212a4a3d2d48e84b&variables=(mailboxUrn:${encode(mailbox)})`,
        {},
        NOT_ADMIN
      )
    ).json();
    // Only the status and an answer are verified live; the collection's name
    // is not, so any non-null answer counts and nothing else does.
    if (
      (Array.isArray(json?.errors) && json.errors.length) ||
      !json?.data ||
      typeof json.data !== "object" ||
      Object.values(json.data).every((value) => value == null)
    )
      fail(NOT_ADMIN);
  }
  // The inbox one feed reads: the signed-in member's own ("me", the default),
  // or a company page's mailbox the member administers. `member` is the
  // signed-in account, which must not change while the inbox is in use.
  async function inboxOf(selected) {
    const member = await account();
    if (selected === undefined || selected === null || selected === "me")
      return { mailbox: member, member, page: false };
    if (typeof selected !== "string" || !PAGE_MAILBOX.test(selected))
      fail(
        'inbox must be "me" or a page mailbox URN (urn:li:fsd_pageMailbox:<number>)'
      );
    await assertAdministers(selected);
    return { mailbox: selected, member, page: true };
  }
  // Whether a message was sent from this inbox. A member inbox's own messages
  // carry the member's identity. A page inbox holds conversations between the
  // page and members: a page reply's sender is the page's mailbox or the page
  // as an organization participant, with the admin who sent it only as its
  // actor. The signed-in admin writing as themselves is a member like any other.
  function fromMe(sender, inbox) {
    const host = sender?.hostIdentityUrn;
    if (typeof host !== "string") return null;
    if (!inbox.page) return host === inbox.mailbox;
    return host === inbox.mailbox || !!sender.participantType?.organization;
  }
  // A page conversation's visitor-chosen topic, when LinkedIn shows one.
  function topicOf(conversation, inbox) {
    if (!inbox.page) return undefined;
    for (const value of [
      conversation?.topic,
      conversation?.conversationTopic,
      conversation?.subject,
    ]) {
      const text = clean(typeof value === "string" ? value : value?.text);
      if (text) return text;
    }
    return undefined;
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
  function parseNotifications(stream, continuation = false) {
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
    // A continuation can end with the provider's empty partial-page envelope,
    // without the full page's empty-state component. Accept that exact shape
    // only after pagination; unknown content must still fail closed.
    const root = records.get("0");
    const shell = root?.[0]?.[0];
    const emptyContinuation =
      continuation &&
      Array.isArray(root) &&
      root.length === 10 &&
      Array.isArray(root[0]) &&
      root[0].length === 2 &&
      root[0][1] === "$undefined" &&
      Array.isArray(shell) &&
      shell.length === 4 &&
      shell[0] === "$" &&
      typeof shell[1] === "string" &&
      /^\$L[0-9a-f]+$/.test(shell[1]) &&
      shell[2] === null &&
      shell[3]?.isPartialPage === true &&
      Object.keys(shell[3]).length === 2 &&
      Array.isArray(shell[3].modelStates) &&
      shell[3].modelStates.length === 0 &&
      JSON.stringify(root.slice(1, 7)) ===
        JSON.stringify([
          "$undefined",
          [],
          "$undefined",
          "$undefined",
          "$0:0:0:props:modelStates",
          null,
        ]) &&
      typeof root[7] === "string" &&
      root[8] === "$undefined" &&
      root[9]?.version === root[7] &&
      Object.keys(root[9]).length === 1;
    if (
      !recognized &&
      !emptyContinuation &&
      !stream.includes("notifications-empty-state")
    )
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
    return parseNotifications(stream, !!payload);
  }
  async function conversationsPage(mailbox, cursor) {
    return graph(
      "messengerConversations.9501074288a12f3ae9e3c7ea243bccbf",
      `query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),count:20,mailboxUrn:${encode(mailbox)}${cursor ? `,nextCursor:${encode(cursor)}` : ""}`,
      "messengerConversationsByCategoryQuery"
    );
  }
  // A conversation is a group when LinkedIn says so or it has more than two
  // participants. Null when neither is shown: callers treat unknown as "not a
  // direct message", so nothing is ever sent into a group by mistake.
  function groupOf(conversation) {
    const participants = conversation?.conversationParticipants;
    if (Array.isArray(participants) && participants.length > 2) return true;
    if (typeof conversation?.groupChat === "boolean")
      return conversation.groupChat;
    return Array.isArray(participants) && participants.length > 0
      ? false
      : null;
  }
  // The thread token is the conversation's chat id: the URN minus the mailbox.
  function threadOf(conversation, mailbox) {
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
    return thread;
  }
  function memberIdOf(urn) {
    const match =
      typeof urn === "string" &&
      urn.match(/^urn:li:(?:fsd_profile|member):([A-Za-z0-9_-]+)$/);
    return match ? match[1] : null;
  }
  // Only a vanity `/in/<slug>` URL names a slug; a member-id URL does not.
  function slugOf(profileUrl) {
    const match =
      typeof profileUrl === "string" && profileUrl.match(/\/in\/([^/?#]+)/i);
    if (!match || /^ACo/.test(match[1])) return null;
    const slug = match[1].toLowerCase();
    return /^[a-z0-9_-]+$/.test(slug) ? slug : null;
  }
  async function messageElements(conversation) {
    return (
      await graph(
        "messengerMessages.5846eeb71c981f11e0134cb6626cc314",
        `conversationUrn:${encode(conversation)}`,
        "messengerMessagesBySyncToken"
      )
    ).elements;
  }
  async function messagesPage(conversation, inbox, group = null, topic) {
    const thread = threadOf(conversation, inbox.mailbox);
    const messages = await Promise.all(
      (await messageElements(conversation)).map(async (message) => {
        if (
          typeof message.entityUrn !== "string" ||
          !Number.isFinite(message.deliveredAt)
        )
          fail("Message identity or timestamp is unavailable");
        const member = message.sender?.participantType?.member;
        const recalled = message.messageBodyRenderFormat === "RECALLED";
        const text = recalled
          ? ""
          : (message.body?.text ?? message.renderContentFallbackText ?? "");
        const hasAttachments =
          Array.isArray(message.renderContent) &&
          message.renderContent.length > 0;
        return {
          id: message.entityUrn,
          conversation_id: conversation,
          thread_id: thread,
          is_group: group,
          // LinkedIn's router retains base64 padding in its canonical URL.
          // Encoding '=' here leaves page-activated drafts waiting on a URL
          // that differs from the one the user actually visits.
          conversation_url: `https://www.linkedin.com/messaging/thread/${thread}/`,
          text,
          recalled,
          // `text` is answerable; `media` carries attachments; `revoked` was
          // recalled; `system` is LinkedIn's own event in the thread.
          content_kind: recalled
            ? "revoked"
            : message.messageBodyRenderFormat === "SYSTEM"
              ? "system"
              : hasAttachments
                ? "media"
                : text.trim()
                  ? "text"
                  : "system",
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
          has_attachments: hasAttachments,
          sender_id: message.sender?.hostIdentityUrn ?? null,
          sender_member_id: memberIdOf(message.sender?.hostIdentityUrn),
          sender_slug: slugOf(member?.profileUrl),
          sender_name: clean(
            `${member?.firstName?.text ?? ""} ${member?.lastName?.text ?? ""}`
          ),
          from_me: fromMe(message.sender, inbox),
          occurred_at: new Date(message.deliveredAt).toISOString(),
          ...(topic ? { topic } : {}),
        };
      })
    );
    return messages.sort(
      (a, b) =>
        b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id)
    );
  }
  function cursorOf(raw, feed, inbox) {
    if (!raw) return {};
    if (typeof raw !== "string" || raw.length > 100000) fail("Invalid cursor");
    const cursor = JSON.parse(raw);
    if (
      cursor.v !== 1 ||
      cursor.feed !== feed ||
      cursor.account !== inbox.mailbox ||
      (cursor.member ?? cursor.account) !== inbox.member
    )
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
  async function readMessages(cursor, limit, inbox) {
    let threads = cursor.threads;
    let groups = cursor.groups ?? [];
    // Only a page inbox's cursor carries topics; a member cursor is unchanged.
    let topics = cursor.topics;
    let next = cursor.next;
    if (!threads) {
      const source = await conversationsPage(inbox.mailbox, cursor.page);
      threads = source.elements.map((thread) => thread.entityUrn);
      groups = source.elements.map(groupOf);
      if (inbox.page)
        topics = source.elements.map((thread) => topicOf(thread, inbox) ?? null);
      next = source.metadata?.nextCursor;
    }
    if (
      !Array.isArray(threads) ||
      threads.length > 20 ||
      !Array.isArray(groups) ||
      (topics !== undefined && !Array.isArray(topics))
    )
      fail("Invalid message cursor");
    const messages = threads.length
      ? await messagesPage(
          threads[0],
          inbox,
          groups[0] ?? null,
          typeof topics?.[0] === "string" ? topics[0] : undefined
        )
      : [];
    const { rows, more } = resume(messages, cursor, limit, "Message");
    const continuation = more
      ? { threads, groups, topics, next, after: rows.at(-1).id }
      : threads.length > 1
        ? {
            threads: threads.slice(1),
            groups: groups.slice(1),
            topics: topics?.slice(1),
            next,
          }
        : next
          ? { page: next }
          : null;
    return { rows, continuation };
  }
  // Walks the inbox from the most recently active conversation, following
  // LinkedIn's cursor to the end of the inbox, and returns the first non-null
  // `visit` result. Catch-up can observe a thread on any page, so a lookup
  // must reach it too: running out of time fails (the caller retries) rather
  // than reporting the target absent.
  async function searchConversations(mailbox, visit) {
    const deadline = Date.now() + LOOKUP_DEADLINE_MS;
    let cursor;
    for (;;) {
      if (Date.now() > deadline)
        fail("The inbox search ran out of time before reaching the end; retry");
      const source = await conversationsPage(mailbox, cursor);
      for (const thread of source.elements) {
        const found = await visit(thread);
        if (found) return found;
      }
      cursor = source.metadata?.nextCursor;
      if (typeof cursor !== "string" || !cursor || cursor.length > 4096)
        return null;
    }
  }
  // A message reference names no conversation, so `id:<message URN>` searches
  // the inbox from the most recently active conversation: a new message's
  // thread is near the top. Not found is an empty page; the caller retries.
  async function findMessage(id, inbox) {
    const row = await searchConversations(
      inbox.mailbox,
      async (thread) =>
        (
          await messagesPage(
            thread.entityUrn,
            inbox,
            groupOf(thread),
            topicOf(thread, inbox)
          )
        ).find((message) => message.id === id) ?? null
    );
    return { rows: row ? [row] : [], continuation: null };
  }
  async function read(input) {
    const inbox = await inboxOf(
      input.feed === "live_messages" ? input.inbox : undefined
    );
    const mailbox = inbox.mailbox;
    const cursor = cursorOf(input.cursor, input.feed, inbox);
    const limit = Math.max(1, Math.min(100, input.limit ?? 20));
    const byId =
      input.feed === "live_messages" &&
      typeof input.query === "string" &&
      input.query.startsWith("id:")
        ? input.query.slice(3).trim()
        : null;
    if (byId !== null && (!byId.startsWith("urn:li:msg_message:") || input.cursor))
      fail("Message lookup takes one id:<message URN> and no cursor");
    const { rows, continuation } =
      input.feed === "notifications"
        ? await readNotifications(cursor, limit)
        : byId
          ? await findMessage(byId, inbox)
          : input.feed === "live_messages"
            ? await readMessages(cursor, limit, inbox)
            : fail("Unknown source feed");
    if ((await account()) !== inbox.member)
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
              ...(inbox.page ? { member: inbox.member } : {}),
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
  // Keep SHA-256 fingerprints losslessly in base64url inside checkpoints.
  // Batch checkpoints carry both predecessor and successor, so hex would
  // exhaust the transport budget before a large interrupted pass can resume.
  function compactHash(value) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return value;
    return btoa(String.fromCharCode(...value.match(/../g).map(byte => parseInt(byte, 16))))
      .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }
  function compactSeen(seen) {
    return Object.fromEntries(Object.entries(seen ?? {}).map(([key, value]) => [compactHash(key), Array.isArray(value) ? [compactHash(value[0]), value[1]] : compactHash(value)]));
  }
  // One observation pass is bounded source work. Message catch-up resumes from
  // its checkpoint; notifications reorder at the top and report a gap instead.
  const NOTIFICATION_PAGES_PER_PASS = 10;
  const CONVERSATION_PAGES_PER_PASS = 2;
  // Lookups by id or conversation reach the 100 most recently active threads.
  // Under the server's 60-second source read deadline.
  const LOOKUP_DEADLINE_MS = 45000;
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
    // `seen` records source position; the delivery layer also carries a monotonic generation.
    return {};
  }
  async function catchUpConversation(
    { previous, observe, gap },
    thread,
    round,
    inbox
  ) {
    const messages = await messagesPage(
      thread.entityUrn,
      inbox,
      groupOf(thread),
      topicOf(thread, inbox)
    );
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
  async function catchUpMessages(pass, inbox) {
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
      const result = await conversationsPage(inbox.mailbox, cursor);
      const active = result.elements.filter((thread) => {
        if (!Number.isFinite(thread.lastActivityAt))
          fail("Conversation activity is unavailable");
        return thread.lastActivityAt >= round.since;
      });
      for (const thread of active)
        await catchUpConversation(pass, thread, round, inbox);
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
  async function snapshot(feed, previous, inbox) {
    const observedAt = Date.now();
    const observed = new Map();
    const previousSeen = compactSeen(previous?.seen);
    const events = [];
    // Returns whether the previous checkpoint already held this identity.
    async function observe(row, eventType, resourceType, revisionText) {
      const identity = await digest(row.id);
      const revision =
        revisionText === undefined ? identity : await digest(revisionText);
      const key = compactHash(identity);
      const fingerprint = revisionText === undefined ? "1" : compactHash(revision);
      const stored = previousSeen[key];
      const prior = Array.isArray(stored) ? stored[0] : stored;
      const unchanged = prior === fingerprint || (revisionText === undefined && prior === key);
      if (previous && !unchanged && !observed.has(key)) {
        events.push({
          id: `${identity}:${revision}`,
          event_type: eventType,
          resource_type: resourceType,
          resource_ref: row.id,
          occurred_at: row.occurred_at ?? new Date(observedAt).toISOString(),
        });
      }
      observed.set(key, fingerprint);
      // Accepted chunks suppress repeats, but newly accepted items are not
      // the original catch-up boundary. Otherwise a rebind stops on page one
      // before reaching unfinished provider pages.
      return Array.isArray(stored) ? stored[1] === true : prior !== undefined;
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
        : await catchUpMessages(pass, inbox);
    if ((await account()) !== inbox.member)
      fail("LinkedIn account changed during observation");
    const checkpoint = {
      feed,
      account: inbox.mailbox,
      ...(inbox.page ? { member: inbox.member } : {}),
      ...position,
      // Keep this pass's identities first, in source order, then older ones.
      seen: Object.fromEntries(
        [
          ...observed,
          ...Object.entries(previousSeen).filter(
            ([identity]) => !observed.has(identity)
          ),
        ].slice(0, feed === "notifications" ? Math.max(SEEN_LIMIT, observed.size) : SEEN_LIMIT).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
      ),
    };
    return { checkpoint, events, more, observed };
  }
  // Each accepted chunk commits only its own seen identities. Source position
  // advances on the final chunk; a rebind can safely rescan the unfinished page.
  async function batchesOf(feed, previous, result) {
    const { events } = result;
    const prior = previous?.linkedin_inbox;
    const epoch = prior?.observation_epoch ?? (prior
      ? await digest(JSON.stringify(["legacy-observation", prior]))
      : crypto.randomUUID());
    let generation = prior?.observation_generation ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0)
      fail("Invalid observation generation");
    const size = (batch) => new TextEncoder().encode(JSON.stringify(batch)).length;
    const batches = [];
    let cursor = previous;
    for (let offset = 0; ; ) {
      const nextGeneration = events.length || !prior?.observation_epoch ? generation + 1 : generation;
      if (!Number.isSafeInteger(nextGeneration)) fail("Observation generation exhausted");
      const observedEvents = await Promise.all(events.slice(offset, offset + BATCH_EVENTS).map(async (event) => ({
        ...event,
        id: event.event_type === "notification.changed"
          ? await digest(JSON.stringify([epoch, nextGeneration, event.id])) : event.id,
      })));
      const through = async (end) => {
        const final = end === events.length;
        let seen = compactSeen(cursor?.linkedin_inbox?.seen);
        for (const event of events.slice(offset, end)) {
          const identity = compactHash(await digest(event.resource_ref));
          if (result.observed.has(identity)) {
            const prior = seen[identity];
            const anchor = Array.isArray(prior) ? prior[1] : prior !== undefined;
            seen[identity] = feed === "notifications" ? [result.observed.get(identity), anchor] : result.observed.get(identity);
          }
        }
        // Native message IDs remain immutable across replay, so their bounded
        // seen cache is an optimization. Mutable notification fingerprints
        // must survive the entire unfinished pass to prevent false transitions.
        if (feed === "live_messages") seen = Object.fromEntries(Object.entries(seen).slice(-SEEN_LIMIT));
        const next = { linkedin_inbox: {
          ...(final ? result.checkpoint : { ...prior, seen }),
          observation_epoch: epoch,
          observation_generation: nextGeneration,
        } };
        const slice = observedEvents.slice(0, end - offset);
        return {
          id: `${feed}:${epoch}:${nextGeneration}:${await digest(JSON.stringify([cursor, next, slice]))}`,
          events: slice,
          checkpoint: { previous: cursor, next },
          ...(final ? { more: result.more } : {}),
        };
      };
      let end = Math.min(offset + BATCH_EVENTS, events.length);
      let batch = await through(end);
      while (size(batch) > BATCH_BYTES && end - offset > 1) {
        end = offset + Math.floor((end - offset) / 2);
        batch = await through(end);
      }
      if (size(batch) > BATCH_BYTES)
        fail("Source reference batch exceeds the browser record limit");
      batches.push(batch);
      if (end === events.length) return batches;
      cursor = batch.checkpoint.next;
      generation++;
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
        const { feed, checkpoint, inbox } = listener;
        if ((await account()) !== inbox.member)
          fail("LinkedIn account changed; reconnect this source");
        // A checkpoint of another inbox (the feed's inbox setting changed)
        // restarts from a fresh baseline; the batch still names it as the
        // previous checkpoint it replaces.
        const prior = checkpoint?.linkedin_inbox;
        const result = await snapshot(
          feed,
          prior?.account === inbox.mailbox ? prior : undefined,
          inbox
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
      // The page receipt means buffered, not committed. A reattach uses the
      // server's durable per-chunk checkpoint; observation identities survive replay.
      const done = listener.batches.shift();
      if (done.checkpoint) listener.checkpoint = done.checkpoint.next;
      if (listener.batches.length) post(listener, listener.batches[0]);
    }
  }
  // Direct send, approved ONLY for replying to direct messages on accounts the
  // owner operates. One reply per idempotency key: the key becomes LinkedIn's
  // client origin token, so a retry finds the first attempt instead of sending
  // again. Group or unknown conversations are refused.
  const SEND_RECONFIRM_ATTEMPTS = 5;
  async function originTokenOf(mailbox, conversation, idempotencyKey) {
    const hex = await digest(
      JSON.stringify([mailbox, conversation, idempotencyKey])
    );
    // UUID-shaped (version 4 / variant bits set), like LinkedIn's own tokens.
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `4${hex.slice(13, 16)}`,
      `${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join("-");
  }
  function trackingId() {
    // 64 symbols, so masking a random byte to 6 bits is unbiased.
    const alphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    return [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => alphabet[byte & 63])
      .join("");
  }
  // `conversation_id` is a thread id of the member's own inbox, or a full
  // conversation URN whose mailbox names the inbox the reply leaves from: the
  // member's own or a page the member administers.
  async function sendTarget(given) {
    if (typeof given === "string" && /^[A-Za-z0-9_-]+=*$/.test(given)) {
      const member = await account();
      return { inbox: { mailbox: member, member, page: false }, thread: given };
    }
    const match =
      typeof given === "string" &&
      given.match(
        /^urn:li:msg_conversation:\((urn:li:fsd_profile:[A-Za-z0-9_-]+|urn:li:fsd_pageMailbox:[0-9]+),([A-Za-z0-9_-]+=*)\)$/
      );
    if (!match)
      fail(
        "conversation_id must be a LinkedIn conversation thread id or conversation URN"
      );
    if (PAGE_MAILBOX.test(match[1]))
      return { inbox: await inboxOf(match[1]), thread: match[2] };
    const member = await account();
    if (match[1] !== member)
      fail("The conversation belongs to another LinkedIn account; not sending");
    return { inbox: { mailbox: member, member, page: false }, thread: match[2] };
  }
  async function send(input) {
    const { inbox, thread } = await sendTarget(input.conversation_id);
    const mailbox = inbox.mailbox;
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > 3000)
      fail("text must contain 1-3000 characters");
    const idempotencyKey = input.idempotency_key;
    if (typeof idempotencyKey !== "string" || !idempotencyKey)
      fail("idempotency_key is required");
    const conversation = `urn:li:msg_conversation:(${mailbox},${thread})`;
    const recent = await searchConversations(
      mailbox,
      async (element) => (element.entityUrn === conversation ? element : null)
    );
    if (!recent)
      fail("The conversation is not in the inbox; not sending");
    if (groupOf(recent) !== false)
      fail("send_message only answers direct messages; this conversation is a group or its membership is unknown");
    const originToken = await originTokenOf(mailbox, conversation, idempotencyKey);
    const sent = (message) => ({
      sent: true,
      message_id: message.entityUrn,
      conversation_id: input.conversation_id,
      delivered_at: Number.isFinite(message.deliveredAt)
        ? new Date(message.deliveredAt).toISOString()
        : null,
    });
    const prior = (await messageElements(conversation)).find(
      (message) =>
        fromMe(message.sender, inbox) === true &&
        message.originToken === originToken
    );
    if (prior) return { ...sent(prior), already_sent: true };
    if ((await account()) !== inbox.member)
      fail("LinkedIn account changed during conversation lookup; not sending");
    const response = await (
      await request(
        "/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            message: {
              body: { attributes: [], text },
              renderContentUnions: [],
              conversationUrn: conversation,
              originToken,
            },
            mailboxUrn: mailbox,
            trackingId: trackingId(),
            // Reads can lag or omit origin tokens, so request provider-side
            // deduplication for retries and concurrent attempts too.
            dedupeByClientGeneratedToken: true,
          }),
        }
      )
    ).json();
    const messageId = response?.value?.entityUrn;
    // Confirm the message is in the conversation before reporting success.
    for (let attempt = 0; attempt < SEND_RECONFIRM_ATTEMPTS; attempt++) {
      const shown = (await messageElements(conversation)).find(
        (message) =>
          fromMe(message.sender, inbox) === true &&
          ((typeof messageId === "string" && message.entityUrn === messageId) ||
            message.originToken === originToken)
      );
      if (shown) return sent(shown);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    fail("LinkedIn accepted the message but it did not appear in the conversation; retry with the same idempotency_key to reconcile");
  }
  async function listen(input) {
    if (!input.bridge_id || !input.token)
      fail("Source subscription binding is required");
    const inbox = await inboxOf(
      input.feed === "live_messages" ? input.inbox : undefined
    );
    const previous = input.checkpoint?.linkedin_inbox;
    // A mailbox change restarts the baseline, but never permits a changed sign-in.
    if (
      previous &&
      (previous.feed !== input.feed ||
        (previous.member ?? previous.account) !== inbox.member)
    )
      fail("Source checkpoint belongs to another account or feed");
    const prior = listeners.get(input.bridge_id);
    if (prior) stop(prior);
    const listener = {
      id: input.bridge_id,
      token: input.token,
      feed: input.feed,
      inbox,
      // The last posted record; only its receipt may advance delivery.
      sequence: 0,
      // The checkpoint the next snapshot starts from, set by each batch receipt.
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
  globalThis[key] = { version, read, listen, send, detach };
}
