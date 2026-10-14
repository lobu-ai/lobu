// Two members, real `lobu daemon` processes, one team workspace: checks the
// team device version rule and who may approve a run on a member's own device.
//
// Runs inside `make sandbox` against its dev server (not CI — it needs the
// stack and spawns daemons):
//   make sandbox-sync
//   make sandbox-run CMD='pgrep -af postgres'   # the embedded Postgres port (-p)
//   make sandbox-run CMD='E2E_BASE_URL=http://127.0.0.1:8787 E2E_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:<port>/postgres bun scripts/e2e-device-version.ts'
//
// A "newer" device is an overlay copy of the CLI whose generated os.shell
// manifest is bumped to E2E_NEWER_VERSION; the stock checkout is the "older" one.
// Use a disposable stack. Synthetic users and devices are removed before and
// after a run; the team workspace is left for inspection. Child processes and
// temporary files are cleaned up.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const base = process.env.E2E_BASE_URL;
const databaseUrl = process.env.E2E_DATABASE_URL;
if (!base || !databaseUrl) {
  throw new Error(
    "Set E2E_BASE_URL and E2E_DATABASE_URL to an explicit disposable test stack."
  );
}
const repo = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "lobu-e2e-device-version-"));
const newerVersion = process.env.E2E_NEWER_VERSION ?? "9.9.9";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`
  );
}

const sql = postgres(databaseUrl);
const daemons: ChildProcess[] = [];
const logFiles: number[] = [];

// Synthetic rows this script creates are all prefixed `e2e_dv_` / `headless:e2e-dv-`.
// Remove them before and after a run: a leftover second user breaks
// single-user `local-init`.
async function removeSyntheticRows() {
  await sql`DELETE FROM member WHERE "userId" LIKE 'e2e_dv_%'`;
  await sql`DELETE FROM session WHERE "userId" LIKE 'e2e_dv_%'`;
  await sql`DELETE FROM device_workers WHERE worker_id LIKE 'headless:e2e-dv-%'`;
  await sql`DELETE FROM "user" WHERE id LIKE 'e2e_dv_%'`;
}
await removeSyntheticRows();
// Each run pairs three CLIs; the dev server's OAuth client-registration limit
// (10/h) would otherwise fail the fourth run in an hour.
await sql`DELETE FROM rate_limit_counters`;

try {
  // --- a CLI overlay whose os.shell manifest is newer ---------------------------
  // The daemon advertises the manifests generated into connector-worker's dist,
  // so the overlay copies cli + connector-worker and bumps that one file.
  function newerOverlay(): string {
    const root = join(scratch, "newer");
    const copied = ["cli", "connector-worker"];
    for (const pkg of copied) {
      cpSync(join(repo, "packages", pkg), join(root, "packages", pkg), {
        recursive: true,
        filter: (src) => !src.includes(`${pkg}/node_modules`),
      });
      const own = join(repo, "packages", pkg, "node_modules");
      if (existsSync(own))
        symlinkSync(own, join(root, "packages", pkg, "node_modules"));
    }
    // Root node_modules: everything as-is except the copied packages.
    const modules = join(root, "node_modules");
    mkdirSync(join(modules, "@lobu"), { recursive: true });
    for (const name of readdirSync(join(repo, "node_modules"))) {
      if (name !== "@lobu")
        symlinkSync(join(repo, "node_modules", name), join(modules, name));
    }
    for (const name of readdirSync(join(repo, "node_modules", "@lobu"))) {
      symlinkSync(
        copied.includes(name)
          ? join(root, "packages", name)
          : join(repo, "node_modules", "@lobu", name),
        join(modules, "@lobu", name)
      );
    }
    const file = join(
      root,
      "packages",
      "connector-worker",
      "dist",
      "daemon",
      "generated",
      "headless-device-connector-manifests.json"
    );
    const manifests = JSON.parse(readFileSync(file, "utf8")) as Array<{
      key: string;
      version: string;
    }>;
    const shell = manifests.find((m) => m.key === "os.shell");
    if (!shell) throw new Error(`no os.shell manifest in ${file}`);
    shell.version = newerVersion;
    writeFileSync(file, JSON.stringify(manifests));
    return root;
  }
  const overlay = newerOverlay();

  // --- people and a team workspace ---------------------------------------------
  const initA = (await (
    await fetch(`${base}/api/local-init`, {
      method: "POST",
      headers: { "X-Lobu-Client": "e2e-dv" },
    })
  ).json()) as { session_token?: string };
  const authA = {
    Authorization: `Bearer ${initA.session_token}`,
    "Content-Type": "application/json",
  };
  const team = (await (
    await fetch(`${base}/api/auth/organization/create`, {
      method: "POST",
      headers: { ...authA, Origin: base },
      body: JSON.stringify({
        name: "Device Version Team",
        slug: `dv-team-${Date.now()}`,
      }),
    })
  ).json()) as { id: string; slug: string };

  // A plain member, inserted directly (single-user local mode blocks sign-up, not sessions).
  const userB = `e2e_dv_${Date.now()}`;
  const tokenB = `e2edv${randomUUID().replaceAll("-", "")}`;
  await sql`INSERT INTO "user" (id, name, email, "emailVerified") VALUES (${userB}, 'Bee Member', ${`${userB}@example.test`}, true)`;
  await sql`INSERT INTO session (id, token, "userId", "expiresAt") VALUES (${randomUUID()}, ${tokenB}, ${userB}, now() + interval '1 day')`;
  await sql`INSERT INTO member (id, "organizationId", "userId", role) VALUES (${randomUUID()}, ${team.id}, ${userB}, 'member')`;
  const authB = {
    Authorization: `Bearer ${tokenB}`,
    "Content-Type": "application/json",
  };

  async function tool(
    auth: Record<string, string>,
    name: string,
    args: Record<string, unknown>
  ) {
    const r = await fetch(`${base}/api/${team.slug}/${name}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(args),
    });
    return { status: r.status, body: (await r.json()) as any };
  }
  async function devicesOf(auth: Record<string, string>) {
    const res = await fetch(`${base}/api/me/devices`, { headers: auth });
    return ((await res.json()) as { devices: any[] }).devices;
  }
  async function shellConnectionsOf(userId: string) {
    return (await sql`
		SELECT c.id, c.status, c.visibility, c.device_worker_id::text AS device_worker_id, dw.worker_id
		FROM connections c LEFT JOIN device_workers dw ON dw.id = c.device_worker_id
		WHERE c.organization_id = ${team.id} AND c.connector_key = 'os.shell'
		  AND c.created_by = ${userId} AND c.deleted_at IS NULL
		ORDER BY c.id
	`) as unknown as Array<{
      id: number;
      status: string;
      visibility: string;
      device_worker_id: string;
      worker_id: string;
    }>;
  }
  const installedVersion = async () =>
    ((
      await sql`
		SELECT version FROM connector_definitions
		WHERE organization_id = ${team.id} AND key = 'os.shell' AND status = 'active'
	`
    )[0]?.version as string | undefined) ?? null;

  // --- pairing a real daemon into the team --------------------------------------
  async function pair(
    label: string,
    auth: Record<string, string>,
    cliRoot: string,
    workerId: string
  ) {
    const home = join(scratch, `home-${label}`);
    mkdirSync(join(home, ".config", "lobu"), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      FORCE_COLOR: "0",
    };
    delete env.LOBU_API_TOKEN;
    delete env.WORKER_API_TOKEN;
    // CLI environment overrides take precedence even over an explicit context.
    delete env.LOBU_API_URL;
    delete env.LOBU_CONTEXT;
    delete env.LOBU_ORG;
    delete env.LOBU_MEMORY_URL;
    const cli = join(cliRoot, "packages", "cli", "bin", "lobu.js");
    for (const args of [
      [
        "context",
        "add",
        "local",
        "--url",
        base.replace("127.0.0.1", "localhost"),
      ],
      ["context", "use", "local"],
    ]) {
      const result = spawnSync("node", [cli, ...args], {
        env,
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `${label}: context setup failed (${result.status})\n${result.stderr}`
        );
    }
    const login = spawn(
      "node",
      [cli, "login", "--force", "--context", "local"],
      {
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    daemons.push(login);
    const loginDone = new Promise<number | null>((resolve, reject) => {
      login.once("exit", resolve);
      login.once("error", reject);
    });
    // Observe early failures while waiting for the device code below.
    void loginDone.catch(() => undefined);
    let out = "";
    login.stdout?.on("data", (d) => (out += d));
    login.stderr?.on("data", (d) => (out += d));
    let code: string | undefined;
    for (let i = 0; i < 40 && !code; i++) {
      await sleep(500);
      code = out.match(/Code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1];
    }
    if (!code) throw new Error(`${label}: no device code\n${out}`);
    await fetch(`${base}/oauth/device/info?user_code=${code}`, {
      headers: auth,
    });
    const approve = await fetch(`${base}/oauth/device/approve`, {
      method: "POST",
      headers: { ...auth, Origin: base },
      body: JSON.stringify({
        user_code: code,
        approved: true,
        organization_id: team.id,
        organization_ids: [team.id],
        workspace_access: "selected",
      }),
    });
    if (!approve.ok)
      throw new Error(
        `${label}: approve ${approve.status} ${await approve.text()}`
      );
    const loginStatus = await loginDone;
    if (loginStatus !== 0)
      throw new Error(`${label}: login failed (${loginStatus})\n${out}`);
    const log = openSync(join(scratch, `${label}.log`), "a");
    logFiles.push(log);
    const daemon = spawn("node", [cli, "daemon", "--worker-id", workerId], {
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    daemons.push(daemon);
    return home;
  }
  async function until<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    seconds = 60
  ): Promise<T> {
    let value = await read();
    for (let i = 0; i < seconds / 2 && !done(value); i++) {
      await sleep(2000);
      value = await read();
    }
    return value;
  }

  /** Execute `echo $HOME` and decide it as `decider`; returns the run's final body. */
  async function runAndDecide(
    requester: Record<string, string>,
    decider: Record<string, string>,
    connectionId: number
  ) {
    const ex = await tool(requester, "manage_operations", {
      action: "execute",
      connection_id: connectionId,
      operation_key: "run",
      input: { command: "echo $HOME", timeout_ms: 15000 },
    });
    const runId = ex.body.run_id ?? ex.body.run?.id;
    if (ex.status !== 200 || !runId)
      throw new Error(`execute failed: ${JSON.stringify(ex)}`);
    const approval = await tool(decider, "manage_operations", {
      action: "approve",
      run_id: runId,
    });
    const final = await until(
      async () =>
        (
          await tool(requester, "manage_operations", {
            action: "get_run",
            run_id: runId,
          })
        ).body,
      (b) =>
        ["completed", "failed", "cancelled"].includes(b.status ?? b.run?.status)
    );
    return {
      runId,
      execute: ex.body,
      approval: approval.body,
      final,
    };
  }

  const workerB1 = `headless:e2e-dv-b1-${Date.now()}`;
  const workerB2 = `headless:e2e-dv-b2-${Date.now()}`;
  const workerA = `headless:e2e-dv-a-${Date.now()}`;

  // 1. A member pairs: they get their own private connection at the stock version.
  const homeB1 = await pair("b1", authB, repo, workerB1);
  const [b1] = await until(
    () => shellConnectionsOf(userB),
    (rows) => rows.length > 0
  );
  const stockVersion = await installedVersion();
  check(
    "member's device is wired a private connection",
    b1?.worker_id === workerB1 && b1.visibility === "private",
    b1
  );

  // 2. The member approves a run on their own device; the approval notified them.
  const own = await runAndDecide(authB, authB, b1.id);
  check(
    "member may approve a run on their own private device",
    own.approval?.approved === true,
    own.approval
  );
  check(
    "the approved run executed on the member's device",
    (own.final.status ?? own.final.run?.status) === "completed" &&
      JSON.stringify(own.final).includes(homeB1),
    own.final
  );
  const notified = await sql`
		SELECT 1 FROM notification_targets nt JOIN events e ON e.id = nt.event_id
		WHERE nt.user_id = ${userB}
		  AND (e.metadata->'delivery_request'->'context'->>'decisionRunId')::bigint = ${own.runId}
	`;
  check("the approval notified the member", notified.length === 1);

  // 3. A device with a newer os.shell advances the workspace.
  await pair("a", authA, overlay, workerA);
  const advanced = await until(installedVersion, (v) => v === newerVersion);
  check(
    `a newer device advances the workspace (${stockVersion} -> ${newerVersion})`,
    advanced === newerVersion,
    advanced
  );

  // 4. The member's device is now behind: kept, told, and still runs its own version.
  await sleep(8000); // let the member's daemon reconcile against the new version
  const behind = (await devicesOf(authB)).find((d) => d.worker_id === workerB1);
  check(
    "the behind device lists os.shell under update_required",
    behind?.update_required?.some(
      (u: any) =>
        u.connector_key === "os.shell" &&
        u.device_version === stockVersion &&
        u.workspace_version === newerVersion
    ),
    behind?.update_required
  );
  const [b1After] = await shellConnectionsOf(userB);
  check(
    "the behind device keeps its connection active",
    b1After?.status === "active",
    b1After
  );
  const stillRuns = await runAndDecide(authB, authB, b1.id);
  check(
    "the behind device still runs work on its own version",
    (stillRuns.final.status ?? stillRuns.final.run?.status) === "completed" &&
      JSON.stringify(stillRuns.final).includes(homeB1),
    stillRuns.final
  );

  // 5. A second behind device gets no connection, only the update notice.
  await pair("b2", authB, repo, workerB2);
  const b2 = await until(
    async () => (await devicesOf(authB)).find((d) => d.worker_id === workerB2),
    (d) => (d?.update_required?.length ?? 0) > 0
  );
  check(
    "a second behind device gets no connection",
    !(await shellConnectionsOf(userB)).some((c) => c.worker_id === workerB2)
  );
  check(
    "a second behind device lists the update",
    b2?.update_required?.[0]?.connector_key === "os.shell",
    b2?.update_required
  );

  // 6. The workspace owner's own (up-to-date) device reports nothing to update.
  const a = (await devicesOf(authA)).find((d) => d.worker_id === workerA);
  check(
    "an up-to-date device lists no update",
    Array.isArray(a?.update_required) && a.update_required.length === 0,
    a?.update_required
  );
} finally {
  for (const daemon of daemons) {
    try {
      if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null)
        process.kill(-daemon.pid);
    } catch {
      // Already exited.
    }
  }
  for (const fd of logFiles) closeSync(fd);
  await removeSyntheticRows().catch((err) =>
    console.error("cleanup failed:", err)
  );
  await sql.end();
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
