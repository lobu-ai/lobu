// Self-contained browser adapter. Serialized into the user's paired browser;
// keep every dependency inside this function, as in the WhatsApp page adapter.
export async function tiktokPage(command, args = {}) {
	const visible = (e) => !!e && e.getClientRects().length > 0;
	const scope = () => {
		const script = document.querySelector("#__UNIVERSAL_DATA_FOR_REHYDRATION__");
		return script ? JSON.parse(script.textContent).__DEFAULT_SCOPE__ || {} : {};
	};
	const identity = () => {
		const user = scope()["webapp.app-context"]?.user;
		return typeof user?.uid === "string" && /^[0-9]+$/.test(user.uid)
			? { accountId: user.uid, displayName: user.uniqueId } : null;
	};
	const wait = async (read) => {
		for (let i = 0; i < 40; i++) {
			const value = read();
			if (value) return value;
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		throw new Error("TikTok page did not expose the requested content; it may be loading, signed out, or unavailable");
	};
	if (command === "identity") {
		try { return await wait(identity); } catch { return null; }
	}
	if (!identity()) throw new Error("TikTok sign-in is required");
	const project = (item) => ({
		id: item.id, desc: item.desc, createTime: item.createTime,
		author: item.author && { id: item.author.id, uniqueId: item.author.uniqueId, nickname: item.author.nickname },
		video: item.video && { duration: item.video.duration, width: item.video.width, height: item.video.height },
		imagePost: item.imagePost && { images: item.imagePost.images?.map(() => ({})) },
		stats: item.stats && { diggCount: item.stats.diggCount, commentCount: item.stats.commentCount, playCount: item.stats.playCount, shareCount: item.stats.shareCount },
		digged: item.digged,
	});
	if (command === "snapshot") {
		const d = scope();
		return { items: (d["webapp.updated-items"] || []).map(project) };
	}
	if (command === "post_links") {
		const links = [...document.querySelectorAll('a[href*="/video/"],a[href*="/photo/"]')];
		return { rows: links.filter(visible).map(a => ({
			url: a.href, text: a.querySelector("img")?.alt || a.innerText || "",
		})) };
	}
	const detail = args.source_item || await wait(() => scope()["webapp.video-detail"]?.itemInfo?.itemStruct);
	const target = new URL(args.url);
	if (!/^[A-Za-z0-9_.]{1,64}$/.test(detail.author?.uniqueId || "")) throw new Error("TikTok post author is invalid");
	if (location.origin !== target.origin || location.pathname !== target.pathname || detail.id !== target.pathname.split("/").pop()) {
		throw new Error("TikTok post changed; refusing to act on a different post");
	}
	const card = await wait(() => document.querySelector('[data-e2e="recommend-list-item-container"]'));
	const author = card.querySelector(`a[href="/@${detail.author.uniqueId}"]`);
	const description = card.querySelector('[data-e2e="video-desc"]');
	const compact = text => String(text || "").replace(/\s+/g, "").trim();
	if (!author || (detail.desc && !compact(description?.textContent).includes(compact(detail.desc)))) {
		throw new Error("TikTok displayed post does not match the requested source record");
	}
	const likeButton = card.querySelector('[data-e2e="like-icon"]');
	const liked = () => {
		const value = likeButton?.getAttribute("aria-pressed");
		if (value !== "true" && value !== "false") throw new Error("TikTok like state is unavailable");
		return value === "true";
	};
	if (command === "detail") return { item: project(detail), liked: liked() };
	if (command === "mute") {
		card.querySelectorAll("video,audio").forEach(media => { media.muted = true; });
		return { muted: true };
	}
	if (command === "photo") {
		const count = detail.imagePost?.images?.length;
		const index = args.index;
		if (!Number.isInteger(index) || index < 0 || !count || index >= count) throw new Error("Photo index is outside this post");
		const carousel = card.querySelector(".swiper")?.swiper;
		if (typeof carousel?.slideToLoop !== "function" || typeof carousel?.autoplay?.stop !== "function") throw new Error("TikTok photo carousel is unavailable");
		carousel.autoplay.stop();
		carousel.slideToLoop(index, 0);
		await wait(() => carousel.realIndex === index && !carousel.animating);
		const slide = card.querySelector(".swiper-slide-active");
		const image = slide?.querySelector("img");
		await wait(() => image?.complete && image.naturalWidth > 0);
		slide.scrollIntoView({ block: "center", behavior: "instant" });
		return { photo_index: index, photo_count: count };
	}
	if (command === "set_like") {
		if (typeof args.liked !== "boolean") throw new Error("liked must be a boolean");
		const before = liked();
		if (before !== args.liked) {
			likeButton.click();
			await wait(() => liked() === args.liked);
		}
		return { liked: liked(), changed: before !== args.liked };
	}
	if (command === "frame") {
		const video = card.querySelector("video");
		if (!video) throw new Error("No playable video on this post");
		video.muted = true;
		await video.play();
		await wait(() => video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0);
		video.pause();
		const seconds = args.seconds;
		if (!Number.isFinite(seconds) || seconds < 0 || seconds >= video.duration) throw new Error("Frame time is outside the video duration");
		video.currentTime = seconds;
		await wait(() => !video.seeking && Math.abs(video.currentTime - seconds) < 0.15 && video.readyState >= 2);
		video.scrollIntoView({ block: "center", behavior: "instant" });
		return { seconds: video.currentTime, duration_seconds: video.duration };
	}
	if (command === "open_comment") {
		const existing = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].find(visible);
		if (!existing) {
			const button = card.querySelector('[data-e2e="comment-icon"]');
			if (!button) throw new Error("TikTok comment control is unavailable");
			button.click();
		}
		const editor = await wait(() => [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].find(visible));
		if (editor.textContent.trim()) throw new Error("The comment composer already contains text; preserving the user's draft");
		editor.scrollIntoView({ block: "center", behavior: "instant" });
		return { opened: true };
	}
	if (command === "comment_text") {
		const editors = [...document.querySelectorAll('[contenteditable="true"][role="textbox"]')].filter(visible);
		if (editors.length !== 1) throw new Error("TikTok comment composer is ambiguous");
		return { text: editors[0].innerText };
	}
	throw new Error("Unsupported TikTok page command");
}
