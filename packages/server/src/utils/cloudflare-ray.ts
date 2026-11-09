/** Normalize the bounded Cloudflare request id shared by logs and spans. */
export function cloudflareRayId(header: string | null | undefined): string | null {
	const id = header?.split("-", 1)[0]?.trim();
	return id && /^[0-9a-f]{16}$/i.test(id) ? id.toLowerCase() : null;
}
