import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cli = resolve(import.meta.dir, "../../bin/lobu.js");

describe("device-code login under Node", () => {
  for (const columns of [0, 80]) {
    test(`saves credentials with ${columns} terminal columns`, async () => {
      const scratch = await mkdtemp(join(tmpdir(), "lobu-login-"));
      const calls: string[] = [];
      let polls = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const { origin, pathname } = new URL(request.url);
          calls.push(pathname);
          switch (pathname) {
            case "/.well-known/oauth-authorization-server":
              return Response.json({
                issuer: origin,
                registration_endpoint: `${origin}/register`,
                device_authorization_endpoint: `${origin}/device`,
                token_endpoint: `${origin}/token`,
                userinfo_endpoint: `${origin}/userinfo`,
                grant_types_supported: [
                  "urn:ietf:params:oauth:grant-type:device_code",
                ],
              });
            case "/register":
              return Response.json({ client_id: "test-client" });
            case "/device":
              return Response.json({
                device_code: "test-device",
                user_code: "TEST-CODE",
                verification_uri: `${origin}/approve`,
                expires_in: 60,
                interval: 1,
              });
            case "/token":
              polls++;
              return polls < 4
                ? Response.json(
                    { error: "authorization_pending" },
                    { status: 400 }
                  )
                : Response.json({
                    access_token: "test-access",
                    refresh_token: "test-refresh",
                    expires_in: 3600,
                  });
            case "/userinfo":
              return Response.json({
                sub: "test-user",
                email: "test@example.com",
              });
            default:
              return new Response("Not found", { status: 404 });
          }
        },
      });
      try {
        // Match the TTY state of `script ... </dev/null`, including its zero
        // width. Keep Ora, timers, HTTP and credential writes real. Cursor
        // methods are sinks so an infinite redraw cannot flood test output.
        const preload = join(scratch, "terminal.mjs");
        await writeFile(
          preload,
          `for (const stream of [process.stdin, process.stdout, process.stderr]) {
            Object.defineProperty(stream, "isTTY", { value: true });
          }
          process.stderr.columns = ${columns};
          process.stderr.cursorTo = () => true;
          process.stderr.moveCursor = () => true;
          process.stderr.clearLine = () => true;
          process.stdin.setRawMode = () => process.stdin;
          `
        );
        const child = spawn(
          "node",
          ["--import", pathToFileURL(preload).href, cli, "login"],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              HOME: scratch,
              LOBU_API_URL: server.url.origin,
              LOBU_CONTEXT: "lobu",
              TERM: "xterm",
              CI: undefined,
            },
          }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 10_000);
        const exitCode = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        }).finally(() => clearTimeout(timer));
        expect({ timedOut, exitCode, calls, stdout, stderr }).toMatchObject({
          timedOut: false,
          exitCode: 0,
          calls: [
            "/.well-known/oauth-authorization-server",
            "/register",
            "/device",
            "/token",
            "/token",
            "/token",
            "/token",
            "/userinfo",
          ],
        });
        expect(stdout + stderr).toContain("Logged in to lobu.");
        const saved = JSON.parse(
          await readFile(join(scratch, ".config/lobu/credentials.json"), "utf8")
        );
        expect(saved.contexts.lobu).toMatchObject({
          accessToken: "test-access",
          refreshToken: "test-refresh",
          email: "test@example.com",
          userId: "test-user",
          oauth: { clientId: "test-client" },
        });
      } finally {
        server.stop(true);
        await rm(scratch, { recursive: true, force: true });
      }
    }, 15_000);
  }
});
