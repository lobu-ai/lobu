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

const script = resolve(import.meta.dir, "../test-bot.sh");
const marker = "SLACK_SMOKE_SYNTHETIC_OK";

describe("Slack API smoke", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slack-smoke-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin/lobu"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    writeFileSync(
      join(dir, "bin/curl"),
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const url = args.find(arg => arg.startsWith("http")) || "";
const method = url.split("/").pop();
appendFileSync(process.env.CALL_LOG, method + "\\n");
if (!url.startsWith("https://slack.com/api/")) process.exit(22);
let result;
if (method === "auth.test") {
  result = { ok: true, user_id: args.some(arg => arg.includes("target-token")) ? "U_TARGET" : "U_QA" };
} else if (method === "chat.postMessage") {
  result = { ok: true, channel: "C_TEST", ts: "1000.000001" };
} else if (method === "conversations.replies") {
  const data = args[args.indexOf("-d") + 1] || "";
  if (!data.includes("oldest=1000.000001")) process.exit(23);
  result = JSON.parse(process.env.SLACK_REPLIES);
} else {
  result = { ok: false, error: "unexpected_method" };
}
console.log(JSON.stringify(result));
`,
      { mode: 0o755 }
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(replies: unknown, overrides: Record<string, string> = {}) {
    const result = Bun.spawnSync(
      ["bash", script, `<@U_TARGET> Reply exactly ${marker}`],
      {
        cwd: dir,
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          HOME: process.env.HOME,
          TEST_PLATFORM: "slack",
          TEST_CHANNEL: "C_TEST",
          TEST_TIMEOUT: "2",
          TEST_AUTH_TOKEN: "synthetic-lobu-token",
          QA_SLACK_USER_TOKEN: "qa-token",
          QA_SLACK_TARGET_USER_ID: "U_TARGET",
          TEST_EXPECT_RESPONSE: marker,
          CALL_LOG: join(dir, "calls"),
          SLACK_REPLIES: JSON.stringify(replies),
          ...overrides,
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    return {
      code: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      calls: existsSync(join(dir, "calls"))
        ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n")
        : [],
    };
  }

  const reply = (user: string, text: string) => ({
    user,
    bot_id: "B_SYNTHETIC",
    ts: "1000.000002",
    text,
  });

  it("uses only Slack APIs and needs no Lobu login", () => {
    const result = run(
      { ok: true, messages: [reply("U_TARGET", marker)] },
      {
        TEST_AUTH_TOKEN: "",
        QA_SLACK_USER_TOKEN: "",
        QA_SLACK_BOT_TOKEN: "qa-token",
        SLACK_BOT_TOKEN: "target-token",
        QA_SLACK_TARGET_USER_ID: "",
      }
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain(marker);
    expect(result.calls).toEqual([
      "auth.test",
      "auth.test",
      "chat.postMessage",
      "conversations.replies",
    ]);
  });

  it("selects the target bot's reply rather than another app's reply", () => {
    const result = run({
      ok: true,
      messages: [
        reply("U_OTHER", "Unrelated bot response"),
        reply("U_TARGET", marker),
      ],
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain(`Matched expected response: ${marker}`);
  });

  it("accepts the expected reply even when the target bot posts again", () => {
    const result = run({
      ok: true,
      messages: [
        reply("U_TARGET", marker),
        reply("U_TARGET", "Later status update"),
      ],
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain(`Matched expected response: ${marker}`);
  });

  it("fails when Lobu replies with an authentication error", () => {
    const result = run({
      ok: true,
      messages: [reply("U_TARGET", "Provider is not connected")],
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("Provider is not connected");
    expect(result.output).not.toContain("All messages sent successfully");
  });

  it("does not accept the expected text from a different bot", () => {
    const result = run({ ok: true, messages: [reply("U_OTHER", marker)] });
    expect(result.code).toBe(1);
  });

  it("reports a Slack read error instead of treating it as no reply", () => {
    const result = run({ ok: false, error: "missing_scope" });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "conversations.replies failed: missing_scope"
    );
  });

  it("rejects a sender that is also the target before posting", () => {
    const result = run(
      { ok: true, messages: [] },
      { QA_SLACK_TARGET_USER_ID: "U_QA" }
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("same Slack user");
    expect(result.calls).not.toContain("chat.postMessage");
  });

  it("never falls back to a forged gateway message for an exact-response smoke", () => {
    const result = run({ ok: true, messages: [] }, { QA_SLACK_USER_TOKEN: "" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("requires Slack with a QA sender token");
    expect(result.calls).toEqual([]);
  });

  it("does not let a QA token override normal platform auto-detection", () => {
    const result = run(
      { ok: true, messages: [] },
      { TEST_PLATFORM: "", TEST_EXPECT_RESPONSE: "" }
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("No platform detected");
    expect(result.calls).toEqual(["test-targets", "test-targets"]);
  });
});
