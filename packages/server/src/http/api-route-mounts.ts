import type { Hono } from "hono";
import type { Env } from "../index";

/** Mount public apps in precedence order so /api/v1 is never parsed as /api/:orgSlug. */
export function mountPublicApps(
	wrapper: Hono<{ Bindings: Env }>,
	lobuApp: Hono | null,
	mainApp: Hono<{ Bindings: Env }>,
): void {
	if (lobuApp) {
		// Forward the original request rather than mounting the child at /api/v1:
		// its routes include that prefix and must see the complete path.
		wrapper.all("/api/v1", (c) => lobuApp.fetch(c.req.raw, c.env));
		wrapper.all("/api/v1/*", (c) => lobuApp.fetch(c.req.raw, c.env));
		wrapper.route("/lobu", lobuApp);
	}
	wrapper.route("/", mainApp);
}
