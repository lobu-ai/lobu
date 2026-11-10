import type { BrowserType } from "playwright-vanilla";
import {
  VALIDATION_TIMEOUT_MS,
  validationIdentity,
  type ValidationRequest,
  type ValidationResult,
} from "../../packages/server/src/views/validation-contract";

/** 1x1 transparent GIF served for images from a view's declared origins. */
const BLANK_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

/** Fresh browser per candidate: no cookies, reusable pages, API credentials,
 * network access, or author code in the API process. The container is a second
 * boundary; Chromium's own sandbox remains enabled. */
export async function validateCandidate(
  input: ValidationRequest,
  chromium: BrowserType
): Promise<ValidationResult> {
  const identity = validationIdentity(input.artifact);
  // A runner request from before views declared resources carries none.
  const imageOrigins = new Set(input.resources ?? []);
  const diagnostics: string[] = [];
  const started = Date.now();
  const server = await chromium.launchServer({
    headless: true,
    chromiumSandbox: true,
    host: "127.0.0.1",
    timeout: 5000,
    env: { PATH: process.env.PATH ?? "", HOME: "/tmp", TMPDIR: "/tmp" },
  });
  let expired = false;
  const deadline = setTimeout(
    () => {
      expired = true;
      // Force termination does not depend on a responsive authored renderer.
      server.process().kill("SIGKILL");
    },
    Math.max(1, VALIDATION_TIMEOUT_MS - 1000 - (Date.now() - started))
  );
  let browser: import("playwright-vanilla").Browser | undefined;
  try {
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 5000 });
    for (const scenario of input.scenarios) {
      const context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
        viewport: {
          width: scenario.theme === "dark" ? 390 : 1000,
          height: 700,
        },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(3000);
      const failures: string[] = [];
      const fail = (message: string) => {
        if (failures.length < 12) failures.push(message.slice(0, 500));
      };
      page.on("pageerror", (error) => fail(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") fail(message.text());
      });
      page.on("popup", (popup) => {
        fail("View opened an unbrokered window");
        void popup.close();
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", async (route) => {
        const request = route.request();
        const asset = input.artifact.assets[request.url()];
        if (request.method() === "GET" && asset) {
          await route.fulfill({
            body: asset.body,
            contentType: asset.contentType,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        } else if (
          request.resourceType() === "image" &&
          imageOrigins.has(new URL(request.url()).origin)
        ) {
          // A declared image origin (map tiles): allowed in the product, but
          // the runner stays offline, so a blank pixel answers it here.
          // Aborting would log "Failed to load resource", a failure above.
          await route.fulfill({ body: BLANK_GIF, contentType: "image/gif" });
        } else {
          fail(
            `Unbrokered network request: ${new URL(request.url()).protocol}`
          );
          await route.abort();
        }
      });
      try {
        // The parent is trusted runner code; the authored document remains an
        // opaque allow-scripts iframe, matching the product host.
        await page.setContent(
          '<!doctype html><iframe sandbox="allow-scripts" style="width:100%;height:650px;border:0"></iframe>'
        );
        await page.evaluate(
          ({ artifact, scenario }) => {
            const frame = document.querySelector("iframe")!;
            const send = (message: Record<string, unknown>) =>
              frame.contentWindow!.postMessage(
                { jsonrpc: "2.0", ...message },
                "*"
              );
            (
              window as unknown as { validationReady: boolean }
            ).validationReady = false;
            window.addEventListener("message", (event) => {
              if (
                event.source !== frame.contentWindow ||
                event.data?.jsonrpc !== "2.0"
              )
                return;
              const { id, method, params } = event.data;
              if (method === "ui/notifications/initialized") {
                (
                  window as unknown as { validationReady: boolean }
                ).validationReady = true;
              }
              if (id === undefined || !method) return;
              let result: unknown = {};
              if (method === "ui/initialize") {
                send({
                  id,
                  result: {
                    protocolVersion: "2026-01-26",
                    hostInfo: { name: "view-validator", version: "1" },
                    hostContext: {
                      theme: scenario.theme,
                      displayMode: scenario.displayMode,
                      availableDisplayModes: ["inline", "fullscreen"],
                    },
                  },
                });
                send({
                  method: "ui/notifications/tool-input",
                  params: {
                    arguments: {
                      organization: "validation-workspace",
                      scope: scenario.scope,
                      params: scenario.params,
                    },
                  },
                });
                return;
              }
              if (method === "tools/call") {
                if (scenario.queryState === "loading") return;
                const name = params?.name;
                const args = params?.arguments;
                const empty = scenario.queryState === "empty";
                if (
                  empty &&
                  name === "manage_entity" &&
                  args?.action === "list"
                ) {
                  result = {
                    structuredContent: {
                      action: "list",
                      entities: [],
                      metadata: {
                        page_size: args.limit ?? 100,
                        has_more: false,
                      },
                    },
                  };
                } else if (
                  empty &&
                  name === "manage_entity" &&
                  args?.action === "list_links"
                ) {
                  result = {
                    structuredContent: { action: "list_links", links: [] },
                  };
                } else if (
                  empty &&
                  name === "manage_entity_schema" &&
                  args?.action === "list"
                ) {
                  result = {
                    structuredContent: { action: "list", entity_types: [] },
                  };
                } else if (empty && name === "query_sql") {
                  result = {
                    structuredContent: {
                      rows: [],
                      row_count: 0,
                      truncated: false,
                    },
                  };
                } else {
                  result = {
                    isError: true,
                    structuredContent: {
                      error: { code: "UPSTREAM_UNAVAILABLE" },
                    },
                    content: [
                      {
                        type: "text",
                        text: "Validation fixture: data unavailable",
                      },
                    ],
                  };
                }
              } else if (
                method === "lobu/open-record" ||
                method === "ui/open-link"
              ) {
                result = {
                  isError: true,
                  content: [
                    { type: "text", text: "Validation does not navigate" },
                  ],
                };
              }
              send({ id, result });
            });
            frame.srcdoc = artifact.html;
          },
          { artifact: input.artifact, scenario }
        );
        await page.waitForFunction(
          () =>
            (window as unknown as { validationReady: boolean }).validationReady
        );
        const frame = page.frameLocator("iframe");
        await frame.locator("#root").waitFor({ state: "attached" });
        // Let initial effects, broker replies and React's error boundary settle.
        await page.waitForTimeout(100);
        const failedRender = await frame
          .locator("[data-lobu-render-error]")
          .count();
        if (failedRender)
          fail(
            (await frame.locator("[data-lobu-render-error]").textContent()) ??
              "Render failed"
          );
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      for (const failure of failures)
        diagnostics.push(
          `${scenario.theme}/${scenario.queryState}: ${failure.slice(0, 500)}`
        );
      await context.close();
      if (diagnostics.length) break;
    }
    if (expired) throw new Error("Validation runner deadline exceeded");
    return {
      ...identity,
      passed: diagnostics.length === 0,
      diagnostics: diagnostics.slice(0, 12),
    };
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await server.close();
  }
}
