import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HOST_ONLY_ENV_KEYS,
  SANDBOX_CONTROLLED_ENV_KEYS,
  authenticatedUrl,
  bootEnv,
  buildTarball,
  changedSince,
  credentialsFromConfig,
  currentHeads,
  dirtyNotice,
  ExpiredCliTokenError,
  fullSyncReason,
  generateBearerToken,
  generatePassword,
  hashEntries,
  interpretSignUp,
  isAppleDouble,
  listTreeFiles,
  lockfileEntries,
  loginLink,
  orphanSandboxNames,
  parseLsFilesS,
  parsePorcelainZ,
  parseWorktreeRoots,
  planSync,
  previewUrlFor,
  readSyncState,
  resolveOwnerEmail,
  sandboxName,
  sanitizedEnv,
  sessionTokenFrom,
  signInScript,
  signUpScript,
  syncScope,
  syncStatePath,
  writeSyncState,
} from "../sandbox";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureRepo(): string {
  const root = temporaryDirectory("sandbox-fixture-");
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "db/migrations"), { recursive: true });
  writeFileSync(
    join(root, "db/migrations/00000000000000_baseline.sql"),
    "SELECT 1;\n"
  );
  writeFileSync(join(root, "README.md"), "hi\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
    {
      cwd: root,
    }
  );
  return root;
}

function tarball(root: string): string {
  const stage = buildTarball(root);
  temporaryDirectories.push(stage);
  return stage;
}

function addOwlettoSubmodule(root: string) {
  const source = temporaryDirectory("sandbox-owletto-source-");
  execFileSync("git", ["init", "-q"], { cwd: source });
  writeFileSync(join(source, ".gitignore"), "node_modules/\ndist/\n");
  writeFileSync(join(source, "app.ts"), "export const app = true;\n");
  execFileSync("git", ["add", ".gitignore", "app.ts"], { cwd: source });
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
    {
      cwd: source,
    }
  );
  mkdirSync(join(root, "packages"), { recursive: true });
  execFileSync(
    "git",
    [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      source,
      "packages/owletto",
    ],
    { cwd: root }
  );
  mkdirSync(join(root, "packages/owletto/node_modules"));
  writeFileSync(
    join(root, "packages/owletto/node_modules/ignored.js"),
    "ignored\n"
  );
}

/**
 * Read tar member names straight from the gunzipped stream instead of shelling
 * out to `tar -t`. macOS tar re-absorbs AppleDouble members on read, so it
 * reports an archive that carries `._x.sql` as if it did not — the exact
 * entries these tests exist to catch. GNU tar in CI would show them, so a
 * `tar -t` based test passes on the Mac and only fails on Linux.
 */
function entries(tarPath: string): string[] {
  const raw = gunzipSync(readFileSync(tarPath));
  const names: string[] = [];
  for (let off = 0; off + 512 <= raw.length; off += 512) {
    const name = raw.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) continue;
    const sizeField = raw
      .toString("ascii", off + 124, off + 136)
      .replace(/\0| /g, "");
    const size = Number.parseInt(sizeField, 8) || 0;
    names.push(name);
    off += Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("sandboxName", () => {
  test("derives a stable, DNS-safe name from the worktree directory", () => {
    expect(sandboxName("/a/b/.claude/worktrees/my-task")).toMatch(
      /^lobu-dev-my-task-[a-f0-9]{8}$/
    );
    // Two calls on the same path must agree, or `up` would orphan sandboxes.
    expect(sandboxName("/a/b/Feat_X")).toBe(sandboxName("/a/b/Feat_X"));
  });

  test("strips characters a sandbox name cannot carry", () => {
    expect(sandboxName("/a/b/Feat_X.2")).toMatch(
      /^lobu-dev-feat-x-2-[a-f0-9]{8}$/
    );
  });

  test("does not collide for the same worktree slug in two checkouts", () => {
    expect(sandboxName("/Users/alice/lobu/my-task")).not.toBe(
      sandboxName("/Users/bob/lobu/my-task")
    );
  });
});

describe("sanitizedEnv", () => {
  test("drops every host-only key and keeps the rest", () => {
    const root = temporaryDirectory("sandbox-env-");
    writeFileSync(
      join(root, ".env"),
      "ANTHROPIC_API_KEY=keep-me\nexport DATABASE_URL=postgres://127.0.0.1:5432/lobu\nPORT=9664\nDAYTONA_API_KEY=host-only\nOTHER=yes\n"
    );
    const out = sanitizedEnv(root) ?? "";
    expect(out).toContain("ANTHROPIC_API_KEY=keep-me");
    expect(out).toContain("OTHER=yes");
    for (const key of HOST_ONLY_ENV_KEYS) expect(out).not.toContain(`${key}=`);
    expect(out).not.toContain("DAYTONA_API_KEY");
  });

  test("DATABASE_URL is one of the stripped keys", () => {
    // The whole point: leaving it in points the sandbox at the Mac's Postgres.
    expect(HOST_ONLY_ENV_KEYS).toContain("DATABASE_URL");
  });

  test("names every key the boot env owns", () => {
    // The generated fixture below proves each listed key is stripped, but it
    // shrinks with the list, so it cannot notice a key going missing. These
    // four are what keep a public preview shut, so name them outright.
    expect([...SANDBOX_CONTROLLED_ENV_KEYS].sort()).toEqual([
      "EMBEDDINGS_SERVICE_TOKEN",
      "LOBU_DEV_DATA_ROOT",
      "LOBU_SINGLE_USER",
      "WORKER_API_TOKEN",
    ]);
  });

  test("drops every sandbox-controlled key", () => {
    // dev-native.sh preserves only a fixed preset list across `source .env`,
    // so any of these left in the file would override the boot env and quietly
    // reopen sign-up or the anonymous worker lane on a public preview.
    const root = temporaryDirectory("sandbox-env-owned-");
    // Planted from the constant itself so a key added to the strip list can
    // never sit unexercised here and pass the loop below vacuously.
    writeFileSync(
      join(root, ".env"),
      `${SANDBOX_CONTROLLED_ENV_KEYS.map((k) => `${k}=host-value`).join("\n")}\nKEEP=yes\n`
    );
    const out = sanitizedEnv(root) ?? "";
    expect(out).toContain("KEEP=yes");
    for (const key of SANDBOX_CONTROLLED_ENV_KEYS) {
      expect(out).not.toContain(`${key}=`);
    }
  });

  test("returns null when the worktree has no .env", () => {
    expect(sanitizedEnv(temporaryDirectory("sandbox-noenv-"))).toBeNull();
  });
});

describe("bootEnv", () => {
  const env = () =>
    bootEnv({
      previewUrl: "https://p.example",
      workerApiToken: "tok-123",
      embeddingsServiceToken: "emb-456",
    });

  test("closes sign-up and the anonymous worker lane", () => {
    expect(env()).toContain("LOBU_SINGLE_USER='1'");
    expect(env()).toContain("WORKER_API_TOKEN='tok-123'");
  });

  test("authenticates the embeddings sidecar", () => {
    // Its bearer check is skipped entirely while the token is unset, and the
    // preview proxy exposes the sidecar's port too.
    expect(env()).toContain("EMBEDDINGS_SERVICE_TOKEN='emb-456'");
  });

  test("points the database at a root outside the Vite serving root", () => {
    // The dev server serves /@fs/<workspace>/…, and the cluster holds raw
    // session tokens, so the data root must not sit under the checkout.
    const value = env().match(/DATABASE_URL='([^']+)'/)?.[1] ?? "";
    expect(value.startsWith("file:///")).toBe(true);
    expect(value).not.toContain("/workspace/lobu/");
  });

  test("binds the gateway to the preview origin", () => {
    expect(env()).toContain("PUBLIC_GATEWAY_URL='https://p.example/lobu'");
    expect(env()).toContain("HOST='0.0.0.0'");
    expect(env()).toContain("PORT='8787'");
  });

  test("refuses a value that would break out of its shell quotes", () => {
    expect(() =>
      bootEnv({
        previewUrl: "https://p.example",
        workerApiToken: "a'b",
        embeddingsServiceToken: "emb",
      })
    ).toThrow(/contains a quote/);
  });
});

describe("generateBearerToken", () => {
  test("is url-safe and long enough to be unguessable", () => {
    const token = generateBearerToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(generateBearerToken());
  });
});

describe("resolveOwnerEmail", () => {
  test("prefers the explicit override", () => {
    expect(resolveOwnerEmail("me@example.com", "git@example.com")).toBe(
      "me@example.com"
    );
  });

  test("falls back to the worktree git identity", () => {
    expect(resolveOwnerEmail(undefined, " git@example.com ")).toBe(
      "git@example.com"
    );
  });

  test("throws rather than inventing an owner", () => {
    // A hardcoded address would be personal state in shipping code.
    expect(() => resolveOwnerEmail(undefined, undefined)).toThrow(
      /SANDBOX_OWNER_EMAIL/
    );
    expect(() => resolveOwnerEmail(undefined, "not-an-email")).toThrow(
      /SANDBOX_OWNER_EMAIL/
    );
  });
});

describe("generatePassword", () => {
  test("is url-safe and unique per call", () => {
    expect(generatePassword()).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("signUpScript", () => {
  test("never puts the credentials on the shell command line", () => {
    const script = signUpScript("me@example.com", "p'a\"ss", "Owner");
    expect(script).not.toContain("me@example.com");
    expect(script).not.toContain("p'a");
    expect(script).toContain("base64 -d");
    expect(script).toContain("/api/auth/sign-up/email");
  });
});

describe("signInScript", () => {
  test("never puts the credentials on the shell command line", () => {
    const script = signInScript("me@example.com", "p'a\"ss");
    expect(script).not.toContain("me@example.com");
    expect(script).not.toContain("p'a");
    expect(script).toContain("base64 -d");
    expect(script).toContain("/api/auth/sign-in/email");
  });
});

describe("interpretSignUp", () => {
  test("2xx means the seat was claimed", () => {
    expect(interpretSignUp('200\n{"token":"t"}')).toEqual({
      status: "claimed",
    });
  });

  test("the hook error code is what proves the seat is taken", () => {
    expect(
      interpretSignUp(
        '403\n{"code":"SIGN_UP_DISABLED_IN_SINGLE_USER_MODE","message":"nope"}'
      )
    ).toEqual({ status: "seat_taken" });
  });

  test("a bare 403 is not proof that sign-up is closed", () => {
    // Treating any 403 as "closed" would let an unrelated denial authorise
    // making the preview public.
    expect(interpretSignUp('403\n{"code":"RATE_LIMITED"}').status).toBe(
      "error"
    );
  });

  test("reports a transport failure rather than guessing", () => {
    expect(interpretSignUp("").status).toBe("error");
    expect(interpretSignUp("000\n").status).toBe("error");
  });
});

describe("sessionTokenFrom", () => {
  test("prefers the token in the response body", () => {
    expect(sessionTokenFrom('{"token":"abc123","user":{}}')).toBe("abc123");
  });

  test("falls back to the token half of the signed cookie", () => {
    expect(
      sessionTokenFrom(
        "HTTP/1.1 200 OK\nset-cookie: better-auth.session_token=abc123.SIGNATURE; Path=/; HttpOnly\n"
      )
    ).toBe("abc123");
  });

  test("returns undefined when there is no token at all", () => {
    expect(sessionTokenFrom('{"error":"nope"}')).toBeUndefined();
  });
});

describe("loginLink", () => {
  test("hands the token to the exchange endpoint", () => {
    expect(loginLink("https://p.example", "tok/en+value")).toBe(
      "https://p.example/api/exchange-token?token=tok%2Fen%2Bvalue&next=%2F"
    );
  });

  test("does not double the slash on a trailing-slash url", () => {
    expect(loginLink("https://p.example/", "t")).toContain(
      "https://p.example/api/exchange-token"
    );
  });
});

describe("previewUrlFor", () => {
  test("a public preview needs no key in the url", () => {
    expect(previewUrlFor(true, "https://p.example", "tok")).toBe(
      "https://p.example"
    );
  });

  test("a private preview still gets the key", () => {
    expect(previewUrlFor(false, "https://p.example", "tok")).toBe(
      "https://p.example?DAYTONA_SANDBOX_AUTH_KEY=tok"
    );
  });
});

describe("buildTarball", () => {
  test("drops an AppleDouble sidecar already present on disk", () => {
    const root = fixtureRepo();
    // `._<name>.sql` still matches the migration runner's *.sql scan, and its
    // binary header reaches Postgres as a query (08P01, "invalid message
    // format") — a failure that names nothing leading back to a stray file.
    writeFileSync(
      join(root, "db/migrations/._00000000000000_baseline.sql"),
      Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00])
    );
    const names = entries(join(tarball(root), "tree.tar.gz"));
    expect(
      names.filter((n) => n.includes("/._") || n.startsWith("._"))
    ).toEqual([]);
    expect(names).toContain("db/migrations/00000000000000_baseline.sql");
  });

  test("does not let macOS tar mint a sidecar from a file's xattrs", () => {
    const root = fixtureRepo();
    const target = join(root, "db/migrations/00000000000000_baseline.sql");
    try {
      execFileSync("xattr", ["-w", "com.apple.metadata:test", "x", target]);
    } catch {
      return; // no xattr tool: this failure mode cannot arise here
    }
    const names = entries(join(tarball(root), "tree.tar.gz"));
    expect(names).toContain("db/migrations/00000000000000_baseline.sql");
    expect(names.filter((n) => n.includes("/._"))).toEqual([]);
  });

  test("isAppleDouble matches only the sidecar, never the real file", () => {
    expect(isAppleDouble("db/migrations/._0_baseline.sql")).toBe(true);
    expect(isAppleDouble("db/migrations/0_baseline.sql")).toBe(false);
    // A leading dot alone is not a sidecar — .env.example must still ship.
    expect(isAppleDouble(".env.example")).toBe(false);
  });

  test("never ships .env or .env.local inside the tree tarball", () => {
    const root = fixtureRepo();
    writeFileSync(
      join(root, ".env"),
      "DATABASE_URL=postgres://127.0.0.1:5432/lobu\n"
    );
    writeFileSync(join(root, ".env.local"), "PORT=9664\n");
    const names = entries(join(tarball(root), "tree.tar.gz"));
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".env.local");
  });

  test("includes untracked files so uncommitted work reaches the sandbox", () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "scratch.ts"), "export const a = 1;\n");
    expect(entries(join(tarball(root), "tree.tar.gz"))).toContain("scratch.ts");
  });

  test("writes the sanitized env beside the tarball, not into it", () => {
    const root = fixtureRepo();
    writeFileSync(join(root, ".env"), "KEEP=1\nDATABASE_URL=postgres://x\n");
    const stage = tarball(root);
    expect(existsSync(join(stage, "tree.tar.gz"))).toBe(true);
    const env = sanitizedEnv(root) ?? "";
    expect(env).toContain("KEEP=1");
    expect(env).not.toContain("DATABASE_URL");
  });

  test("archives the Owletto gitlink only through the filtered submodule tarball", () => {
    const root = fixtureRepo();
    addOwlettoSubmodule(root);
    const stage = tarball(root);
    expect(
      entries(join(stage, "tree.tar.gz")).some((name) =>
        name.startsWith("packages/owletto")
      )
    ).toBe(false);
    const owlettoEntries = entries(join(stage, "owletto.tar.gz"));
    expect(owlettoEntries).toContain("app.ts");
    expect(owlettoEntries.some((name) => name.includes("node_modules"))).toBe(
      false
    );
  });

  test("handles option-like and newline-containing file names literally", () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "--not-a-tar-option"), "safe\n");
    writeFileSync(join(root, "line\nbreak.ts"), "safe\n");
    const names = entries(join(tarball(root), "tree.tar.gz"));
    expect(names).toContain("--not-a-tar-option");
    expect(names).toContain("line\nbreak.ts");
  });
});

describe("authenticatedUrl", () => {
  test("appends the preview token so the link opens in a browser", () => {
    expect(authenticatedUrl("https://x.example", "tok")).toBe(
      "https://x.example?DAYTONA_SANDBOX_AUTH_KEY=tok"
    );
  });

  test("returns the bare url for a public sandbox", () => {
    expect(authenticatedUrl("https://x.example")).toBe("https://x.example");
  });

  test("preserves an existing query string", () => {
    expect(authenticatedUrl("https://x.example?view=dev", "tok")).toBe(
      "https://x.example?view=dev&DAYTONA_SANDBOX_AUTH_KEY=tok"
    );
  });
});

describe("CLI validation", () => {
  test("rejects an unknown command before contacting Daytona", () => {
    const result = Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, "..", "sandbox.ts"), "wat"],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "unknown command 'wat'"
    );
  });

  test("rejects an empty remote command before contacting Daytona", () => {
    const result = Bun.spawnSync(
      [process.execPath, resolve(import.meta.dir, "..", "sandbox.ts"), "run"],
      { env: { ...process.env, CMD: "" }, stdout: "pipe", stderr: "pipe" }
    );
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "usage: sandbox.ts run <command>"
    );
  });
});

describe("credentialsFromConfig", () => {
  // `daytona login` writes a browser JWT; `daytona login --api-key` writes a
  // long-lived key. Reading only the first reports "No Daytona credentials" on
  // an authenticated machine, which reads as a login failure.
  const jwtProfile = {
    activeProfile: "initial",
    profiles: [
      {
        id: "initial",
        activeOrganizationId: "org-1",
        api: {
          url: "https://api.example",
          token: { accessToken: "jwt-abc", expiresAt: "2999-01-01T00:00:00Z" },
        },
      },
    ],
  };

  const apiKeyProfile = {
    activeProfile: "initial",
    profiles: [
      {
        id: "initial",
        activeOrganizationId: "org-1",
        api: { url: "https://api.example", key: "dtn-key-abc" },
      },
    ],
  };

  test("reads the browser JWT shape", () => {
    expect(credentialsFromConfig(jwtProfile)).toEqual({
      jwtToken: "jwt-abc",
      organizationId: "org-1",
      apiUrl: "https://api.example",
    });
  });

  test("reads the API key shape", () => {
    expect(credentialsFromConfig(apiKeyProfile)).toEqual({
      apiKey: "dtn-key-abc",
      apiUrl: "https://api.example",
    });
  });

  test("accepts an API key with no activeOrganizationId", () => {
    // A key carries its own org scope; the CLI may omit the field for one.
    const cfg = {
      activeProfile: "initial",
      profiles: [{ id: "initial", api: { key: "dtn-key-only" } }],
    };
    expect(credentialsFromConfig(cfg)).toEqual({
      apiKey: "dtn-key-only",
      apiUrl: undefined,
    });
  });

  test("falls back to the API key when the JWT has expired", () => {
    const cfg = {
      activeProfile: "initial",
      profiles: [
        {
          id: "initial",
          activeOrganizationId: "org-1",
          api: {
            url: "https://api.example",
            key: "dtn-key-abc",
            token: {
              accessToken: "jwt-old",
              expiresAt: "2000-01-01T00:00:00Z",
            },
          },
        },
      ],
    };
    expect(credentialsFromConfig(cfg)).toEqual({
      apiKey: "dtn-key-abc",
      apiUrl: "https://api.example",
    });
  });

  test("reports an expired JWT when no API key stands behind it", () => {
    const cfg = {
      activeProfile: "initial",
      profiles: [
        {
          id: "initial",
          activeOrganizationId: "org-1",
          api: {
            token: {
              accessToken: "jwt-old",
              expiresAt: "2000-01-01T00:00:00Z",
            },
          },
        },
      ],
    };
    expect(() => credentialsFromConfig(cfg)).toThrow(ExpiredCliTokenError);
  });

  test("prefers a live JWT when a profile carries both", () => {
    const cfg = {
      activeProfile: "initial",
      profiles: [
        {
          id: "initial",
          activeOrganizationId: "org-1",
          api: {
            key: "dtn-key-abc",
            token: {
              accessToken: "jwt-abc",
              expiresAt: "2999-01-01T00:00:00Z",
            },
          },
        },
      ],
    };
    expect(credentialsFromConfig(cfg)).toMatchObject({ jwtToken: "jwt-abc" });
  });

  test("selects the active profile, not merely the first", () => {
    const cfg = {
      activeProfile: "second",
      profiles: [
        { id: "first", api: { key: "wrong" } },
        { id: "second", api: { key: "right" } },
      ],
    };
    expect(credentialsFromConfig(cfg)).toMatchObject({ apiKey: "right" });
  });

  test("returns null when a profile carries no usable credential", () => {
    expect(
      credentialsFromConfig({
        activeProfile: "initial",
        profiles: [{ id: "initial", api: { url: "https://api.example" } }],
      })
    ).toBeNull();
  });

  test("returns null for an empty or malformed config", () => {
    expect(credentialsFromConfig({})).toBeNull();
    expect(credentialsFromConfig({ profiles: [] })).toBeNull();
    expect(credentialsFromConfig(null)).toBeNull();
  });
});

describe("parseWorktreeRoots", () => {
  test("takes the path off every worktree line and ignores the rest", () => {
    const porcelain = [
      "worktree /Users/x/Code/lobu",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /Users/x/Code/lobu/.claude/worktrees/feature",
      "HEAD def",
      "branch refs/heads/feat/feature",
      "",
    ].join("\n");
    expect(parseWorktreeRoots(porcelain)).toEqual([
      "/Users/x/Code/lobu",
      "/Users/x/Code/lobu/.claude/worktrees/feature",
    ]);
  });

  test("a detached worktree still yields its path", () => {
    expect(
      parseWorktreeRoots("worktree /tmp/wt\nHEAD abc\ndetached\n")
    ).toEqual(["/tmp/wt"]);
  });

  test("empty input is not an empty-string path", () => {
    expect(parseWorktreeRoots("")).toEqual([]);
  });
});

describe("orphanSandboxNames", () => {
  const live = "/Users/x/Code/lobu/.claude/worktrees/live";
  const gone = "/Users/x/Code/lobu/.claude/worktrees/gone";

  test("a sandbox whose worktree still exists is not an orphan", () => {
    expect(orphanSandboxNames([sandboxName(live)], [live])).toEqual([]);
  });

  test("a sandbox whose worktree is gone is an orphan", () => {
    expect(
      orphanSandboxNames([sandboxName(live), sandboxName(gone)], [live])
    ).toEqual([sandboxName(gone)]);
  });

  test("only lobu-dev- names are judged; other lobu- sandboxes have no worktree to miss", () => {
    expect(orphanSandboxNames(["lobu-opencode-test"], [])).toEqual([]);
  });

  test("same slug at a different path is a different sandbox, so it is an orphan", () => {
    // sandboxName hashes the absolute path, not the basename: two worktrees
    // named `gone` under different parents must not alias each other.
    const elsewhere = "/Users/x/other/gone";
    expect(orphanSandboxNames([sandboxName(gone)], [elsewhere])).toEqual([
      sandboxName(gone),
    ]);
  });
});

describe("listTreeFiles", () => {
  test("splits parent and submodule listings for the remote tree", () => {
    const root = fixtureRepo();
    addOwlettoSubmodule(root);
    const { files, subFiles } = listTreeFiles(root);
    expect(files).toContain("README.md");
    expect(files.some((f) => f.startsWith("packages/owletto"))).toBe(false);
    expect(subFiles).toContain("app.ts");
  });
});

describe("fullSyncReason", () => {
  test("names each fallback before the delta path", () => {
    const changes = { files: [], envChanged: false };
    expect(fullSyncReason(null, [], false, changes)).toBe(
      "no prior sync state"
    );
    expect(
      fullSyncReason(
        { lobuHead: "a", owlettoHead: null, lockHash: null },
        null,
        false,
        changes
      )
    ).toBe("no remote manifest");
    expect(
      fullSyncReason(
        { lobuHead: "a", owlettoHead: null, lockHash: null },
        [],
        false,
        null
      )
    ).toBe("change range uncomputable");
    expect(
      fullSyncReason(
        { lobuHead: "a", owlettoHead: null, lockHash: null },
        [],
        false,
        changes
      )
    ).toBe("no file map yet");
    expect(
      fullSyncReason(
        { lobuHead: "a", owlettoHead: null, lockHash: null, files: {} },
        [],
        false,
        changes
      )
    ).toBe("no file map yet");
    expect(
      fullSyncReason(
        {
          lobuHead: "a",
          owlettoHead: null,
          lockHash: null,
          files: { "a.ts": "h" },
        },
        ["a.ts"],
        false,
        changes
      )
    ).toBeNull();
    expect(
      fullSyncReason(
        {
          lobuHead: "a",
          owlettoHead: null,
          lockHash: null,
          files: { "a.ts": "h" },
        },
        ["a.ts"],
        true,
        changes
      )
    ).toBe("no prior sync state");
  });
});

describe("fullSyncReason", () => {
  test("names each fallback before the delta path", () => {
    const changes = { files: [], envChanged: false };
    expect(fullSyncReason(null, [], false, changes)).toBe(
      "no prior sync state"
    );
    expect(
      fullSyncReason(
        { lobuHead: "a", owlettoHead: null, lockHash: null },
        null,
        false,
        changes
      )
    ).toBe("no remote manifest");
    expect(
      fullSyncReason(
        { lobuHead: "a", owlettoHead: null, lockHash: null },
        [],
        false,
        null
      )
    ).toBe("change range uncomputable");
    expect(
      fullSyncReason(
        { lobuHead: "a", owlettoHead: null, lockHash: null },
        [],
        false,
        changes
      )
    ).toBe("no file map yet");
    expect(
      fullSyncReason(
        { lobuHead: "a", owlettoHead: null, lockHash: null, files: {} },
        [],
        false,
        changes
      )
    ).toBe("no file map yet");
    expect(
      fullSyncReason(
        {
          lobuHead: "a",
          owlettoHead: null,
          lockHash: null,
          files: { "a.ts": "h" },
        },
        ["a.ts"],
        false,
        changes
      )
    ).toBeNull();
    expect(
      fullSyncReason(
        {
          lobuHead: "a",
          owlettoHead: null,
          lockHash: null,
          files: { "a.ts": "h" },
        },
        ["a.ts"],
        true,
        changes
      )
    ).toBe("no prior sync state");
  });
});

describe("syncScope", () => {
  test("empty change sets mean nothing to do", () => {
    expect(syncScope([], [], false)).toBe("none");
  });

  test("owletto-only changes stay frontend", () => {
    expect(syncScope([], ["packages/owletto/src/a.ts"], false)).toBe(
      "frontend"
    );
  });

  test("any parent change means a full reboot", () => {
    expect(syncScope(["scripts/sandbox.ts"], [], false)).toBe("full");
    expect(
      syncScope(["scripts/sandbox.ts"], ["packages/owletto/src/a.ts"], false)
    ).toBe("full");
  });

  test(".env forces a reboot without entering any upload", () => {
    expect(syncScope([], [], true)).toBe("full");
  });
});

describe("hashEntries", () => {
  test("is deterministic and order-independent", () => {
    const a: Array<[string, string]> = [
      ["bun.lock", "lock"],
      ["package.json", "{}"],
    ];
    const b: Array<[string, string]> = [
      ["package.json", "{}"],
      ["bun.lock", "lock"],
    ];
    expect(hashEntries(a)).toBe(hashEntries(b));
    expect(hashEntries(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes when any content changes", () => {
    expect(hashEntries([["bun.lock", "a"]])).not.toBe(
      hashEntries([["bun.lock", "b"]])
    );
  });
});

describe("planSync", () => {
  test("null changes upload the full list", () => {
    const plan = planSync(["old.ts"], ["a.ts", "b.ts"], null);
    expect(plan.upload).toEqual(["a.ts", "b.ts"]);
    expect(plan.remove).toEqual(["old.ts"]);
    expect(plan.fullList).toEqual(["a.ts", "b.ts"]);
  });

  test("uploads only changed files and removes vanished ones", () => {
    const plan = planSync(
      ["a.ts", "gone.ts"],
      ["a.ts", "b.ts"],
      ["b.ts", "gone.ts"]
    );
    expect(plan.upload).toEqual(["b.ts"]);
    expect(plan.remove).toEqual(["gone.ts"]);
  });

  test("a changed-but-deleted path only lands in remove, never in tar", () => {
    const plan = planSync(["gone.ts"], ["a.ts"], ["gone.ts"]);
    expect(plan.upload).toEqual([]);
    expect(plan.remove).toEqual(["gone.ts"]);
  });
});

describe("parsePorcelainZ", () => {
  test("reads modified, added, and untracked paths", () => {
    expect(parsePorcelainZ(" M a.ts\0A  b.ts\0?? c.ts\0")).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  test("maps a rename to its new path only", () => {
    expect(parsePorcelainZ("R  old.ts\0new.ts\0")).toEqual(["new.ts"]);
  });

  test("empty output means a clean tree", () => {
    expect(parsePorcelainZ("")).toEqual([]);
  });
});

describe("parseLsFilesS", () => {
  test("reads the staged gitlink SHA", () => {
    expect(
      parseLsFilesS(
        "160000 0123456789abcdef0123456789abcdef01234567 0\tpackages/owletto\n"
      )
    ).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  test("returns null when the path is not a submodule", () => {
    expect(parseLsFilesS("")).toBeNull();
    expect(parseLsFilesS("100644 abc123 0\tREADME.md\n")).toBeNull();
  });
});

describe("dirtyNotice", () => {
  test("stays silent on a clean tree", () => {
    expect(dirtyNotice([], [])).toBeNull();
  });

  test("counts parent and submodule files separately", () => {
    const notice = dirtyNotice(["a.ts", "b.ts"], ["packages/owletto/x.ts"]);
    expect(notice).toContain("2 file(s)");
    expect(notice).toContain("1 in owletto");
  });
});

describe("syncState", () => {
  test("round-trips and rejects corrupt files", () => {
    const dir = temporaryDirectory("sandbox-state-");
    const path = syncStatePath("test-name", dir);
    expect(readSyncState(path)).toBeNull();
    writeSyncState(path, {
      lobuHead: "aaa",
      owlettoHead: "bbb",
      lockHash: "ccc",
      files: { "a.ts": "h1" },
    });
    expect(readSyncState(path)).toEqual({
      lobuHead: "aaa",
      owlettoHead: "bbb",
      lockHash: "ccc",
      files: { "a.ts": "h1" },
    });
    writeFileSync(path, "not json{{{");
    expect(readSyncState(path)).toBeNull();
  });
});

describe("changedSince", () => {
  function commitAll(root: string, message: string) {
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message],
      { cwd: root }
    );
  }

  test("lists committed edits plus untracked files, minus .env", () => {
    const root = fixtureRepo();
    const sub = join(root, "packages/owletto");
    const before = currentHeads(root, sub);
    writeFileSync(join(root, "README.md"), "changed\n");
    writeFileSync(join(root, "scratch.ts"), "export const a = 1;\n");
    writeFileSync(join(root, ".env"), "DATABASE_URL=x\n");
    const changes = changedSince(root, sub, before);
    expect(changes?.files).toContain("README.md");
    expect(changes?.files).toContain("scratch.ts");
    expect(changes?.files).not.toContain(".env");
    expect(changes?.envChanged).toBe(true);
  });

  test("returns null for an unknown range instead of guessing", () => {
    const root = fixtureRepo();
    const sub = join(root, "packages/owletto");
    expect(
      changedSince(root, sub, { lobuHead: null, owlettoHead: null })
    ).toBeNull();
  });

  test("stays incremental when the pointer trails the checkout", () => {
    const root = fixtureRepo();
    addOwlettoSubmodule(root);
    commitAll(root, "add submodule");
    const sub = join(root, "packages/owletto");
    const before = currentHeads(root, sub);
    // Advance the checkout past the recorded pointer: the index trails, but
    // old..HEAD still covers everything the pointer names.
    writeFileSync(join(sub, "app.ts"), "export const app = 2;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: sub });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ahead"],
      { cwd: sub }
    );
    const changes = changedSince(root, sub, before);
    expect(changes?.files).toContain("packages/owletto/app.ts");
  });

  test("returns null when the index names content the checkout lacks", () => {
    const root = fixtureRepo();
    addOwlettoSubmodule(root);
    commitAll(root, "add submodule");
    const sub = join(root, "packages/owletto");
    // Advance the submodule, stage the new pointer in the parent, then rewind
    // the checkout: the index names C2 while the checkout sits at C1, so the
    // recorded range would miss C2's content.
    writeFileSync(join(sub, "app.ts"), "export const app = 2;\n");
    execFileSync("git", ["add", "app.ts"], { cwd: sub });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ahead"],
      { cwd: sub }
    );
    execFileSync("git", ["add", "packages/owletto"], { cwd: root });
    execFileSync("git", ["reset", "-q", "--hard", "HEAD~1"], { cwd: sub });
    const before = currentHeads(root, sub);
    expect(changedSince(root, sub, before)).toBeNull();
  });
});

describe("lockfileEntries", () => {
  test("hashes bun.lock plus workspace manifests and moves on edit", () => {
    const root = temporaryDirectory("sandbox-lock-");
    writeFileSync(join(root, "bun.lock"), "lock v1\n");
    writeFileSync(join(root, "package.json"), '{"name":"root"}\n');
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    writeFileSync(
      join(root, "packages", "a", "package.json"),
      '{"name":"a"}\n'
    );
    const before = hashEntries(lockfileEntries(root));
    writeFileSync(join(root, "bun.lock"), "lock v2\n");
    expect(hashEntries(lockfileEntries(root))).not.toBe(before);
  });
});

describe("buildTarball delta", () => {
  test("an only-set archives the subset while the manifest stays full", () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
    const stage = buildTarball(root, new Set(["a.ts"]));
    temporaryDirectories.push(stage);
    const names = entries(join(stage, "tree.tar.gz"));
    expect(names).toContain("a.ts");
    expect(names).not.toContain("b.ts");
  });
});
