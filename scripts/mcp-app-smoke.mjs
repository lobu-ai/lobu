/** Render the shipped MCP App in Chromium with a synthetic MCP host.
 * No tool requests leave the harness.
 *
 *   <url> [fixture.json]                  a deployed URL, or the candidate image
 *   --dist <dist-mcp-apps/interaction>    the built bundle, in required CI
 *
 * The optional fixture is written by `mcp-image-smoke.mjs`: it threads that
 * run's real served shell and real tool rejection in, so the rendered failure
 * is the one the gateway actually returns rather than a copy of it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const args = process.argv.slice(2);
const dist = args[0] === "--dist" ? resolve(args[1]) : null;
const base = dist ? null : new URL(args[0] || "https://app.lobu.ai");
const hasFixture = !dist && args[1] !== undefined;
const fixture = hasFixture ? JSON.parse(await readFile(args[1], "utf8")) : null;
if (hasFixture) {
  assert(
    fixture?.toolResult?.isError === true,
    "fixture must contain the real tool rejection"
  );
  assert(
    typeof fixture.html === "string" && fixture.html.trim(),
    "fixture must contain the served MCP shell"
  );
}
const toolResult = fixture
  ? fixture.toolResult
  : {
      isError: true,
      content: [
        { type: "text", text: "Pass an explicit workspace target (org_slug)." },
      ],
    };
const errors = [];
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (pathname === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end("<!doctype html><html><body></body></html>");
      return;
    }
    // Only --dist serves local files, and only these two shapes: anything
    // else (including a traversal) falls through to the 404 below.
    assert(
      dist && /^(?:\/assets\/[a-zA-Z0-9._-]+|\/index\.html)$/.test(pathname)
    );
    res.setHeader(
      "Content-Type",
      extname(pathname) === ".js"
        ? "text/javascript"
        : extname(pathname) === ".css"
          ? "text/css"
          : "text/html"
    );
    res.end(await readFile(resolve(dist, `.${pathname}`)));
  } catch {
    res.writeHead(404).end("missing smoke asset");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const host = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const shell = dist
    ? `${host}/index.html`
    : new URL("/mcp-apps/interaction/index.html", base).href;
  const response = await fetch(shell, { signal: AbortSignal.timeout(20000) });
  assert(
    response.ok && response.headers.get("content-type")?.includes("text/html"),
    "MCP shell must be HTML"
  );
  const fetched = await response.text();
  // Only the raw built bundle still has relative `./assets/…`. Everything the
  // gateway serves has already been rewritten to absolute URLs, precisely
  // because a real MCP host's `base-uri 'self'` drops a `<base>` tag
  // (`utils/mcp-app-bundle.ts`) — so the deployed paths must render without
  // one, and only `--dist` gets a base to resolve against inside `srcdoc`.
  const html =
    fixture?.html ??
    (dist
      ? fetched.replace("<head>", `<head><base href="${shell}">`)
      : fetched);
  for (const scenario of [
    "error",
    "missing",
    "cancelled",
    "stalled-handshake",
  ]) {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(msg.text());
    });
    page.on("requestfailed", (request) =>
      errors.push(`asset request failed: ${request.failure()?.errorText}`)
    );
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 400)
        errors.push(`asset HTTP ${r.status()} for ${r.url()}`);
    });
    await page.goto(host);
    await page.evaluate(
      ({ html, scenario }) => {
        window.smokeCalls = [];
        window.smokeReady = false;
        const frame = document.createElement("iframe");
        frame.style.cssText = "width:800px;height:600px";
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          const msg = event.data;
          if (
            msg.method === "ui/initialize" &&
            scenario !== "stalled-handshake"
          ) {
            frame.contentWindow.postMessage(
              {
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                  protocolVersion: msg.params.protocolVersion,
                  hostInfo: { name: "smoke-host", version: "1.0.0" },
                  hostCapabilities: {},
                  hostContext: {
                    theme: "light",
                    toolInfo: {
                      tool: {
                        name: "save_memory",
                        inputSchema: { type: "object" },
                      },
                    },
                  },
                },
              },
              "*"
            );
          } else if (msg.method === "ui/notifications/initialized") {
            window.smokeReady = true;
          } else if (
            msg.method === "tools/call" ||
            msg.method === "ui/message"
          ) {
            window.smokeCalls.push(msg.method);
          }
        });
        window.smokeNotify = (method, params) =>
          frame.contentWindow.postMessage(
            { jsonrpc: "2.0", method, params },
            "*"
          );
        frame.srcdoc = html;
        document.body.append(frame);
      },
      { html, scenario }
    );
    const frame = page.frameLocator("iframe");
    if (scenario !== "stalled-handshake")
      await page.waitForFunction(() => window.smokeReady, null, {
        timeout: 10000,
      });
    if (scenario === "error") {
      await page.evaluate(
        (result) => window.smokeNotify("ui/notifications/tool-result", result),
        toolResult
      );
    } else if (scenario === "cancelled") {
      await page.evaluate(() =>
        window.smokeNotify("ui/notifications/tool-cancelled", {
          reason: "cancelled",
        })
      );
    }
    // Real wall clock: proves the production deadline, without modifying timers.
    const alert = frame.getByRole("alert");
    await alert.waitFor({ state: "visible", timeout: 35000 });
    assert.match(
      await alert.innerText(),
      scenario === "error"
        ? /explicit workspace/
        : scenario === "cancelled"
          ? /cancelled/i
          : /unavailable|could not connect/i,
      `${scenario}: the notice must name what happened`
    );
    assert.equal(
      await frame.locator("html").getAttribute("data-ready"),
      "true",
      `${scenario}: a terminal notice must still report the runtime ready`
    );
    assert.equal(
      await frame.getByText("Loading…", { exact: true }).count(),
      0,
      `${scenario}: must not be left spinning`
    );
    if (scenario === "missing") {
      await page.evaluate(() =>
        window.smokeNotify("ui/notifications/tool-result", {
          content: [],
          structuredContent: {
            version: 1,
            title: "Recovered smoke result",
            blocks: [{ type: "text", value: "Late result arrived" }],
            actions: [],
          },
        })
      );
      await frame
        .getByText("Late result arrived", { exact: true })
        .waitFor({ state: "visible", timeout: 5000 });
      assert.equal(
        await alert.count(),
        0,
        "a late authoritative result must clear the notice"
      );
    }
    assert.deepEqual(
      await page.evaluate(() => window.smokeCalls),
      [],
      "the card must not retry a write or send a message"
    );
    console.log(
      `ok — MCP App ${scenario}${scenario === "missing" ? " + late recovery" : ""}`
    );
    await page.close();
  }
  assert.deepEqual(errors, [], "browser runtime and asset failures");
  console.log("MCP App smoke PASSED");
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
