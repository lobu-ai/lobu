import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
