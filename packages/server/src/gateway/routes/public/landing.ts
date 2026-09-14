import { Hono } from "hono";

export function createLandingRoutes() {
  const app = new Hono();

  app.get("/", (c) => {
    // These are pointers a client follows, so they have to carry the prefix
    // this gateway is mounted under: nothing standalone, `/lobu` on the
    // embedded server (a bare `/api/docs` lands in the main app there). On the
    // app root, `c.req.path` IS that prefix.
    const mount = c.req.path.replace(/\/+$/, "");
    return c.json({
      name: "Lobu Gateway",
      mode: "api-only",
      docs: `${mount}/api/docs`,
      health: `${mount}/health`,
    });
  });

  return app;
}
