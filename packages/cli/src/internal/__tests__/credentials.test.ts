import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as fs from "node:fs/promises";
import * as context from "../context";
import {
  type Credentials,
  clearCredentials,
  getAgentApiToken,
  getContextToken,
  getToken,
  loadCredentials,
  refreshCredentials,
  saveCredentials,
} from "../credentials";
import * as oauth from "../oauth";

function buildCreds(overrides: Partial<Credentials> = {}): Credentials {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 60 * 60_000,
    oauth: {
      clientId: "client-id",
      tokenEndpoint: "https://issuer.example.com/token",
    },
    ...overrides,
  };
}

let testCounter = 0;

describe("credentials", () => {
  let readFileSpy: ReturnType<typeof spyOn<typeof fs, "readFile">>;
  let writeFileSpy: ReturnType<typeof spyOn<typeof fs, "writeFile">>;
  let rmSpy: ReturnType<typeof spyOn<typeof fs, "rm">>;
  let currentContextName: string;

  beforeEach(() => {
    delete process.env.LOBU_API_TOKEN;
    delete process.env.LOBU_CONTEXT;
    delete process.env.LOBU_API_URL;

    // Use a unique context name per test so the per-process credentials cache
    // doesn't leak entries between cases.
    currentContextName = `ctx-${++testCounter}`;

    readFileSpy = spyOn(fs, "readFile");
    writeFileSpy = spyOn(fs, "writeFile").mockResolvedValue(undefined);
    rmSpy = spyOn(fs, "rm").mockResolvedValue(undefined);
    spyOn(fs, "mkdir").mockResolvedValue(undefined);
    // The credential store is written atomically (temp file + rename, with a
    // chmod on the temp before the rename). Mock both so the atomic write
    // resolves without touching the real filesystem; the assertions still read
    // the serialized data from the writeFile spy's payload arg.
    spyOn(fs, "rename").mockResolvedValue(undefined);
    spyOn(fs, "chmod").mockResolvedValue(undefined);
    spyOn(context, "resolveContext").mockImplementation(async () => ({
      name: currentContextName,
      url: "https://app.lobu.ai/api/v1",
      source: "default",
    }));
  });

  afterEach(() => {
    mock.restore();
  });

  test("loadCredentials returns null when file missing", async () => {
    readFileSpy.mockRejectedValue(new Error("ENOENT"));

    const result = await loadCredentials();

    expect(result).toBeNull();
  });

  test("loadCredentials reads creds for the resolved context (v2 store)", async () => {
    const store = {
      version: 2,
      contexts: {
        [currentContextName]: {
          accessToken: "stored-access",
          refreshToken: "stored-refresh",
          oauth: {
            clientId: "abc",
            tokenEndpoint: "https://issuer.example.com/token",
          },
        },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    const creds = await loadCredentials();

    expect(creds?.accessToken).toBe("stored-access");
    expect(creds?.refreshToken).toBe("stored-refresh");
    expect(creds?.oauth?.tokenEndpoint).toBe(
      "https://issuer.example.com/token"
    );
  });

  test("loadCredentials accepts legacy flat shape only for default context", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "lobu",
      url: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    const legacy = {
      accessToken: "legacy-token",
      refreshToken: "legacy-refresh",
    };
    readFileSpy.mockResolvedValue(JSON.stringify(legacy));

    const creds = await loadCredentials();

    expect(creds?.accessToken).toBe("legacy-token");
  });

  test("loadCredentials ignores legacy flat shape for non-default contexts", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod-non-default",
      url: "https://prod.lobu.ai/api/v1",
      source: "config",
    });
    const legacy = { accessToken: "legacy-token" };
    readFileSpy.mockResolvedValue(JSON.stringify(legacy));

    const creds = await loadCredentials();

    expect(creds).toBeNull();
  });

  test("loadCredentials returns null for entries without accessToken", async () => {
    const store = {
      version: 2,
      contexts: { [currentContextName]: { refreshToken: "no-access" } },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    const creds = await loadCredentials();

    expect(creds).toBeNull();
  });

  test("loadCredentials caches per-context results", async () => {
    const store = {
      version: 2,
      contexts: {
        [currentContextName]: { accessToken: "cached-token" },
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    await loadCredentials();
    await loadCredentials();

    // Cache hit: only one disk read for the same context name.
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  test("saveCredentials writes a v2 store entry and refreshes the cache", async () => {
    readFileSpy.mockRejectedValue(new Error("ENOENT"));

    await saveCredentials(buildCreds({ accessToken: "fresh" }));

    const [, written] = writeFileSpy.mock.calls[0]!;
    const parsed = JSON.parse(written as string) as {
      version: number;
      contexts: Record<string, Credentials>;
    };
    expect(parsed.version).toBe(2);
    expect(parsed.contexts[currentContextName]?.accessToken).toBe("fresh");

    // Subsequent loads use the cached value rather than re-reading disk.
    readFileSpy.mockClear();
    const cached = await loadCredentials();
    expect(cached?.accessToken).toBe("fresh");
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  test("getToken prefers LOBU_API_TOKEN over stored creds", async () => {
    process.env.LOBU_API_TOKEN = "env-token";

    const token = await getToken();

    expect(token).toBe("env-token");
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  test("getContextToken uses the named stored credential, never LOBU_API_TOKEN", async () => {
    process.env.LOBU_API_TOKEN = "local-target-token";
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        version: 2,
        contexts: {
          [currentContextName]: buildCreds({ accessToken: "cloud-token" }),
        },
      })
    );

    expect(await getContextToken(currentContextName)).toBe("cloud-token");
  });

  test("getContextToken never mints a loopback credential when the named credential is absent", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: currentContextName,
      url: "http://localhost:8787/api/v1",
      source: "config",
    });
    readFileSpy.mockRejectedValue(new Error("ENOENT"));
    const fetchSpy = spyOn(globalThis, "fetch");

    expect(await getContextToken(currentContextName)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("getContextToken refreshes an expired named credential", async () => {
    const creds = buildCreds({
      accessToken: "expired",
      expiresAt: Date.now() - 60_000,
    });
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        version: 2,
        contexts: { [currentContextName]: creds },
      })
    );
    spyOn(oauth, "refreshTokens").mockResolvedValue({
      accessToken: "refreshed-cloud-token",
      refreshToken: "rotated-refresh-token",
      expiresIn: 3600,
    });

    expect(await getContextToken(currentContextName)).toBe(
      "refreshed-cloud-token"
    );
    expect(writeFileSpy).toHaveBeenCalled();
  });

  test("getContextToken leaves an expired non-refreshable credential stored", async () => {
    const creds = buildCreds({
      accessToken: "expired",
      refreshToken: undefined,
      expiresAt: Date.now() - 60_000,
    });
    readFileSpy.mockResolvedValue(
      JSON.stringify({
        version: 2,
        contexts: { [currentContextName]: creds },
      })
    );

    expect(await getContextToken(currentContextName)).toBeNull();
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
  });

  test("getToken returns null when no creds exist", async () => {
    readFileSpy.mockRejectedValue(new Error("ENOENT"));

    const token = await getToken();

    expect(token).toBeNull();
  });

  test("getToken local-init prefers the session token over the worker PAT", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: currentContextName,
      url: "http://localhost:8787/api/v1",
      source: "config",
    });
    readFileSpy.mockRejectedValue(new Error("ENOENT"));
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          device_token: "worker-pat",
          session_token: "session-token",
          user: { id: "user-1", email: "u@example.com", name: "User" },
          organization: { id: "org-1", slug: "local-org", name: "Local" },
        }),
        { status: 200 }
      )
    );

    const token = await getToken(currentContextName);

    expect(token).toBe("session-token");
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8787/api/local-init",
      {
        method: "POST",
        headers: { "X-Lobu-Client": "cli" },
      }
    );
    const [, written] = writeFileSpy.mock.calls[0]!;
    const persisted = JSON.parse(written as string) as {
      contexts: Record<string, Credentials>;
    };
    expect(persisted.contexts[currentContextName]?.accessToken).toBe(
      "session-token"
    );
    expect(persisted.contexts[currentContextName]?.localWorkerToken).toBe(
      "worker-pat"
    );
  });

  test("getAgentApiToken uses the local-init worker PAT when present", async () => {
    const store = {
      version: 2,
      contexts: {
        [currentContextName]: buildCreds({
          accessToken: "session-token",
          localWorkerToken: "worker-pat",
        }),
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    const token = await getAgentApiToken(currentContextName);

    expect(token).toBe("worker-pat");
  });

  test("getToken heals stale local credentials that only stored the worker PAT", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: currentContextName,
      url: "http://localhost:8787/api/v1",
      source: "config",
    });
    const store = {
      version: 2,
      contexts: {
        [currentContextName]: buildCreds({ accessToken: "old-worker-pat" }),
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(store));
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          device_token: "new-worker-pat",
          session_token: "new-session-token",
        }),
        { status: 200 }
      )
    );

    const token = await getToken(currentContextName);

    expect(token).toBe("new-session-token");
    const [, written] = writeFileSpy.mock.calls[0]!;
    const persisted = JSON.parse(written as string) as {
      contexts: Record<string, Credentials>;
    };
    expect(persisted.contexts[currentContextName]?.accessToken).toBe(
      "new-session-token"
    );
    expect(persisted.contexts[currentContextName]?.localWorkerToken).toBe(
      "new-worker-pat"
    );
  });

  test("getToken returns the stored access token when not expired", async () => {
    const creds = buildCreds({
      accessToken: "still-good",
      expiresAt: Date.now() + 5 * 60_000,
    });
    const store = { version: 2, contexts: { [currentContextName]: creds } };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    const token = await getToken();

    expect(token).toBe("still-good");
  });

  test("getToken clears creds when expired and no refresh token", async () => {
    const creds = buildCreds({
      accessToken: "expired",
      refreshToken: undefined,
      expiresAt: Date.now() - 60_000,
    });
    const store = { version: 2, contexts: { [currentContextName]: creds } };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    const token = await getToken();

    expect(token).toBeNull();
    // clearCredentials writes the remaining store back when other contexts
    // exist; here it removes the only entry, so it should rm the file.
    expect(rmSpy).toHaveBeenCalled();
  });

  test("getToken says why when it drops a stale session", async () => {
    // A bogus/expired token must not vanish silently into "Not logged in" —
    // say it expired so the user runs `lobu login` instead of debugging auth.
    const creds = buildCreds({
      accessToken: "expired",
      refreshToken: undefined,
      expiresAt: Date.now() - 60_000,
    });
    const store = { version: 2, contexts: { [currentContextName]: creds } };
    readFileSpy.mockResolvedValue(JSON.stringify(store));
    const errSpy = spyOn(process.stderr, "write").mockImplementation(
      () => true
    );

    const token = await getToken();

    expect(token).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("lobu login"));
  });

  test("getToken refreshes expired tokens through refreshTokens()", async () => {
    const expiredAt = Date.now() - 60_000;
    const creds = buildCreds({
      accessToken: "expired",
      refreshToken: "refresh-1",
      expiresAt: expiredAt,
    });
    const store = { version: 2, contexts: { [currentContextName]: creds } };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    const refreshSpy = spyOn(oauth, "refreshTokens").mockResolvedValue({
      accessToken: "new-token",
      refreshToken: "refresh-2",
      expiresIn: 3600,
    });

    const token = await getToken();

    expect(token).toBe("new-token");
    expect(refreshSpy).toHaveBeenCalledWith(
      "https://issuer.example.com/token",
      { clientId: "client-id", clientSecret: undefined },
      "refresh-1"
    );

    // The refreshed creds should have been persisted via saveCredentials.
    const lastWrite = writeFileSpy.mock.calls.at(-1);
    expect(lastWrite).toBeDefined();
    const persisted = JSON.parse(lastWrite![1] as string) as {
      contexts: Record<string, Credentials>;
    };
    expect(persisted.contexts[currentContextName]?.accessToken).toBe(
      "new-token"
    );
    expect(persisted.contexts[currentContextName]?.refreshToken).toBe(
      "refresh-2"
    );
  });

  test("refreshCredentials returns existing creds when no refresh metadata", async () => {
    const creds = buildCreds({ refreshToken: undefined });

    const result = await refreshCredentials(creds);

    expect(result).toBe(creds);
  });

  test("refreshCredentials keeps a still-valid token when refresh is not yet needed", async () => {
    // A non-expired access token must not be discarded just because it *could*
    // be refreshed. Previously whoami eagerly refreshed and, on a stale refresh
    // token (400 invalid_grant), reported "Not logged in" despite a valid
    // session — the Owletto Mac app reads whoami --json for its menu bar.
    const creds = buildCreds({ expiresAt: Date.now() + 60 * 60_000 });
    const store = { version: 2, contexts: { [currentContextName]: creds } };
    readFileSpy.mockResolvedValue(JSON.stringify(store));
    const refreshSpy = spyOn(oauth, "refreshTokens").mockResolvedValue(null);

    const result = await refreshCredentials(creds);

    expect(result).toBe(creds);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  test("refreshCredentials returns null when an expired token's refresh fails", async () => {
    const creds = buildCreds({ expiresAt: Date.now() - 60_000 });
    const store = { version: 2, contexts: { [currentContextName]: creds } };
    readFileSpy.mockResolvedValue(JSON.stringify(store));
    spyOn(oauth, "refreshTokens").mockResolvedValue(null);

    const result = await refreshCredentials(creds);

    expect(result).toBeNull();
  });

  test("clearCredentials removes the file when no contexts remain", async () => {
    const store = {
      version: 2,
      contexts: { [currentContextName]: buildCreds() },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    await clearCredentials();

    expect(rmSpy).toHaveBeenCalled();
  });

  test("clearCredentials persists the remaining contexts when others survive", async () => {
    const store = {
      version: 2,
      contexts: {
        [currentContextName]: buildCreds({ accessToken: "default" }),
        "prod-keep": buildCreds({ accessToken: "prod-token" }),
      },
    };
    readFileSpy.mockResolvedValue(JSON.stringify(store));

    await clearCredentials();

    const lastWrite = writeFileSpy.mock.calls.at(-1);
    expect(lastWrite).toBeDefined();
    const parsed = JSON.parse(lastWrite![1] as string) as {
      contexts: Record<string, Credentials>;
    };
    expect(parsed.contexts[currentContextName]).toBeUndefined();
    expect(parsed.contexts["prod-keep"]?.accessToken).toBe("prod-token");
    expect(rmSpy).not.toHaveBeenCalled();
  });
});
