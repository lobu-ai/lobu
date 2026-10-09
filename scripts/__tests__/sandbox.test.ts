import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import {
  HOST_ONLY_ENV_KEYS,
  SANDBOX_CONTROLLED_ENV_KEYS,
  applyTreeSync,
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
  needsMcpRebuild,
  orphanSandboxNames,
  parseLsFilesS,
  parsePorcelainZ,
  parseWorktreeRoots,
  planSync,
  previewUrlFor,
  readSyncState,
  resolveOwnerEmail,
  resolveScope,
  sandboxName,
  sanitizedEnv,
  sessionTokenFrom,
  signInScript,
  signUpScript,
  syncIncremental,
  syncScope,
  upIncremental,
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
    ).toBe("FRESH=1 requested");
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
    expect(parsePorcelainZ("R  new.ts\0old.ts\0")).toEqual(["new.ts"]);
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
    const root = fixtureRepo();
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
    expect(
      readFileSync(join(stage, "manifest.bin"), "utf8").split("\0")
    ).toContain("b.ts");
  });
});

describe("incremental sync regressions", () => {
  function remote() {
    const uploads = new Map<string, Buffer>();
    const commands: string[] = [];
    let failCommand: string | undefined;
    const sandbox = {
      id: "synthetic-sandbox",
      public: true,
      state: "started",
      refreshData: async () => undefined,
      getPreviewLink: async () => ({ url: "https://sandbox.example.test" }),
      sandboxApi: {
        updatePublicStatus: async (_id: string, value: boolean) => {
          commands.push(`public:${value}`);
          sandbox.public = value;
        },
      },
      fs: {
        uploadFile: async (source: string, target: string) => {
          uploads.set(target, readFileSync(source));
        },
      },
      process: {
        executeCommand: async (command: string) => {
          commands.push(command);
          if (failCommand && command.includes(failCommand))
            return { exitCode: 1, result: "synthetic failure" };
          let result = "";
          if (command.startsWith("cat /workspace/.lobu-sandbox-manifest"))
            result =
              uploads.get("/tmp/lobu-sandbox-manifest")?.toString() ?? "";
          else if (command.includes("test -d /workspace/lobu/node_modules"))
            result = "yes";
          else if (command.includes("/proc/net/tcp")) result = "free";
          else if (command.includes("pgrep")) result = "stopped";
          else if (command.includes("/health/ready")) result = "200";
          else if (command.startsWith("cat /workspace/.lobu-sandbox-seat"))
            result = JSON.stringify({
              email: "owner@example.test",
              password: "synthetic-password",
              created_at: "2026-01-01",
            });
          else if (command.includes("/api/auth/sign-in/email"))
            result = '{"token":"synthetic-session"}';
          else if (command.includes("/api/auth/sign-up/email"))
            result = '403\n{"code":"SIGN_UP_DISABLED_IN_SINGLE_USER_MODE"}';
          return { exitCode: 0, result };
        },
      },
    } as unknown as Parameters<typeof applyTreeSync>[0];
    return {
      sandbox,
      uploads,
      commands,
      fail: (command?: string) => {
        failCommand = command;
      },
    };
  }

  test("excludes unstaged deletions from archives and removes them remotely", async () => {
    const root = fixtureRepo();
    const sub = join(root, "packages/owletto");
    const { sandbox, uploads } = remote();
    const first = await applyTreeSync(sandbox, root, sub, null, null);
    rmSync(join(root, "README.md"));
    const next = await applyTreeSync(
      sandbox,
      root,
      sub,
      first.next,
      Object.keys(first.next.files!)
    );
    expect(next.scope).toBe("full");
    expect(uploads.get("/tmp/lobu-sync-remove")?.toString()).toContain(
      "README.md\0"
    );
  });

  test("uploads ignored env edits even when the source tree is unchanged", async () => {
    const root = fixtureRepo();
    writeFileSync(join(root, ".gitignore"), ".env\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-qm",
        "ignore env",
      ],
      { cwd: root }
    );
    writeFileSync(join(root, ".env"), "FEATURE=old\n");
    const sub = join(root, "packages/owletto");
    const { sandbox, uploads } = remote();
    const first = await applyTreeSync(sandbox, root, sub, null, null);
    uploads.clear();
    writeFileSync(join(root, ".env"), "FEATURE=new\n");
    const next = await applyTreeSync(
      sandbox,
      root,
      sub,
      first.next,
      Object.keys(first.next.files!)
    );
    expect(next.scope).toBe("full");
    expect(uploads.get("/workspace/lobu/.env")?.toString()).toBe(
      "FEATURE=new\n"
    );
  });

  test("does not re-upload unchanged uncommitted files", async () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "README.md"), "dirty\n");
    const sub = join(root, "packages/owletto");
    const { sandbox, uploads } = remote();
    const first = await applyTreeSync(sandbox, root, sub, null, null);
    uploads.clear();
    const next = await applyTreeSync(
      sandbox,
      root,
      sub,
      first.next,
      Object.keys(first.next.files!)
    );
    expect(next.scope).toBe("none");
    expect(uploads.size).toBe(0);
  });

  test("removing an uploaded untracked backend file requests a reboot", async () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "scratch.ts"), "export const x = 1;\n");
    const sub = join(root, "packages/owletto");
    const { sandbox } = remote();
    const first = await applyTreeSync(sandbox, root, sub, null, null);
    rmSync(join(root, "scratch.ts"));
    const next = await applyTreeSync(
      sandbox,
      root,
      sub,
      first.next,
      Object.keys(first.next.files!)
    );
    expect(next.scope).toBe("full");
  });

  test("dependency fingerprint includes submodule and untracked workspace manifests", () => {
    const root = fixtureRepo();
    addOwlettoSubmodule(root);
    const before = hashEntries(lockfileEntries(root));
    writeFileSync(
      join(root, "packages/owletto/package.json"),
      '{"dependencies":{"example":"1"}}'
    );
    const subChanged = hashEntries(lockfileEntries(root));
    expect(subChanged).not.toBe(before);
    mkdirSync(join(root, "packages/new-workspace"));
    writeFileSync(
      join(root, "packages/new-workspace/package.json"),
      '{"name":"new-workspace"}'
    );
    expect(hashEntries(lockfileEntries(root))).not.toBe(subChanged);
  });

  for (const failure of ["bun install", "nohup"]) {
    test(`a failed ${failure} leaves no checkpoint and retries the full lifecycle`, async () => {
      const root = fixtureRepo();
      const name = sandboxName(root);
      const statePath = syncStatePath(name);
      const { sandbox, commands, fail } = remote();
      try {
        await upIncremental(sandbox, root, name);
        expect(readSyncState(statePath)).not.toBeNull();
        writeFileSync(join(root, "bun.lock"), "new lock\n");
        fail(failure);
        await expect(upIncremental(sandbox, root, name)).rejects.toThrow(
          "synthetic failure"
        );
        expect(readSyncState(statePath)).toBeNull();
        fail();
        commands.length = 0;
        await upIncremental(sandbox, root, name);
        expect(
          commands.some((command) => command.includes("bun install"))
        ).toBe(true);
        const boot = commands.findIndex((command) => command.includes("nohup"));
        expect(commands.indexOf("public:false")).toBeLessThan(boot);
        expect(commands.indexOf("public:true")).toBeGreaterThan(boot);
        expect(readSyncState(statePath)).not.toBeNull();
      } finally {
        rmSync(statePath, { force: true });
      }
    });
  }

  test("sync preserves pending install and reboot work for the next up", async () => {
    const root = fixtureRepo();
    const name = sandboxName(root);
    const statePath = syncStatePath(name);
    const { sandbox, commands } = remote();
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok")
    );
    try {
      await upIncremental(sandbox, root, name);
      const installed = readSyncState(statePath)!.lockHash;
      writeFileSync(join(root, "bun.lock"), "changed lock\n");
      await syncIncremental(sandbox, root, name);
      expect(readSyncState(statePath)?.lockHash).toBe(installed);
      expect(readSyncState(statePath)?.pendingBoot).toBe(true);
      commands.length = 0;
      await upIncremental(sandbox, root, name);
      expect(commands.some((command) => command.includes("bun install"))).toBe(
        true
      );
      expect(commands.some((command) => command.includes("nohup"))).toBe(true);
      expect(readSyncState(statePath)?.pendingBoot).not.toBe(true);
    } finally {
      fetchMock.mockRestore();
      rmSync(statePath, { force: true });
    }
  });

  test("tracks executable bits, symlinks, reverted edits, and env removal", async () => {
    const root = fixtureRepo();
    const sub = join(root, "packages/owletto");
    writeFileSync(join(root, ".env"), "FEATURE=old\n");
    const { sandbox, uploads, commands } = remote();
    let applied = await applyTreeSync(sandbox, root, sub, null, null);
    const sync = async () => {
      applied = await applyTreeSync(
        sandbox,
        root,
        sub,
        applied.next,
        Object.keys(applied.next.files!)
      );
    };
    chmodSync(join(root, "README.md"), 0o755);
    await sync();
    expect(applied.scope).toBe("full");
    symlinkSync("missing-target", join(root, "link"));
    await sync();
    expect(applied.next.files).toHaveProperty("link");
    writeFileSync(join(root, "README.md"), "experiment\n");
    await sync();
    execFileSync("git", ["restore", "README.md"], { cwd: root });
    await sync();
    expect(applied.scope).toBe("full");
    uploads.clear();
    commands.length = 0;
    rmSync(join(root, ".env"));
    await sync();
    expect(applied.scope).toBe("full");
    expect(commands).toContain("rm -f /workspace/lobu/.env");
  });

  test("frontend edits and removals keep the frontend scope", async () => {
    const root = fixtureRepo();
    addOwlettoSubmodule(root);
    const sub = join(root, "packages/owletto");
    const { sandbox } = remote();
    const first = await applyTreeSync(sandbox, root, sub, null, null);
    writeFileSync(join(sub, "app.ts"), "export const app = false;\n");
    const edit = await applyTreeSync(
      sandbox,
      root,
      sub,
      first.next,
      Object.keys(first.next.files!)
    );
    expect(edit.scope).toBe("frontend");
    rmSync(join(sub, "app.ts"));
    const removal = await applyTreeSync(
      sandbox,
      root,
      sub,
      edit.next,
      Object.keys(edit.next.files!)
    );
    expect(removal.scope).toBe("frontend");
  });

  test("a warm up skips install and boot, while FRESH forces both", async () => {
    const root = fixtureRepo();
    const name = sandboxName(root);
    const statePath = syncStatePath(name);
    const { sandbox, commands, uploads } = remote();
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok")
    );
    const previousFresh = process.env.FRESH;
    try {
      delete process.env.FRESH;
      await upIncremental(sandbox, root, name);
      commands.length = 0;
      const initialArchive = uploads.get("/tmp/tree.tar.gz");
      await upIncremental(sandbox, root, name);
      expect(
        commands.some(
          (command) =>
            command.includes("bun install") || command.includes("nohup")
        )
      ).toBe(false);
      expect(uploads.get("/tmp/tree.tar.gz")).toBe(initialArchive);
      commands.length = 0;
      process.env.FRESH = "1";
      await upIncremental(sandbox, root, name);
      expect(commands.some((command) => command.includes("bun install"))).toBe(
        true
      );
      expect(commands.some((command) => command.includes("nohup"))).toBe(true);
    } finally {
      if (previousFresh === undefined) delete process.env.FRESH;
      else process.env.FRESH = previousFresh;
      fetchMock.mockRestore();
      rmSync(statePath, { force: true });
    }
  });
});

describe("needsMcpRebuild", () => {
  test("matches apps, shared inputs, styles, and build config", () => {
    expect(
      needsMcpRebuild("packages/owletto/src/mcp-apps/review/main.tsx")
    ).toBe(true);
    expect(
      needsMcpRebuild("packages/owletto/src/components/ui/button.tsx")
    ).toBe(true);
    expect(
      needsMcpRebuild("packages/owletto/src/lib/json-renderer/data-table.tsx")
    ).toBe(true);
    expect(needsMcpRebuild("packages/owletto/src/index.css")).toBe(true);
    expect(needsMcpRebuild("packages/owletto/vite.config.mcp.ts")).toBe(true);
  });

  test("leaves ordinary SPA and server code on the fast path", () => {
    expect(
      needsMcpRebuild("packages/owletto/src/components/sidebar/app-sidebar.tsx")
    ).toBe(false);
    expect(needsMcpRebuild("packages/owletto/src/main.tsx")).toBe(false);
    expect(needsMcpRebuild("packages/server/src/index.ts")).toBe(false);
    expect(needsMcpRebuild("scripts/sandbox.ts")).toBe(false);
  });
});

describe("resolveScope", () => {
  test("routes iframe inputs to the reboot path even when alone", () => {
    expect(
      resolveScope(["packages/owletto/src/mcp-apps/review/main.tsx"], false)
    ).toBe("full");
    expect(
      resolveScope(
        ["packages/owletto/src/components/sidebar/app-sidebar.tsx"],
        false
      )
    ).toBe("frontend");
    expect(resolveScope([], false)).toBe("none");
    expect(resolveScope([], true)).toBe("full");
  });
});

describe("mcp bundle coverage", () => {
  const owlettoSrc = resolve(import.meta.dir, "../../packages/owletto/src");

  function resolveImport(
    spec: string,
    fromFile: string
  ): string | string[] | "external" | null {
    const candidates = (base: string) => {
      const stripped = base.endsWith(".js") ? base.slice(0, -3) : null;
      return [
        base,
        ...(stripped ? [`${stripped}.ts`] : []),
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.css`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
      ];
    };
    const pick = (base: string): string | string[] | null => {
      for (const candidate of candidates(base)) {
        try {
          if (statSync(candidate).isFile()) return candidate;
        } catch {
          // try next suffix
        }
      }
      // A directory spec (tailwind `@source`, extensionless folder imports):
      // expand to the source files beneath it.
      try {
        if (statSync(base).isDirectory()) {
          return walkSources(base);
        }
      } catch {
        // not a directory either
      }
      return null;
    };
    if (spec.startsWith("@/")) return pick(join(owlettoSrc, spec.slice(2)));
    if (spec.startsWith("."))
      return pick(normalize(join(dirname(fromFile), spec)));
    return "external";
  }

  function walkSources(dir: string): string[] {
    const out: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules") continue;
      if (/\.(test|stories)\.[^.]+$/.test(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkSources(full));
      else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  function reachableFiles(entries: string[]): {
    files: string[];
    unresolved: string[];
  } {
    const repoRoot = resolve(owlettoSrc, "..", "..", "..");
    const seen = new Set<string>();
    const unresolved: string[] = [];
    const queue = [...entries];
    const inScope = (target: string) => {
      const normalized = normalize(target);
      return (
        normalized.startsWith(`${repoRoot}/`) &&
        !normalized.includes("/node_modules/")
      );
    };
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      // Test fixtures ride alongside sources but never enter a bundle.
      if (/\.(test|stories)\.[^.]+$/.test(file)) continue;
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        unresolved.push(file);
        continue;
      }
      const specs = new Set<string>();
      // A whole-statement `import type` is erased at compile (enforced by
      // verbatimModuleSyntax) so it contributes no bytes to the bundle.
      // Inline `type` qualifiers inside value imports still traverse —
      // conservative, since their sibling values do ship.
      const importPattern =
        /^\s*import(\s+type)?\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gm;
      for (const match of source.matchAll(importPattern)) {
        if (!match[1]) specs.add(match[2]);
      }
      // Only the apps' own stylesheets contribute `@source` inputs: the MCP
      // vite plugin strips every `@source` line out of the shared stylesheet
      // before the iframe build, so index.css's broad SPA scans never feed it.
      // (`@import` above is a real file inclusion and is always followed.)
      const styleInputs =
        file.startsWith(`${owlettoSrc}/mcp-apps/`) && file.endsWith(".css");
      for (const match of source.matchAll(
        /@(?:import|source)\s+["']([^"']+)["']/g
      )) {
        if (match[0].startsWith("@source") && !styleInputs) continue;
        specs.add(match[1]);
      }
      for (const spec of specs) {
        if (
          spec === "tailwindcss" ||
          (!spec.startsWith("@") && !spec.startsWith("."))
        ) {
          continue;
        }
        const resolved = resolveImport(spec, file);
        if (resolved === null) {
          unresolved.push(`${file} -> ${spec}`);
        } else if (resolved !== "external") {
          for (const target of Array.isArray(resolved)
            ? resolved
            : [resolved]) {
            // Dependencies live outside the synced tree (or in node_modules,
            // which is never uploaded): they cannot stale the bundle.
            if (inScope(target) && !seen.has(target)) queue.push(target);
          }
        }
      }
    }
    return { files: [...seen], unresolved };
  }

  test("every module the iframe bundle compiles is reboot-covered", () => {
    if (!existsSync(join(owlettoSrc, "mcp-apps"))) return;
    const repoRoot = resolve(owlettoSrc, "..", "..", "..");
    const { files, unresolved } = reachableFiles([
      join(owlettoSrc, "mcp-apps/interaction/main.tsx"),
      join(owlettoSrc, "mcp-apps/review/main.tsx"),
    ]);
    // node_modules content is never synced, so it cannot stale the bundle.
    const relevant = unresolved.filter(
      (entry) =>
        !entry.includes("/node_modules/") &&
        normalize(entry.split(" -> ")[0]).startsWith(`${repoRoot}/`)
    );
    expect(relevant).toEqual([]);
    const uncovered = files
      .map((file) => normalize(file).replace(`${repoRoot}/`, ""))
      .filter(
        (path) => path.startsWith("packages/owletto/") && !needsMcpRebuild(path)
      );
    expect(uncovered).toEqual([]);
  });
});
