// Serialized into the paired browser. Read only the inbox's own loaded records
// and read loaders; never return provider clients, tickets, or arbitrary state.
export async function tiktokInboxPage(input) {
	const fail = (message, reason) => { throw Object.assign(new Error(`TikTok inbox: ${message}`), reason ? { browser_interruption: reason } : {}); };
	const visible = element => !!element?.getClientRects().length;
	const account = () => {
		if (location.origin !== "https://www.tiktok.com") fail("Wrong page origin");
		if (visible(document.querySelector("#captcha-verify-container-main-page"))) fail("Verification required in the connected browser", "challenge_required");
		const raw = document.querySelector("#__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent;
		const user = raw && JSON.parse(raw).__DEFAULT_SCOPE__?.["webapp.app-context"]?.user;
		if (typeof user?.uid !== "string" || !/^\d+$/.test(user.uid)) fail("Sign-in is required", "login_required");
		return user.uid;
	};
	const owner = account();
	const deadline = Date.now() + 20000;
	const pause = () => new Promise(resolve => setTimeout(resolve, 100));
	const wait = async read => {
		while (Date.now() < deadline) {
			if (account() !== owner) fail("Account changed during the read", "account_mismatch");
			const value = read();
			if (value) return value;
			await pause();
		}
		fail("Inbox did not finish loading; restart this page read", "loading_failure");
	};
	const readWithinDeadline = async read => {
		let outcome;
		Promise.resolve().then(read).then(value => { outcome = { value }; }, error => { outcome = { error }; });
		const settled = await wait(() => outcome);
		if ("error" in settled) throw settled.error;
		return settled.value;
	};
	const feed = input.feed;
	if (!["messages", "activity"].includes(feed)) fail("Unsupported feed");
	const limit = input.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("limit must be between 1 and 100");
	let cursor = {};
	if (input.cursor !== undefined) {
		if (typeof input.cursor !== "string" || input.cursor.length > 100000) fail("Invalid cursor");
		try { cursor = JSON.parse(input.cursor); } catch { fail("Invalid cursor"); }
		if (!cursor || cursor.v !== (feed === "messages" ? 2 : 1) || cursor.feed !== feed || cursor.account !== owner) fail("Cursor belongs to a different source or account");
		if (cursor.after !== undefined && (typeof cursor.after !== "string" || !/^\d+$/.test(cursor.after))) fail("Invalid message or activity cursor");
		if (feed === "messages" && (typeof cursor.thread !== "string" || !/^[0-9:]{1,150}$/.test(cursor.thread))) fail("Invalid conversation cursor");
	}
	const result = async (rows, next) => {
		const revised = await Promise.all(rows.map(async row => {
			const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(row)));
			return { ...row, source_revision: [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("") };
		}));
		if (account() !== owner) fail("Account changed during the read", "account_mismatch");
		return { rows: revised, hasMore: !!next, ...(next ? { nextCursor: JSON.stringify({ v: feed === "messages" ? 2 : 1, feed, account: owner, ...next }) } : {}) };
	};
	// React attaches the source record and loading state to these exact inbox
	// components. Match their shape, not minified component names or hook indexes.
	function* fibers(element) {
		let fiber = element?.[Object.keys(element).find(key => key.startsWith("__reactFiber$"))];
		// DOM references can retain the alternate after an immutable React commit.
		// Resolve membership in the committed tree, never prefer an alternate blindly.
		const nodeBudget = 50000;
		let root = fiber;
		// TikTok's inbox can sit more than 100 ancestors below its host root.
		for (let i = 0; root?.return && i < nodeBudget; i++) root = root.return;
		if (root?.return) fail("Inbox component root exceeds this read's node budget");
		const current = root?.stateNode?.current;
		if (current) {
			const pending = [{ node: current, parent: null }];
			let found;
			for (let i = 0; pending.length && i < nodeBudget; i++) {
				const entry = pending.pop();
				const node = entry.node;
				if (node === fiber || node === fiber?.alternate) { found = entry; break; }
				if (node.sibling) pending.push({ node: node.sibling, parent: entry.parent });
				if (node.child) pending.push({ node: node.child, parent: entry });
			}
			if (!found) fail("Inbox component is no longer mounted");
			// A reused child can still point back to an old ancestor via `return`.
			// Keep the ancestor path discovered in the committed tree itself.
			for (let i = 0; found && i < 16; i++, found = found.parent) yield found.node;
			return;
		}
		if (fiber?.alternate) fail("Committed inbox component is unavailable");
		for (let i = 0; fiber && i < 16; i++, fiber = fiber.return) yield fiber;
	}
	const props = (element, predicate) => {
		for (const fiber of fibers(element)) {
			if (predicate(fiber.memoizedProps)) return fiber.memoizedProps;
		}
		return null;
	};
	const show = async key => {
		const button = await wait(() => [...document.querySelectorAll(`[data-e2e="nav-${key}"]`)].find(visible));
		if (button.getAttribute("aria-pressed") !== "true") button.click();
	};
	if (feed === "activity") {
		await show("activity");
		const panel = await wait(() => [...document.querySelectorAll('[data-e2e="inbox-list"]')].find(visible));
		const source = () => props(panel, p => Array.isArray(p?.item?.notice_list) && typeof p.onHitBottom === "function");
		await wait(source);
		const current = () => {
			const value = source();
			if (!value || ![0, 1, false, true].includes(value.item.has_more) || typeof value.item.loading !== "boolean") fail("Activity loading state is unavailable");
			return value;
		};
		const load = async () => {
			await wait(() => !current().item.loading);
			const before = current().item;
			const stamp = JSON.stringify([before.min_time, before.max_time, before.notice_list.map(n => n.nid_str)]);
			await readWithinDeadline(() => current().onHitBottom());
			await wait(() => {
				const next = current().item;
				return !next.loading && (!next.has_more || JSON.stringify([next.min_time, next.max_time, next.notice_list.map(n => n.nid_str)]) !== stamp);
			});
		};
		// TikTok can display its empty placeholder before making the first request.
		// Its initial has_more=1 must never be interpreted as a successful empty read.
		await wait(() => !current().item.loading);
		if (!current().item.notice_list.length && current().item.has_more) await load();
		for (let page = 0; page < 20; page++) {
			const state = current().item;
			if (state.notice_list.some(n => typeof n.nid_str !== "string" || !/^\d+$/.test(n.nid_str))) fail("Activity source identity is unavailable");
			const start = cursor.after ? state.notice_list.findIndex(n => n.nid_str === cursor.after) + 1 : 0;
			if (cursor.after && !start) {
				if (!state.has_more) fail("Activity cursor expired; restart the read");
				await load();
				continue;
			}
			const items = state.notice_list.slice(start, start + limit);
			if (!items.length && state.has_more) { await load(); continue; }
			const rendered = new Map();
			for (const element of panel.querySelectorAll('[data-e2e="inbox-list-item"]')) {
				const item = props(element, p => typeof p?.item?.nid_str === "string")?.item;
				if (item) rendered.set(item.nid_str, element);
			}
			const rows = items.map(item => {
				const element = rendered.get(item.nid_str);
				const text = element?.innerText?.trim();
				if (!text) fail("An activity record has no rendered content; coverage is incomplete");
				const links = [...new Set([...element.querySelectorAll("a[href]")].map(a => {
					const url = new URL(a.href);
					return url.origin === location.origin ? `${url.origin}${url.pathname}` : null;
				}).filter(Boolean))];
				const seconds = Number(item.create_time);
				if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 8640000000000) fail("Activity timestamp is unavailable");
				return { id: item.nid_str, origin_id: item.nid_str, type: item.type, text, occurred_at: new Date(seconds * 1000).toISOString(), read: item.has_read === true, source_url: links.find(url => /\/(video|photo)\/\d+$/.test(url)) ?? links[0] ?? location.origin, links };
			});
			const more = start + items.length < state.notice_list.length || !!state.has_more;
			return result(rows, more ? { after: items.at(-1).nid_str } : null);
		}
		fail("Activity cursor exceeds this read's page budget; restart the read");
	}
	await show("messages");
	const list = await wait(() => document.querySelector('[data-e2e="dm-new-conversation-list"]'));
	const clientApi = () => {
		const elements = [list, ...list.querySelectorAll("div")].slice(0,12);
		for (const element of elements) for (const fiber of fibers(element)) {
			let hook = fiber.memoizedState;
			for (let i = 0; hook && i < 180; i++, hook = hook.next) {
				const api = hook.memoizedState?.current?.value;
				if (api?.stateStore && typeof api.stateStore.isInitSucceeded === "boolean" && typeof api.instance?.getConversationList === "function" && typeof api.instance?.getMessagesByConversation === "function") return api;
			}
		}
		return null;
	};
	const api = await wait(clientApi);
	if (api.instance.ctx?.option?.userId !== owner) fail("Message client belongs to a different account", "account_mismatch");
	await wait(() => {
		if (api.stateStore.isInitError || api.stateStore.isNotAvailable) fail("Message initialization failed");
		return api.stateStore.isInitSucceeded && api.stateStore.isInitLoadDone;
	});
	const sourceThreads = api.instance.getConversationList();
	if (!Array.isArray(sourceThreads)) fail("Conversation list is unavailable");
	if (sourceThreads.some(thread => typeof thread.id !== "string" || !/^[0-9:]{1,150}$/.test(thread.id))) fail("Conversation source identity is unavailable");
	if (sourceThreads.length > 200) fail("Conversation list exceeds this scan's budget; coverage is incomplete");
	const ids = sourceThreads.map(thread => thread.id);
	const snapshot = [...ids].sort();
	const finish = async (rows, next) => {
		const output = await result(rows, next);
		if (api.instance.ctx?.option?.userId !== owner) fail("Message client changed accounts during the read", "account_mismatch");
		const latest = api.instance.getConversationList();
		if (!Array.isArray(latest) || JSON.stringify(latest.map(thread => thread.id).sort()) !== JSON.stringify(snapshot)) fail("Conversation set changed; restart the read, previous coverage is incomplete");
		return output;
	};
	const validIds = values => Array.isArray(values) && values.length <= 200 && values.every(id => typeof id === "string" && ids.includes(id));
	if (input.cursor !== undefined) {
		if (!Array.isArray(cursor.snapshot) || JSON.stringify(cursor.snapshot) !== JSON.stringify(snapshot)) fail("Conversation set changed; restart the read, previous coverage is incomplete");
		if (!ids.includes(cursor.thread) || !["recent", "history"].includes(cursor.phase) || (cursor.phase === "history" ? cursor.after === undefined : cursor.after !== undefined) || !validIds(cursor.remaining) || !Array.isArray(cursor.history) || cursor.history.length > 200 || cursor.history.some(item => !ids.includes(item?.thread) || typeof item.after !== "string" || !/^\d+$/.test(item.after))) fail("Invalid conversation scan cursor");
	}
	// Take one recent page per conversation before draining old history. Preserve
	// the initial order across recency changes; set changes require a fresh scan.
	const phase = cursor.phase ?? "recent";
	const remaining = cursor.remaining ?? ids.slice(1);
	const history = cursor.history ?? [];
	const thread = sourceThreads.find(thread => thread.id === (cursor.thread ?? ids[0]));
	if (!thread) return finish([], null);
	if (typeof thread.getMessageList !== "function" || typeof thread.hasMoreMessages !== "boolean") fail("Conversation loading state is unavailable");
	const project = message => {
		if (typeof message.serverId !== "string" || !/^\d+$/.test(message.serverId) || message.conversationId !== thread.id) fail("Message source identity is unavailable");
		let content;
		try { content = typeof message.content === "string" ? JSON.parse(message.content) : message.content; } catch { fail("Message content is unavailable"); }
		const timestamp = message.createdAt?.getTime?.();
		if (!Number.isFinite(timestamp) || typeof message.isFromMe !== "boolean") fail("Message timestamp or direction is unavailable");
		const plainText = message.type === 7 && typeof content?.text === "string" && Object.keys(content).every(key => key === "text");
		return { id: message.serverId, origin_id: message.serverId, conversation_id: thread.id, conversation_name: thread.isGroupChat ? thread.coreInfo?.name ?? null : null, source_url: location.origin, text: message.isRecalled ? "" : typeof content?.text === "string" ? content.text : typeof content?.tips === "string" ? content.tips : "", type: message.type, sender_id: typeof message.sender === "string" ? message.sender : null, from_me: message.isFromMe, occurred_at: new Date(timestamp).toISOString(), recalled: message.isRecalled === true, has_uninspected_content: !plainText };
	};
	for (let page = 0; page < 20; page++) {
		await wait(() => !thread.isPullingMessages);
		if (api.instance.ctx?.option?.userId !== owner) fail("Message client changed accounts during the read", "account_mismatch");
		const messages = thread.getMessageList().map(project).sort((a,b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id));
		const start = cursor.after ? messages.findIndex(message => message.id === cursor.after) + 1 : 0;
		if ((cursor.after && !start) || start === messages.length && thread.hasMoreMessages) {
			if (!thread.hasMoreMessages) fail("Message cursor expired; restart the read");
			const response = await readWithinDeadline(() => api.instance.getMessagesByConversation({ conversation: thread, limit: 50 }));
			if (typeof response?.hasMore !== "boolean" || !Array.isArray(response.messages)) fail("Message history returned no completion state");
			if (response.hasMore && !response.messages.length) fail("Message history did not advance");
			continue;
		}
		const rows = messages.slice(start, start + limit);
		const more = start + rows.length < messages.length || thread.hasMoreMessages;
		const queued = [...history];
		if (more && phase === "recent") queued.push({ thread: thread.id, after: rows.at(-1).id });
		const base = { snapshot, remaining, history: queued };
		const next = phase === "recent" && remaining.length
			? { ...base, phase: "recent", thread: remaining[0], remaining: remaining.slice(1) }
			: more && phase === "history"
				? { ...base, phase, thread: thread.id, after: rows.at(-1).id }
				: queued.length ? { ...base, phase: "history", ...queued[0], history: queued.slice(1) } : null;
		return finish(rows, next);
	}
	fail("Message cursor exceeds this read's page budget; restart the read");
}
