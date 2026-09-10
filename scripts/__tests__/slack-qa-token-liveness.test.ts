import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../slack-qa-token-liveness.sh");

// Real token shapes, so an assertion that the script never echoes a value is
// checking against something that looks like the thing we are protecting.
const USER_TOKEN = "xoxp-qa-user-secret-value";
const BOT_TOKEN = "xoxb-qa-bot-secret-value";
const TARGET_TOKEN = "xoxb-target-bot-secret-value";

describe("Slack QA credential liveness", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slack-liveness-"));
    mkdirSync(join(dir, "bin"));
    // Fake curl: logs the Slack method it was asked for and answers from
    // AUTH_RESPONSES, keyed by the bearer token it was handed. A fixture is
    // either a JSON body, the string "__transport_error__" (curl itself
    // fails, so the unreachable branch is reachable without a network), a raw
    // non-JSON string, or { __status, body } to pin an HTTP status. It honours
    // -w the way curl does, since the script reads the status from there.
    writeFileSync(
      join(dir, "bin/curl"),
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const url = args.find(a => a.startsWith("http")) || "";
appendFileSync(process.env.CALL_LOG, (url.split("/").pop() || "?") + "\\n");
if (!url.startsWith("https://slack.com/api/")) process.exit(22);
const auth = args[args.indexOf("-H") + 1] || "";
const token = auth.replace("Authorization: Bearer ", "");
const responses = JSON.parse(process.env.AUTH_RESPONSES);
let body = responses[token] ?? { ok: false, error: "invalid_auth" };
if (body === "__transport_error__") process.exit(7);
let status = 200;
if (body && body.__status !== undefined) { status = body.__status; body = body.body ?? ""; }
process.stdout.write(typeof body === "string" ? body : JSON.stringify(body));
const w = args.indexOf("-w");
if (w !== -1) {
  process.stdout.write(args[w + 1].replace(/\\\\n/g, "\\n").replace("%{http_code}", String(status)));
}
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const alive = (userId: string) => ({
    ok: true,
    team: "lobu-qa",
    user_id: userId,
  });

  function run(
    env: Record<string, string>,
    responses: Record<string, unknown> = {
      [USER_TOKEN]: alive("U_QA"),
      [BOT_TOKEN]: alive("U_QA_BOT"),
      [TARGET_TOKEN]: alive("U_TARGET"),
    }
  ) {
    const result = Bun.spawnSync(["bash", script], {
      cwd: dir,
      env: {
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        HOME: process.env.HOME,
        CALL_LOG: join(dir, "calls"),
        AUTH_RESPONSES: JSON.stringify(responses),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      calls: existsSync(join(dir, "calls"))
        ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n")
        : [],
    };
  }

  const fullyConfigured = {
    QA_SLACK_USER_TOKEN: USER_TOKEN,
    QA_SLACK_BOT_TOKEN: BOT_TOKEN,
    SLACK_BOT_TOKEN: TARGET_TOKEN,
    QA_SLACK_CHANNEL: "C_QA",
  };

  it("passes when every credential authenticates and the smoke has its inputs", () => {
    const result = run(fullyConfigured);
    expect(result.code).toBe(0);
    expect(result.output).toContain("QA_SLACK_USER_TOKEN");
    expect(result.output).toContain("alive");
    expect(result.output).toContain("team=lobu-qa");
    expect(result.output).toContain("✓ target bot: U_TARGET");
    expect(result.output).toContain("✓ channel: C_QA");
  });

  // Every branch that prints a credential line has to be covered here, not
  // just the happy one: the rejected and unreachable paths are where an
  // implementation is most tempted to dump the response (or the token) to
  // explain itself, and a leak there lands in a public Actions log.
  it.each([
    [
      "alive",
      {
        [USER_TOKEN]: alive("U_QA"),
        [BOT_TOKEN]: alive("U_QA_BOT"),
        [TARGET_TOKEN]: alive("U_TARGET"),
      },
    ],
    [
      "rejected",
      {
        [USER_TOKEN]: { ok: false, error: "invalid_auth" },
        [BOT_TOKEN]: { ok: false, error: "token_revoked" },
        [TARGET_TOKEN]: { ok: false, error: "account_inactive" },
      },
    ],
    [
      "unreachable",
      {
        [USER_TOKEN]: "__transport_error__",
        [BOT_TOKEN]: "__transport_error__",
        [TARGET_TOKEN]: "__transport_error__",
      },
    ],
    [
      "unparseable",
      { [USER_TOKEN]: "not json at all", [BOT_TOKEN]: 42, [TARGET_TOKEN]: [] },
    ],
    // A non-200 is its own print branch, separate from a curl failure. It is
    // the branch most likely to want to quote the response, and the body it
    // gets handed is attacker-adjacent (an edge error page, not Slack JSON).
    [
      "http-error",
      {
        [USER_TOKEN]: {
          __status: 503,
          body: "<html>upstream unavailable</html>",
        },
        [BOT_TOKEN]: { __status: 429, body: "rate limited" },
        [TARGET_TOKEN]: { __status: 500, body: "" },
      },
    ],
  ])("never prints a token value (%s credentials)", (_label, responses) => {
    const result = run(fullyConfigured, responses as Record<string, unknown>);
    expect(result.output).not.toContain(USER_TOKEN);
    expect(result.output).not.toContain(BOT_TOKEN);
    expect(result.output).not.toContain(TARGET_TOKEN);
    // The name and length are the whole permitted description of a credential.
    expect(result.output).toContain(`len=${USER_TOKEN.length}`);
  });

  it("posts nothing to Slack — auth.test only", () => {
    const result = run(fullyConfigured);
    expect(result.calls).toEqual(["auth.test", "auth.test", "auth.test"]);
    expect(result.calls).not.toContain("chat.postMessage");
    expect(result.calls).not.toContain("conversations.replies");
  });

  it("fails on a stored-but-dead credential even though a fallback sender works", () => {
    const result = run(fullyConfigured, {
      [USER_TOKEN]: { ok: false, error: "account_inactive" },
      [BOT_TOKEN]: alive("U_QA_BOT"),
      [TARGET_TOKEN]: alive("U_TARGET"),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("DEAD (account_inactive)");
    // The working fallback is still reported, so the run says what to keep.
    expect(result.output).toContain("sender: QA_SLACK_BOT_TOKEN");
  });

  it("prefers the user token as sender when both authenticate", () => {
    const result = run(fullyConfigured);
    expect(result.output).toContain("✓ sender: QA_SLACK_USER_TOKEN (U_QA)");
  });

  it("reports an unset credential without counting it as rot", () => {
    const result = run({
      QA_SLACK_BOT_TOKEN: BOT_TOKEN,
      SLACK_BOT_TOKEN: TARGET_TOKEN,
      QA_SLACK_CHANNEL: "C_QA",
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("QA_SLACK_USER_TOKEN      not set");
  });

  it("fails when no sender token authenticates", () => {
    const result = run({
      SLACK_BOT_TOKEN: TARGET_TOKEN,
      QA_SLACK_CHANNEL: "C_QA",
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("no QA sender token authenticates");
  });

  it("fails when the target bot cannot be resolved", () => {
    const result = run({
      QA_SLACK_USER_TOKEN: USER_TOKEN,
      QA_SLACK_CHANNEL: "C_QA",
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("target bot unresolved");
  });

  it("fails when the sender is also the target", () => {
    const result = run(
      {
        QA_SLACK_USER_TOKEN: USER_TOKEN,
        SLACK_BOT_TOKEN: TARGET_TOKEN,
        QA_SLACK_CHANNEL: "C_QA",
      },
      {
        [USER_TOKEN]: alive("U_SAME"),
        [TARGET_TOKEN]: alive("U_SAME"),
      }
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("same Slack user (U_SAME)");
  });

  it("fails when no channel is configured", () => {
    const result = run({
      QA_SLACK_USER_TOKEN: USER_TOKEN,
      SLACK_BOT_TOKEN: TARGET_TOKEN,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("QA_SLACK_CHANNEL is not set");
  });

  it("distinguishes an unreachable Slack from a rejected credential", () => {
    const result = run(fullyConfigured, {
      [USER_TOKEN]: "__transport_error__",
      [BOT_TOKEN]: alive("U_QA_BOT"),
      [TARGET_TOKEN]: alive("U_TARGET"),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("UNREACHABLE");
    expect(result.output).not.toContain("DEAD");
  });

  // A Slack outage must not read as credential rot: the scheduled job pages
  // the devops channel on failure, and a verdict that blamed the token would
  // send someone rotating a credential that is fine.
  it("blames Slack, not the credential, for a non-200 response", () => {
    const result = run(fullyConfigured, {
      [USER_TOKEN]: {
        __status: 503,
        body: "<html>upstream unavailable</html>",
      },
      [BOT_TOKEN]: alive("U_QA_BOT"),
      [TARGET_TOKEN]: alive("U_TARGET"),
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("UNREACHABLE (HTTP 503)");
    expect(result.output).not.toContain("DEAD");
  });

  // jq's `//` fallback only fires on a body that parses, so the two verdicts
  // are easy to print backwards: an empty parenthetical for a body that is
  // genuinely not JSON, and "unparseable" for one that parsed fine.
  it("labels a body that is not JSON, and only that body, unparseable", () => {
    const garbage = run(fullyConfigured, {
      [USER_TOKEN]: "<html>captive portal</html>",
      [BOT_TOKEN]: alive("U_QA_BOT"),
      [TARGET_TOKEN]: alive("U_TARGET"),
    });
    expect(garbage.code).toBe(1);
    expect(garbage.output).toContain("DEAD (unparseable response)");

    const enumerated = run(fullyConfigured, {
      [USER_TOKEN]: { ok: false, error: "token_revoked" },
      [BOT_TOKEN]: alive("U_QA_BOT"),
      [TARGET_TOKEN]: alive("U_TARGET"),
    });
    expect(enumerated.output).toContain("DEAD (token_revoked)");
    expect(enumerated.output).not.toContain("unparseable");
  });

  it("honours an explicit target id without needing SLACK_BOT_TOKEN", () => {
    const result = run({
      QA_SLACK_USER_TOKEN: USER_TOKEN,
      QA_SLACK_TARGET_USER_ID: "U_EXPLICIT",
      QA_SLACK_CHANNEL: "C_QA",
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("✓ target bot: U_EXPLICIT");
    expect(result.calls).toEqual(["auth.test"]);
  });
});
