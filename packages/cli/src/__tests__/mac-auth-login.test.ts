import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Lobu.app signs in through this bundled entrypoint (scripts/build-mac-auth-cli.sh),
// so whatever it registers is what the browser approval page shows the user.
const macAuthEntry = resolve(import.meta.dir, "../mac-auth.ts");
const cliIndex = resolve(import.meta.dir, "../index.ts");

type Captured = {
  registration?: Record<string, unknown>;
  deviceScope?: string;
  stdout: string;
};

async function runLogin(target: "mac" | "cli"): Promise<Captured> {
  const scratch = await mkdtemp(join(tmpdir(), "lobu-mac-auth-"));
  let entry = macAuthEntry;
  if (target === "cli") {
    // The published `lobu` binary runs `runCli` from the built bundle; drive
    // the same function from source.
    entry = join(scratch, "lobu-cli.ts");
    await writeFile(
      entry,
      `import { runCli } from ${JSON.stringify(cliIndex)};\nawait runCli(process.argv);\n`
    );
  }
  const captured: Captured = { stdout: "" };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { origin, pathname } = new URL(request.url);
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
          captured.registration = (await request.json()) as Record<
            string,
            unknown
          >;
          return Response.json({ client_id: "test-client" });
        case "/device": {
          const body = (await request.json()) as { scope?: string };
          captured.deviceScope = body.scope;
          return Response.json({
            device_code: "test-device",
            user_code: "TEST-CODE",
            verification_uri: `${origin}/oauth/device`,
            verification_uri_complete: `${origin}/oauth/device?user_code=TEST-CODE`,
            expires_in: 60,
            interval: 1,
          });
        }
        case "/token":
          return Response.json({
            access_token: "test-access",
            refresh_token: "test-refresh",
            expires_in: 3600,
          });
        case "/userinfo":
          return Response.json({ sub: "test-user", email: "test@example.com" });
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });
  try {
    const child = spawn(
      "bun",
      [entry, "login", "--force", "--wait-for-approval"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: scratch,
          LOBU_API_URL: server.url.origin,
          LOBU_CONTEXT: "lobu",
          NO_COLOR: "1",
        },
      }
    );
    child.stdout.on("data", (chunk) => {
      captured.stdout += chunk;
    });
    const exitCode = await new Promise<number | null>((done, reject) => {
      child.on("error", reject);
      child.on("close", done);
    });
    expect(exitCode).toBe(0);
    return captured;
  } finally {
    server.stop(true);
    await rm(scratch, { recursive: true, force: true });
  }
}

describe("Lobu for Mac sign-in identity", () => {
  test("temporary refresh failures preserve the login and a later whoami recovers", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "lobu-mac-refresh-"));
    const configDir = join(scratch, ".config", "lobu");
    const credentialsFile = join(configDir, "credentials.json");
    let response = () => new Response("Unavailable", { status: 503 });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/token") return response();
        return Response.json({ organizations: [] });
      },
    });
    try {
      await mkdir(configDir, { recursive: true });
      const saved = JSON.stringify({
        version: 2,
        contexts: {
          other: { accessToken: "unrelated-fixture-access" },
          fixture: {
            accessToken: "expired-fixture-access",
            refreshToken: "fixture-refresh",
            expiresAt: 1,
            oauth: {
              clientId: "fixture-client",
              tokenEndpoint: `${server.url.origin}/token`,
            },
          },
        },
      });
      await writeFile(credentialsFile, saved);
      const preload = join(scratch, "isolate.ts");
      await writeFile(
        preload,
        `import { mock } from "bun:test";
        import * as os from "node:os";
        mock.module("node:os", () => ({ ...os, homedir: () => ${JSON.stringify(scratch)} }));`
      );
      async function whoami() {
        const child = spawn(
          "bun",
          [
            "--preload",
            preload,
            macAuthEntry,
            "whoami",
            "--json",
            "--context",
            "fixture",
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              LOBU_API_URL: server.url.origin,
              LOBU_API_TOKEN: "",
              LOBU_CONTEXT: "fixture",
            },
          }
        );
        let stdout = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.resume();
        const code = await new Promise<number | null>((done, reject) => {
          child.on("error", reject);
          child.on("close", done);
        });
        return { code, stdout };
      }
      for (const failure of [
        () => new Response("Unavailable", { status: 503 }),
        () =>
          Response.json({ error: "temporarily_unavailable" }, { status: 400 }),
        () => new Response("Rate limited", { status: 429 }),
        () => Response.json({ error: "invalid_grant" }, { status: 500 }),
        () => Response.json({ error: "invalid_request" }, { status: 400 }),
        () => Response.json(null),
        () => new Response("invalid json"),
        () => Response.json({ refresh_token: "incomplete-response" }),
      ]) {
        response = failure;
        const result = await whoami();
        expect(result.code).not.toBe(0);
        expect(result.stdout).toBe("");
        expect(await readFile(credentialsFile, "utf8")).toBe(saved);
      }
      response = () =>
        Response.json({
          access_token: "fresh-fixture-access",
          refresh_token: "rotated-fixture-refresh",
          expires_in: 3600,
        });
      const recovered = await whoami();
      expect(recovered.code).toBe(0);
      expect(JSON.parse(recovered.stdout).loggedIn).toBe(true);
      const updated = JSON.parse(await readFile(credentialsFile, "utf8"));
      expect(updated.contexts.fixture.refreshToken).toBe(
        "rotated-fixture-refresh"
      );

      // A definitive grant rejection still requires sign-in.
      await writeFile(credentialsFile, saved);
      response = () =>
        Response.json({ error: "invalid_grant" }, { status: 400 });
      const rejected = await whoami();
      expect(rejected.code).toBe(0);
      expect(JSON.parse(rejected.stdout).loggedIn).toBe(false);
      const rejectedStore = JSON.parse(await readFile(credentialsFile, "utf8"));
      expect(rejectedStore.contexts.fixture).toBeUndefined();
      expect(rejectedStore.contexts.other.accessToken).toBe(
        "unrelated-fixture-access"
      );
    } finally {
      server.stop(true);
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("the bundled Mac auth helper registers as Lobu for Mac and returns the browser to the app", async () => {
    const { registration, deviceScope, stdout } = await runLogin("mac");

    expect(registration?.client_name).toBe("Lobu for Mac");
    // The Mac app hands this credential to its Terminal agent handoff and
    // shares the context with the `lobu` CLI, so it keeps the CLI's scope.
    expect(deviceScope).toBe(
      "device_worker:run mcp:read mcp:write mcp:admin profile:read connections:token"
    );
    expect(stdout).toContain(
      "/oauth/device?user_code=TEST-CODE&return_to=lobu%3A%2F%2F"
    );
    expect(stdout).toContain("Code: TEST-CODE");
  }, 30_000);

  test("the terminal CLI keeps its own name and terminal approval URL", async () => {
    const { registration, stdout } = await runLogin("cli");

    expect(registration?.client_name).toBe("Lobu CLI");
    expect(stdout).toContain("/oauth/device?user_code=TEST-CODE");
    expect(stdout).not.toContain("return_to");
  }, 30_000);
});
