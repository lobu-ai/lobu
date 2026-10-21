/**
 * Serialized into the signed-in x.com page. All bindings must remain inside
 * this function: the connector ships it with Function.prototype.toString().
 *
 * It reads and sends direct messages through the same-origin DM endpoints
 * the x.com web client calls, with the page's own session cookies. It never
 * opens /messages, which marks conversations read.
 */
export function xDirectMessagesProgram() {
	const key = "__lobuXDirectMessagesV1";
	// An identical program keeps a warm tab's listeners; any code change
	// reinstalls and asks the replaced program's listeners to reattach.
	const version = xDirectMessagesProgram.toString();
	if (globalThis[key]?.version === version) return;
	globalThis[key]?.detach();
	const listeners = new Map();
	// X's public web-client bearer: the same constant every x.com visitor's
	// browser sends with these requests. It names the web app, not a user; the
	// account's authority comes only from the page's session cookies.
	const WEB_CLIENT_BEARER =
		"Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
	const DM_API = "/i/api/1.1/dm";
	const DM_PARAMS =
		"dm_users=true&include_groups=true&include_conversation_info=true&supports_reactions=true";
	const CONVERSATION_ID = /^[0-9]{1,20}(?:-[0-9]{1,20})?$/;
	const MESSAGE_REFERENCE = /^id:([0-9]{1,20}(?:-[0-9]{1,20})?):([0-9]{1,20})$/;
	// A message being answered is recent; an id lookup reads at most this many
	// conversation pages back.
	const LOOKUP_PAGES = 5;
	// One observation pass is bounded source work; `more` continues the round.
	const UPDATE_PAGES_PER_PASS = 10;
	// Matching recent text without a request id is ambiguous, not delivery proof.
	const RESEND_WINDOW_MS = 10 * 60 * 1000;
	// Reconcile 503 responses before retrying: a failed response can still land.
	const UNAVAILABLE_SEND_RETRY_DELAYS_MS = [3000, 7000];
	// Abort network work before Chrome's 80s awaited-evaluation deadline.
	const SEND_TIMEOUT_MS = 70000;
	const BATCH_EVENTS = 500;
	const BATCH_BYTES = 128 * 1024;
	function fail(message, status) {
		const error = new Error(`X direct messages: ${message}`);
		if (status !== undefined) error.status = status;
		throw error;
	}
	function cookie(name) {
		const raw = document.cookie
			.split("; ")
			.find((value) => value.startsWith(`${name}=`));
		return raw ? decodeURIComponent(raw.slice(name.length + 1)) : "";
	}
	// `twid` carries the signed-in numeric user id; it is not a credential.
	function account() {
		const match = /^u=([0-9]+)$/.exec(cookie("twid"));
		if (!match) fail("Sign in to X in the paired browser");
		return match[1];
	}
	async function request(path, init = {}) {
		init.signal?.throwIfAborted();
		const self = account();
		const csrf = cookie("ct0");
		if (!csrf) fail("Sign in to X in the paired browser");
		const response = await fetch(path, {
			credentials: "include",
			...init,
			signal: init.signal
				? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
				: AbortSignal.timeout(20000),
			headers: {
				authorization: WEB_CLIENT_BEARER,
				"x-csrf-token": csrf,
				"x-twitter-auth-type": "OAuth2Session",
				"x-twitter-active-user": "yes",
				...init.headers,
			},
		});
		if (!response.ok) {
			let code = null;
			try {
				code = (await response.json())?.errors?.[0]?.code ?? null;
			} catch {
				code = null;
			}
			fail(
				`request failed (HTTP ${response.status}${code === null ? "" : `, X error ${code}`})`,
				response.status,
			);
		}
		const body = await response.json();
		if (account() !== self) fail("X account changed during the request");
		return body;
	}
	async function inbox() {
		const body = await request(
			`${DM_API}/inbox_initial_state.json?${DM_PARAMS}`,
		);
		return body?.inbox_initial_state ?? fail("Inbox state is unavailable");
	}
	async function conversation(conversationId, maxId, signal) {
		const page = maxId ? `&max_id=${encodeURIComponent(maxId)}` : "";
		const body = await request(
			`${DM_API}/conversation/${conversationId}.json?context=FETCH_DM_CONVERSATION&${DM_PARAMS}${page}`,
			signal ? { signal } : {},
		);
		return body?.conversation_timeline ?? fail("Conversation is unavailable");
	}
	async function updates(cursor) {
		const body = await request(
			`${DM_API}/user_updates.json?cursor=${encodeURIComponent(cursor)}&${DM_PARAMS}`,
		);
		const events = body?.user_events ?? fail("Inbox updates are unavailable");
		// A quiet inbox answers with only its cursor and last-seen ids: no
		// `entries` key means nothing arrived. Inbox and conversation reads
		// still require their entries.
		return "entries" in events ? events : { ...events, entries: [] };
	}
	function timeOf(value) {
		if (value === null || value === undefined || value === "")
			return Number.NaN;
		const millis = Number(value);
		return Number.isFinite(millis) ? millis : Date.parse(String(value ?? ""));
	}
	// Message text with t.co links expanded and the attachment's own link removed.
	function textOf(data) {
		let value = String(data.text ?? "");
		const mediaLinks = new Set(
			Object.values(data.attachment ?? {}).flatMap((media) => [
				media?.url,
				media?.expanded_url,
			]),
		);
		for (const url of data.entities?.urls ?? []) {
			if (typeof url?.url === "string" && typeof url.expanded_url === "string")
				value = value
					.split(url.url)
					.join(
						mediaLinks.has(url.url) || mediaLinks.has(url.expanded_url)
							? ""
							: url.expanded_url,
					);
		}
		for (const link of mediaLinks) {
			if (typeof link === "string" && link) value = value.split(link).join("");
		}
		return value.trim();
	}
	function messagesOf(payload) {
		if (!Array.isArray(payload?.entries))
			fail("Response entries are unavailable");
		const messages = [];
		for (const entry of payload.entries) {
			const message = entry?.message;
			if (message) {
				if (!message.message_data) fail("Message data is unavailable");
				messages.push(message);
			}
		}
		return messages;
	}
	// The one place a source row and its reference id are derived.
	function rowsOf(payload, self) {
		const users = payload?.users ?? {};
		const conversations = payload?.conversations ?? {};
		const rows = [];
		for (const message of messagesOf(payload)) {
			const data = message.message_data;
			const messageId = String(message.id ?? data.id ?? "");
			const conversationId = String(message.conversation_id ?? "");
			const senderId = String(data.sender_id ?? "");
			const time = timeOf(message.time ?? data.time);
			if (
				!/^[0-9]+$/.test(messageId) ||
				!CONVERSATION_ID.test(conversationId) ||
				!senderId ||
				!Number.isFinite(time) ||
				!Number.isFinite(new Date(time).getTime())
			)
				fail("Message identity or timestamp is invalid");
			const info = conversations[conversationId];
			const sender = users[senderId];
			const text = textOf(data);
			const isGroup =
				typeof info?.type === "string"
					? info.type === "GROUP_DM"
					: !conversationId.includes("-");
			rows.push({
				id: `${conversationId}:${messageId}`,
				message_id: messageId,
				conversation_id: conversationId,
				conversation_name:
					isGroup && typeof info?.name === "string" ? info.name : null,
				sender_id: senderId,
				sender_handle:
					typeof sender?.screen_name === "string" ? sender.screen_name : null,
				sender_name: typeof sender?.name === "string" ? sender.name : null,
				from_me: senderId === self,
				is_group: isGroup,
				// A message request: the conversation sits in the untrusted inbox
				// until the account accepts it.
				is_request: info?.trusted === false,
				text,
				content_kind: text ? "text" : data.attachment ? "media" : "empty",
				occurred_at: new Date(time).toISOString(),
			});
		}
		return rows.sort(
			(a, b) =>
				b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id),
		);
	}
	async function readMessage(self, conversationId, messageId) {
		let maxId;
		for (let page = 0; page < LOOKUP_PAGES; page++) {
			const timeline = await conversation(conversationId, maxId);
			const row = rowsOf(timeline, self).find(
				(candidate) => candidate.message_id === messageId,
			);
			if (row) return row;
			if (timeline.status !== "HAS_MORE") return null;
			if (!timeline.min_entry_id)
				fail(
					"Message lookup is incomplete: conversation cursor is unavailable",
				);
			maxId = String(timeline.min_entry_id);
		}
		fail("Message lookup is incomplete: conversation page limit reached");
	}
	async function read(input) {
		const self = account();
		const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
		const query = typeof input.query === "string" ? input.query.trim() : "";
		if (query) {
			const match = MESSAGE_REFERENCE.exec(query);
			if (!match) fail("Only id:<message id> queries are supported");
			const row = await readMessage(self, match[1], match[2]);
			return { rows: row ? [row] : [], hasMore: false };
		}
		// The inbox's recent state across conversations, not a history export.
		const all = rowsOf(await inbox(), self);
		let start = 0;
		if (input.cursor) {
			if (typeof input.cursor !== "string" || input.cursor.length > 1000)
				fail("Invalid cursor");
			const cursor = JSON.parse(input.cursor);
			if (cursor?.v !== 1 || cursor.account !== self)
				fail("Cursor belongs to a different account");
			start = all.findIndex((row) => row.id === cursor.after) + 1;
			if (!start) fail("Cursor expired; restart the read");
		}
		const rows = all.slice(start, start + limit);
		const more = start + limit < all.length;
		if (account() !== self) fail("X account changed during the read");
		return {
			rows,
			hasMore: more,
			...(more
				? {
						nextCursor: JSON.stringify({
							v: 1,
							account: self,
							after: rows.at(-1).id,
						}),
					}
				: {}),
		};
	}
	async function digest(value) {
		const bytes = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(value),
		);
		return [...new Uint8Array(bytes)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
	}
	// X's client request id, derived from the caller's idempotency key so a
	// retried send carries the same id and can recognise its earlier attempt.
	async function requestIdOf(self, conversationId, idempotencyKey) {
		const hex = await digest(
			JSON.stringify([self, conversationId, idempotencyKey]),
		);
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	}
	// An outgoing message on the latest page that is this send's earlier attempt.
	// A matching body cannot identify a send: independent replies can share text.
	function earlierAttempt(timeline, self, requestId, text) {
		const requestIds = new Map(
			messagesOf(timeline).map((message) => [
				String(message.id),
				typeof message.request_id === "string" ? message.request_id : null,
			]),
		);
		const since = Date.now() - RESEND_WINDOW_MS;
		return (
			rowsOf(timeline, self).find((row) => {
				if (!row.from_me) return false;
				const sent = requestIds.get(row.message_id);
				if (sent) return sent === requestId;
				if (row.text === text.trim() && Date.parse(row.occurred_at) >= since)
					fail(
						"Matching recent text has no request id; cannot identify the earlier send. Inspect the conversation before sending again",
					);
				return false;
			}) ?? null
		);
	}
	async function send(input) {
		const self = account();
		const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
		const conversationId = String(input.conversation_id ?? "");
		if (!CONVERSATION_ID.test(conversationId))
			fail("conversation_id must be an exact X DM conversation id");
		if (
			conversationId.includes("-") &&
			!conversationId.split("-").includes(self)
		)
			fail("The conversation does not belong to the signed-in account");
		const text = typeof input.text === "string" ? input.text : "";
		if (!text.trim()) fail("text is required");
		const idempotencyKey =
			typeof input.idempotency_key === "string" ? input.idempotency_key : "";
		if (!idempotencyKey) fail("idempotency_key is required");
		const requestId = await requestIdOf(self, conversationId, idempotencyKey);
		const delivered = (prior) => ({
			sent: true,
			deduplicated: true,
			id: prior.id,
			message_id: prior.message_id,
			conversation_id: conversationId,
			occurred_at: prior.occurred_at,
		});
		const readConversation = () => {
			if (account() !== self) fail("X account changed before the send read");
			return conversation(conversationId, undefined, signal);
		};
		// Only an existing conversation the account can read is a send target.
		const before = await readConversation();
		const prior = earlierAttempt(before, self, requestId, text);
		if (prior) return delivered(prior);
		let response;
		for (const delay of [...UNAVAILABLE_SEND_RETRY_DELAYS_MS, null]) {
			if (account() !== self) fail("X account changed before the send");
			try {
				response = await request(`${DM_API}/new2.json`, {
					method: "POST",
					signal,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						conversation_id: conversationId,
						recipient_ids: false,
						request_id: requestId,
						text,
						cards_platform: "Web-12",
						include_cards: 1,
						include_quote_count: true,
						dm_users: false,
					}),
				});
				break;
			} catch (error) {
				if (error?.status !== 503) throw error;
				signal.throwIfAborted();
				if (delay !== null)
					await new Promise((resolve) => setTimeout(resolve, delay));
				const landed = earlierAttempt(
					await readConversation(),
					self,
					requestId,
					text,
				);
				if (landed) return delivered(landed);
				if (delay === null) throw error;
			}
		}
		const created = messagesOf(response).find(
			(message) => String(message.conversation_id) === conversationId,
		);
		const messageId = created ? String(created.id ?? "") : "";
		if (!/^[0-9]+$/.test(messageId))
			fail("X accepted the send but returned no message id");
		const after = await readConversation();
		const landed = rowsOf(after, self).find(
			(row) => row.message_id === messageId && row.from_me,
		);
		if (!landed)
			fail(
				`sent message ${messageId} is not visible in the conversation; delivery is uncertain. Inspect the conversation before sending again`,
			);
		return {
			sent: true,
			deduplicated: false,
			id: landed.id,
			message_id: messageId,
			conversation_id: conversationId,
			occurred_at: landed.occurred_at,
		};
	}
	// The update cursor is the whole position: a first pass records where the
	// inbox stands now, and each later pass reports what arrived after it.
	async function snapshot(previous, self) {
		if (!previous) {
			const state = await inbox();
			messagesOf(state);
			if (typeof state.cursor !== "string" || !state.cursor)
				fail("Inbox cursor is unavailable");
			return {
				checkpoint: {
					account: self,
					cursor: state.cursor,
					started_at: Date.now(),
				},
				events: [],
				more: false,
			};
		}
		const events = [];
		const observed = new Set();
		let cursor = previous.cursor;
		let more = false;
		for (let page = 1; ; page++) {
			const batch = await updates(cursor);
			for (const row of rowsOf(batch, self).reverse()) {
				if (observed.has(row.id)) continue;
				observed.add(row.id);
				events.push({
					id: row.id,
					event_type: "message.created",
					resource_type: "message",
					resource_ref: row.id,
					occurred_at: row.occurred_at,
				});
			}
			if (typeof batch.cursor !== "string" || !batch.cursor)
				fail("Inbox update cursor is unavailable");
			const next = batch.cursor;
			const progressed = next !== cursor && (batch.entries?.length ?? 0) > 0;
			cursor = next;
			if (!progressed) break;
			if (page === UPDATE_PAGES_PER_PASS) {
				more = true;
				break;
			}
		}
		if (account() !== self) fail("X account changed during observation");
		return {
			checkpoint: { account: self, cursor, started_at: previous.started_at },
			events,
			more,
		};
	}
	// Ordered batches of at most 500 references and 128 KiB. Only the final
	// batch carries the checkpoint, so an interruption cannot skip references.
	async function batchesOf(previous, result) {
		const next = { x_dm: result.checkpoint };
		const { events } = result;
		const base = `x_dm:${await digest(JSON.stringify([previous, next, events]))}`;
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
			location.origin,
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
				id: "x:live_messages:source-observation-error",
				source_error: reason,
			});
	}
	// Called by a replacing program version: its listeners cannot inherit this
	// one's undelivered batches, so each reattaches instead of going silent.
	function detach() {
		for (const listener of [...listeners.values()])
			stop(
				listener,
				"X source program was replaced; reattach from the durable checkpoint",
			);
	}
	// Unacknowledged batches are reposted unchanged on the next tick.
	async function poll(listener) {
		if (!active(listener)) return;
		try {
			if (!listener.batches.length) {
				if (account() !== listener.account)
					fail("X account changed; reconnect this source");
				const { checkpoint } = listener;
				const result = await snapshot(checkpoint?.x_dm, listener.account);
				listener.batches = await batchesOf(checkpoint, result);
			}
			if (active(listener)) post(listener, listener.batches[0]);
		} catch {
			stop(
				listener,
				"X source observation failed; reconnect to recover without skipping messages",
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
				"X source delivery was rejected; reattach from the durable checkpoint",
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
		const self = account();
		const previous = input.checkpoint?.x_dm;
		if (previous && previous.account !== self)
			fail("Source checkpoint belongs to another account");
		const prior = listeners.get(input.bridge_id);
		if (prior) stop(prior);
		const listener = {
			id: input.bridge_id,
			token: input.token,
			account: self,
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
	globalThis[key] = { version, read, listen, send, detach };
}
