import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Credentials } from "../internal/credentials";
import {
  announceLocalSignIn,
  autoApplyLocalProject,
  findEnclosingMonorepoRoot,
  getLocalSignInWarning,
  isSharedDatabaseUrl,
  resolveBackendBundle,
  shouldAutoApplyLocalProject,
  shouldRefuseSharedDatabaseUrl,
  waitForServerReachable,
} from "../commands/dev";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

function readPackageJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

describe("lobu run backend bundle resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  test("finds the server bundle copied to the CLI dist root", () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-cli-dist-"));
    tempDirs.push(root);

    const commandsDir = join(root, "dist", "commands");
    mkdirSync(commandsDir, { recursive: true });

    // Single bundle for both backends — it self-selects on DATABASE_URL.
    const bundlePath = join(root, "dist", "server.bundle.mjs");
    writeFileSync(bundlePath, "// bundle placeholder\n");

    expect(resolveBackendBundle(commandsDir)).toBe(bundlePath);
  });

  test("CLI package declares runtime deps for the embedded server bundle", () => {
    const cli = readPackageJson(
      join(repoRoot, "packages", "cli", "package.json")
    );
    const server = readPackageJson(
      join(repoRoot, "packages", "server", "package.json")
    );
    const core = readPackageJson(
      join(repoRoot, "packages", "core", "package.json")
    );
    const connectorSdk = readPackageJson(
      join(repoRoot, "packages", "connector-sdk", "package.json")
    );
    const cliRuntimeDeps = {
      ...cli.dependencies,
      ...cli.optionalDependencies,
    };

    expect(cliRuntimeDeps["@lobu/embeddings"]).toBeDefined();

    const assertDeclared = (deps: Record<string, string> | undefined) => {
      for (const name of Object.keys(deps ?? {})) {
        if (name.startsWith("@lobu/")) continue;
        expect(cliRuntimeDeps[name]).toBeDefined();
      }
    };

    // `lobu run` executes packages/server/dist/server.bundle.mjs from inside
    // the published @lobu/cli package. The bundle inlines @lobu workspace
    // source, while non-workspace packages remain bare imports resolved from
    // @lobu/cli's node_modules.
    assertDeclared(server.dependencies);
    assertDeclared(server.optionalDependencies);
    assertDeclared(core.dependencies);
    assertDeclared(connectorSdk.dependencies);

    // These are server build/dev deps today, but the embedded runtime imports
    // them at startup, while compiling bundled connector code, or while running
    // the local embedded Postgres.
    for (const name of ["dotenv", "esbuild", "vite", "embedded-postgres"]) {
      expect(cliRuntimeDeps[name]).toBeDefined();
    }

    // @lobu/pgvector-embedded ships prebuilt native binaries esbuild can't
    // inline, and it's `private` (never published). It must therefore NOT be a
    // runtime/registry dependency of the published CLI — otherwise
    // `npm i @lobu/cli` would 404 on it. Instead build.cjs vendors it into
    // dist/vendor/pgvector-embedded, and embedded-runtime.ts loads it from
    // there when the bare specifier isn't resolvable.
    expect(cliRuntimeDeps["@lobu/pgvector-embedded"]).toBeUndefined();
    const cliBuildScript = readFileSync(
      join(repoRoot, "packages", "cli", "scripts", "build.cjs"),
      "utf8"
    );
    expect(cliBuildScript).toContain("dist/vendor/pgvector-embedded");

    // Compiled connector code deliberately leaves these native/browser deps
    // external, so npx-installed CLIs must provide them too.
    for (const name of ["playwright", "sharp", "jimp"]) {
      expect(cliRuntimeDeps[name]).toBeDefined();
    }
  });

  test("findEnclosingMonorepoRoot walks up from a project subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "lobu-cli-monorepo-"));
    tempDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] })
    );
    mkdirSync(join(root, "packages", "server", "src"), {
      recursive: true,
    });
    writeFileSync(
      join(root, "packages", "server", "src", "index.ts"),
      "// worker"
    );
    const subdir = join(root, "examples", "lobu-team");
    mkdirSync(subdir, { recursive: true });

    expect(findEnclosingMonorepoRoot(subdir)).toBe(root);
    expect(findEnclosingMonorepoRoot(root)).toBe(root);

    const lone = mkdtempSync(join(tmpdir(), "lobu-cli-lone-"));
    tempDirs.push(lone);
    expect(findEnclosingMonorepoRoot(lone)).toBeNull();
  });

  test("findEnclosingMonorepoRoot resolves this repo's root", () => {
    const found = findEnclosingMonorepoRoot(here);
    expect(found).not.toBeNull();
    expect(
      existsSync(join(found!, "packages", "server", "src", "index.ts"))
    ).toBe(true);
  });

  test("isSharedDatabaseUrl flags non-loopback hosts only", () => {
    // Loopback variants are NOT shared.
    expect(isSharedDatabaseUrl("postgres://user@localhost:5432/db")).toBe(
      false
    );
    expect(isSharedDatabaseUrl("postgres://user@127.0.0.1:5432/db")).toBe(
      false
    );
    expect(isSharedDatabaseUrl("postgres://user@[::1]:5432/db")).toBe(false);

    // Tailnet, prod, private LAN — all shared.
    expect(
      isSharedDatabaseUrl(
        "postgres://u:p@summaries-db.brill-kanyu.ts.net:5432/owletto"
      )
    ).toBe(true);
    expect(isSharedDatabaseUrl("postgres://u:p@db.example.com:5432/prod")).toBe(
      true
    );
    expect(isSharedDatabaseUrl("postgres://u:p@10.0.0.5:5432/dev")).toBe(true);

    // Garbage URL → not "shared" (the boot path will fail elsewhere).
    expect(isSharedDatabaseUrl("not-a-url")).toBe(false);

    // file:// embedded paths are LOCAL, never shared — even though their URL
    // hostname parses as empty. The menubar app passes file://<abs path>, so a
    // regression here refuses to boot the local embedded server.
    expect(isSharedDatabaseUrl("file:///Users/me/lobu/data")).toBe(false);
    expect(isSharedDatabaseUrl("file://.")).toBe(false);
    expect(isSharedDatabaseUrl("file:/Users/me/lobu/data")).toBe(false);
  });

  describe("shouldRefuseSharedDatabaseUrl", () => {
    const SHARED = "postgres://u:p@db.example.com:5432/prod";
    const LOCAL = "postgres://localhost:5432/proj_dev";

    test("refuses when a shared shell URL overrides a loopback .env URL", () => {
      // The footgun: .env pins a local DB, but the shell exports a prod URL
      // that wins the merge. Gating on .env presence alone used to pass here.
      expect(
        shouldRefuseSharedDatabaseUrl({
          effectiveDatabaseUrl: SHARED,
          projectEnvDatabaseUrl: LOCAL,
          unsafeSharedDb: false,
        })
      ).toBe(true);
    });

    test("allows when the project's own .env shared URL survives the merge", () => {
      // Pinning the shared URL in .env is explicit consent — the effective
      // value equals the project .env value, so the project owns it.
      expect(
        shouldRefuseSharedDatabaseUrl({
          effectiveDatabaseUrl: SHARED,
          projectEnvDatabaseUrl: SHARED,
          unsafeSharedDb: false,
        })
      ).toBe(false);
    });

    test("refuses a shared shell URL when .env pins nothing", () => {
      expect(
        shouldRefuseSharedDatabaseUrl({
          effectiveDatabaseUrl: SHARED,
          projectEnvDatabaseUrl: undefined,
          unsafeSharedDb: false,
        })
      ).toBe(true);
    });

    test("allows a loopback effective URL regardless of source", () => {
      expect(
        shouldRefuseSharedDatabaseUrl({
          effectiveDatabaseUrl: LOCAL,
          projectEnvDatabaseUrl: undefined,
          unsafeSharedDb: false,
        })
      ).toBe(false);
    });

    test("--unsafe-shared-db bypasses the refusal", () => {
      expect(
        shouldRefuseSharedDatabaseUrl({
          effectiveDatabaseUrl: SHARED,
          projectEnvDatabaseUrl: LOCAL,
          unsafeSharedDb: true,
        })
      ).toBe(false);
    });

    test("no effective URL means no refusal (embedded-Postgres path)", () => {
      expect(
        shouldRefuseSharedDatabaseUrl({
          effectiveDatabaseUrl: undefined,
          projectEnvDatabaseUrl: undefined,
          unsafeSharedDb: false,
        })
      ).toBe(false);
    });
  });

  test("CLI build copies local runtime assets for installed lobu run", () => {
    expect(existsSync(join(repoRoot, "db", "migrations"))).toBe(true);
    expect(
      existsSync(join(repoRoot, "packages", "cli", "scripts", "build.cjs"))
    ).toBe(true);

    const buildScript = readFileSync(
      join(repoRoot, "packages", "cli", "scripts", "build.cjs"),
      "utf8"
    );
    expect(buildScript).toContain('copyDirIfExists("../../db/migrations"');
    expect(buildScript).toContain('"server.bundle.mjs"');
    // The gate bundle dynamically imports server-main.bundle.mjs at runtime;
    // both must ship or `lobu run` breaks after the Node-version check passes.
    expect(buildScript).toContain('"server-main.bundle.mjs"');
  });
});

describe("shouldAutoApplyLocalProject", () => {
  test("applies for an embedded run once the selected context is ready", () => {
    expect(
      shouldAutoApplyLocalProject({
        mode: "embedded",
        localContextReady: true,
        hasLobuConfig: true,
      })
    ).toBe(true);
  });

  test("skips when sign-in did not establish the selected context", () => {
    // The guard that stops `lobu run` applying a local project to whatever
    // cloud/prod context happened to be active.
    expect(
      shouldAutoApplyLocalProject({
        mode: "embedded",
        localContextReady: false,
        hasLobuConfig: true,
      })
    ).toBe(false);
  });

  test("never auto-applies against an external backend", () => {
    expect(
      shouldAutoApplyLocalProject({
        mode: "external",
        localContextReady: true,
        hasLobuConfig: true,
      })
    ).toBe(false);
  });

  test("skips when the project has no lobu.config.ts to apply", () => {
    expect(
      shouldAutoApplyLocalProject({
        mode: "embedded",
        localContextReady: true,
        hasLobuConfig: false,
      })
    ).toBe(false);
  });
});

describe("lobu run local sign-in diagnostics", () => {
  const successfulResponse = () =>
    new Response(
      JSON.stringify({
        session_token: "session-secret",
        device_token: "device-secret",
        user: { id: "user-1", email: "dev@example.com" },
        organization: { slug: "local-install" },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  const dependencies = () => ({
    waitForReachable: async () => true,
    fetchImpl: async () => successfulResponse(),
    addContextImpl: async () => undefined,
    saveCredentialsImpl: async () => undefined,
    setActiveOrgImpl: async () => undefined,
    inspectContextImpl: async () => undefined,
    getCurrentContextNameImpl: async () => "local",
    setCurrentContextImpl: async () => undefined,
  });

  test("keeps the current /health liveness contract", async () => {
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      expect(await waitForServerReachable("http://127.0.0.1:8787", 100)).toBe(
        true
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requested).toEqual(["http://127.0.0.1:8787/health"]);
  });

  test("reports the stage when the server never becomes reachable", async () => {
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      waitForReachable: async () => false,
    });

    expect(result).toMatchObject({
      ready: false,
      stage: "server_unreachable",
    });
  });

  test("treats an external backend as an intentional skip", async () => {
    const result = await announceLocalSignIn("http://127.0.0.1:8787", false, {
      ...dependencies(),
      fetchImpl: async () => {
        throw new Error("must not call local-init");
      },
    });

    expect(result).toEqual({ ready: false, skipped: "external_backend" });
    expect(
      getLocalSignInWarning(result, {
        embedded: false,
        hasLobuConfig: true,
      })
    ).toBeNull();
  });

  test("reports a local-init HTTP failure without reading its body", async () => {
    let bodyRead = false;
    const response = new Response(
      JSON.stringify({ credential: "do-not-print" }),
      { status: 503 }
    );
    const originalJson = response.json.bind(response);
    response.json = async () => {
      bodyRead = true;
      return originalJson();
    };

    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      fetchImpl: async () => response,
    });

    expect(result).toEqual({
      ready: false,
      stage: "local_init_http",
      detail: "HTTP 503",
    });
    expect(bodyRead).toBe(false);
    expect(
      getLocalSignInWarning(result, {
        embedded: true,
        hasLobuConfig: true,
      })
    ).toBe(
      "Local sign-in failed during the local-init request (HTTP 503); project auto-apply was skipped."
    );
  });

  test("reports a rejected local-init request without echoing its error", async () => {
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      fetchImpl: async () => {
        throw new Error("credential=do-not-print");
      },
    });

    expect(result).toEqual({
      ready: false,
      stage: "local_init_http",
      detail: "request failed after the server became reachable",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-print");
    expect(
      getLocalSignInWarning(result, {
        embedded: true,
        hasLobuConfig: true,
      })
    ).toBe(
      "Local sign-in failed during the local-init request (request failed after the server became reachable); project auto-apply was skipped."
    );
  });

  test("reports an invalid local-init payload without echoing it", async () => {
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ credential: "do-not-print" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    expect(result).toEqual({
      ready: false,
      stage: "local_init_payload",
      detail: "response did not contain a session or device token",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-print");
    expect(
      getLocalSignInWarning(result, {
        embedded: true,
        hasLobuConfig: true,
      })
    ).toBe(
      "Local sign-in failed during the local-init response (response did not contain a session or device token); project auto-apply was skipped."
    );
  });

  test("reports invalid JSON without persisting or echoing its body", async () => {
    let persisted = false;
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      fetchImpl: async () =>
        new Response("credential=do-not-print", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      saveCredentialsImpl: async () => {
        persisted = true;
      },
    });

    expect(result).toEqual({
      ready: false,
      stage: "local_init_payload",
      detail: "response was not valid JSON",
    });
    expect(persisted).toBe(false);
    expect(JSON.stringify(result)).not.toContain("do-not-print");
  });

  test("reports a non-object local-init payload instead of throwing", async () => {
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      fetchImpl: async () => Response.json(null),
    });

    expect(result).toEqual({
      ready: false,
      stage: "local_init_payload",
      detail: "response did not contain a JSON object",
    });
  });

  test("rejects wrong-type tokens before persisting credentials", async () => {
    let persisted = false;
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      fetchImpl: async () =>
        Response.json({
          session_token: { credential: "malformed-secret-shape" },
          organization: { slug: "local-install" },
        }),
      saveCredentialsImpl: async () => {
        persisted = true;
      },
    });

    expect(result).toEqual({
      ready: false,
      stage: "local_init_payload",
      detail: "response contained invalid field types",
    });
    expect(persisted).toBe(false);
    expect(JSON.stringify(result)).not.toContain("malformed-secret-shape");
  });

  test("classifies a wrong-type organization slug as a payload failure", async () => {
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      fetchImpl: async () =>
        Response.json({
          session_token: "session-secret",
          organization: { slug: { invalid: true } },
        }),
    });

    expect(result).toEqual({
      ready: false,
      stage: "local_init_payload",
      detail: "response contained invalid field types",
    });
  });

  test("falls back to a valid device token when the session token is empty", async () => {
    let saved: Credentials | undefined;
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      fetchImpl: async () =>
        Response.json({
          session_token: "   ",
          device_token: "device-secret",
          organization: { slug: "local-install" },
        }),
      saveCredentialsImpl: async (credentials) => {
        saved = credentials;
      },
    });

    expect(result).toEqual({ ready: true, localOrgSlug: "local-install" });
    expect(saved).toMatchObject({
      accessToken: "device-secret",
      localWorkerToken: "device-secret",
    });
  });

  test("reports local context setup failures without echoing the error", async () => {
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      addContextImpl: async () => {
        throw new Error("credential=do-not-print");
      },
    });

    expect(result).toEqual({
      ready: false,
      stage: "context_setup",
      detail: 'could not register or persist the "local" context',
    });
    expect(JSON.stringify(result)).not.toContain("do-not-print");
    expect(
      getLocalSignInWarning(result, {
        embedded: true,
        hasLobuConfig: true,
      })
    ).toBe(
      'Local sign-in failed during local CLI context setup (could not register or persist the "local" context); project auto-apply was skipped.'
    );
  });

  test("returns ready after registering the local context", async () => {
    const calls: string[] = [];
    const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
      ...dependencies(),
      addContextImpl: async (name, url) => {
        calls.push(`context:${name}:${url}`);
      },
      saveCredentialsImpl: async (_credentials, name) => {
        calls.push(`credentials:${name}`);
      },
      setActiveOrgImpl: async (slug, name) => {
        calls.push(`org:${slug}:${name}`);
      },
    });

    expect(result).toEqual({ ready: true, localOrgSlug: "local-install" });
    expect(calls).toEqual([
      "context:local:http://127.0.0.1:8787",
      "credentials:local",
      "org:local-install:local",
    ]);
    expect(
      getLocalSignInWarning(result, {
        embedded: true,
        hasLobuConfig: true,
      })
    ).toBeNull();
  });

  test("isolates an explicit process context without changing the global default", async () => {
    const previousContext = process.env.LOBU_CONTEXT;
    const previousApiUrl = process.env.LOBU_API_URL;
    process.env.LOBU_CONTEXT = "__owletto_debug_v2__5:local";
    process.env.LOBU_API_URL = "http://localhost:8788";
    const calls: string[] = [];
    try {
      const result = await announceLocalSignIn("http://127.0.0.1:8788", true, {
        ...dependencies(),
        addContextImpl: async (name, url, server) => {
          calls.push(`context:${name}:${url}:${server?.lifecycle}`);
        },
        saveCredentialsImpl: async (_credentials, name) => {
          calls.push(`credentials:${name}`);
        },
        setActiveOrgImpl: async (slug, name) => {
          calls.push(`org:${slug}:${name}`);
        },
        getCurrentContextNameImpl: async () => {
          calls.push("read-current");
          return "local";
        },
        setCurrentContextImpl: async (name) => {
          calls.push(`set-current:${name}`);
        },
      });

      expect(result).toEqual({ ready: true, localOrgSlug: "local-install" });
      expect(calls).toEqual([
        "context:__owletto_debug_v2__5:local:http://127.0.0.1:8788:managed",
        "credentials:__owletto_debug_v2__5:local",
        "org:local-install:__owletto_debug_v2__5:local",
      ]);
    } finally {
      if (previousContext === undefined) delete process.env.LOBU_CONTEXT;
      else process.env.LOBU_CONTEXT = previousContext;
      if (previousApiUrl === undefined) delete process.env.LOBU_API_URL;
      else process.env.LOBU_API_URL = previousApiUrl;
    }
  });

  test("keeps a new explicit runner context ready across restarts", async () => {
    const previousContext = process.env.LOBU_CONTEXT;
    const previousApiUrl = process.env.LOBU_API_URL;
    process.env.LOBU_CONTEXT = "__owletto_debug_v2__5:local";
    process.env.LOBU_API_URL = "http://localhost:8788";
    let storedContext:
      | { url: string; lifecycle?: "managed" | "external" }
      | undefined;
    const testDependencies = {
      ...dependencies(),
      inspectContextImpl: async () => storedContext,
      addContextImpl: async (
        _name: string,
        url: string,
        server?: { lifecycle?: "managed" | "external" }
      ) => {
        storedContext = { url, lifecycle: server?.lifecycle };
      },
    };

    try {
      const first = await announceLocalSignIn(
        "http://127.0.0.1:8788",
        true,
        testDependencies
      );
      const second = await announceLocalSignIn(
        "http://127.0.0.1:8788",
        true,
        testDependencies
      );

      expect(first).toEqual({ ready: true, localOrgSlug: "local-install" });
      expect(second).toEqual({ ready: true, localOrgSlug: "local-install" });
      expect(storedContext).toEqual({
        url: "http://127.0.0.1:8788",
        lifecycle: "managed",
      });
    } finally {
      if (previousContext === undefined) delete process.env.LOBU_CONTEXT;
      else process.env.LOBU_CONTEXT = previousContext;
      if (previousApiUrl === undefined) delete process.env.LOBU_API_URL;
      else process.env.LOBU_API_URL = previousApiUrl;
    }
  });

  test.each([
    {
      name: "legacy lifecycle-less local context",
      contextName: "local",
      configured: { url: "http://localhost:8788" },
    },
    {
      name: "managed context with an API base path",
      contextName: "__owletto_debug_v2__5:local",
      configured: {
        url: "http://localhost:8788/api/v1",
        lifecycle: "managed" as const,
      },
    },
  ])("refreshes credentials for a $name", async ({
    contextName,
    configured,
  }) => {
    const previousContext = process.env.LOBU_CONTEXT;
    const previousApiUrl = process.env.LOBU_API_URL;
    process.env.LOBU_CONTEXT = contextName;
    process.env.LOBU_API_URL = "http://127.0.0.1:8788";
    const calls: string[] = [];

    try {
      const result = await announceLocalSignIn("http://127.0.0.1:8788", true, {
        ...dependencies(),
        inspectContextImpl: async () => configured,
        addContextImpl: async (name, url, server) => {
          calls.push(`context:${name}:${url}:${server?.lifecycle}`);
        },
        saveCredentialsImpl: async (_credentials, name) => {
          calls.push(`credentials:${name}`);
        },
      });

      expect(result).toEqual({ ready: true, localOrgSlug: "local-install" });
      expect(calls).toContain(`credentials:${contextName}`);
    } finally {
      if (previousContext === undefined) delete process.env.LOBU_CONTEXT;
      else process.env.LOBU_CONTEXT = previousContext;
      if (previousApiUrl === undefined) delete process.env.LOBU_API_URL;
      else process.env.LOBU_API_URL = previousApiUrl;
    }
  });

  // The Mac runner exports LOBU_CONTEXT straight from the CLI's ambient
  // `currentContext` and only pins LOBU_API_URL on Debug builds, so both of
  // these are what a shipped Release app actually produces for a user whose
  // selected context is a cloud entry. Refusing to repurpose that name is
  // correct; abandoning local sign-in because of it is not — the fallback has
  // to leave the user with a credentialed `local` context, a deep link, and
  // auto-apply, exactly as a bare `lobu run` does.
  test.each([
    {
      name: "an explicit remote context",
      contextName: "production",
      configured: {
        url: "https://app.lobu.ai/api/v1",
        lifecycle: "external" as const,
      },
    },
    {
      name: "an unknown context with no pinned endpoint",
      contextName: "lobu",
      configured: undefined,
    },
  ])("falls back to local rather than repurposing $name", async ({
    contextName,
    configured,
  }) => {
    const previousContext = process.env.LOBU_CONTEXT;
    const previousApiUrl = process.env.LOBU_API_URL;
    process.env.LOBU_CONTEXT = contextName;
    delete process.env.LOBU_API_URL;
    const calls: string[] = [];
    try {
      const result = await announceLocalSignIn("http://127.0.0.1:8787", true, {
        ...dependencies(),
        inspectContextImpl: async () => configured,
        addContextImpl: async (name, url, server) => {
          calls.push(`context:${name}:${url}:${server?.lifecycle}`);
        },
        saveCredentialsImpl: async (_credentials, name) => {
          calls.push(`credentials:${name}`);
        },
        setActiveOrgImpl: async (_slug, name) => {
          calls.push(`org:${name}`);
        },
        setCurrentContextImpl: async (name) => {
          calls.push(`current:${name}`);
        },
      });

      expect(result).toEqual({ ready: true, localOrgSlug: "local-install" });
      // Registered as the plain `local` slot — no `managed` lifecycle, since
      // this runner was never handed a name it owns.
      expect(calls).toEqual([
        "context:local:http://127.0.0.1:8787:undefined",
        "credentials:local",
        "org:local",
      ]);
      // The rejected name is never written...
      expect(calls.some((call) => call.includes(contextName))).toBe(false);
      // ...and an explicit LOBU_CONTEXT still pins this process only: the
      // user's global default must not be retargeted behind their back.
      expect(calls.some((call) => call.startsWith("current:"))).toBe(false);
    } finally {
      if (previousContext === undefined) delete process.env.LOBU_CONTEXT;
      else process.env.LOBU_CONTEXT = previousContext;
      if (previousApiUrl === undefined) delete process.env.LOBU_API_URL;
      else process.env.LOBU_API_URL = previousApiUrl;
    }
  });

  test("warns only when an embedded project will skip auto-apply", () => {
    const failure = {
      ready: false as const,
      stage: "local_init_http" as const,
      detail: "HTTP 503",
    };

    expect(
      getLocalSignInWarning(failure, {
        embedded: true,
        hasLobuConfig: true,
      })
    ).toBe(
      "Local sign-in failed during the local-init request (HTTP 503); project auto-apply was skipped."
    );
    expect(
      getLocalSignInWarning(failure, {
        embedded: true,
        hasLobuConfig: false,
      })
    ).toBeNull();
  });

  test("does not claim the server is running after any sign-in failure", () => {
    const warning = getLocalSignInWarning(
      {
        ready: false,
        stage: "server_unreachable",
        detail: "the server did not answer /health within the startup window",
      },
      { embedded: true, hasLobuConfig: true }
    );

    expect(warning).toBe(
      "Local sign-in failed during server startup (the server did not answer /health within the startup window); project auto-apply was skipped."
    );
    expect(warning).not.toContain("still running");
  });
});

describe("autoApplyLocalProject — org is pinned to the local-init slug (#1366)", () => {
  test("passes the local org slug through to applyCommand as opts.org", async () => {
    const calls: Array<{
      cwd: string;
      yes: boolean;
      url: string;
      org?: string;
    }> = [];
    await autoApplyLocalProject(
      "/proj",
      "http://localhost:8788",
      "local-install",
      async (opts) => {
        calls.push(opts);
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cwd: "/proj",
      yes: true,
      url: "http://localhost:8788",
      org: "local-install",
    });
  });

  test("omits org when /api/local-init returned no slug (falls back to config)", async () => {
    const calls: Array<{ org?: string }> = [];
    await autoApplyLocalProject(
      "/proj",
      "http://localhost:8788",
      undefined,
      async (opts) => {
        calls.push(opts);
      }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.org).toBeUndefined();
  });

  test("swallows apply failures so a bad apply never crashes the running server", async () => {
    await expect(
      autoApplyLocalProject("/proj", "http://localhost:8788", "x", async () => {
        throw new Error("boom");
      })
    ).resolves.toBeUndefined();
  });
});

describe("lobu run hosted-chat link-code ordering", () => {
  const devSource = readFileSync(
    join(here, "..", "commands", "dev.ts"),
    "utf8"
  );

  test("mints preview codes only after the gateway is spawned", () => {
    // Regression guard for the startup race: printPreviewInstructions POSTs
    // /preview/claims, which fails with "fetch failed" if the embedded gateway
    // isn't listening yet. It must be called from the announceLocalSignIn
    // then-chain (after reachability + auto-apply), never the pre-spawn banner.
    const spawnIndex = devSource.indexOf('const child = spawn("node"');
    const chainCallIndex = devSource.indexOf(
      "printPreviewInstructions(cwd)",
      devSource.indexOf("announceLocalSignIn")
    );

    expect(spawnIndex).toBeGreaterThan(-1);
    expect(chainCallIndex).toBeGreaterThan(spawnIndex);
    // No call may appear anywhere before the spawn (the pre-spawn banner was
    // the race: the gateway isn't listening yet, so the claim POST 404s).
    const beforeSpawn = devSource.slice(0, spawnIndex);
    expect(beforeSpawn.includes("printPreviewInstructions(cwd)")).toBe(false);
  });

  test("surfaces the failure reason plus concrete recovery steps", () => {
    expect(devSource).toContain("Reason:");
    expect(devSource).toContain(
      "To get a link code, complete these steps against Lobu Cloud, then restart"
    );
    expect(devSource).toContain("lobu login");
    expect(devSource).toContain("lobu org set <slug>");
    expect(devSource).toContain("lobu apply");
  });
});
