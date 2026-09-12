import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const template = readFileSync(
  resolve(import.meta.dir, "../templates/AGENTS.md.tmpl"),
  "utf8"
);
const testingTemplate = readFileSync(
  resolve(import.meta.dir, "../templates/TESTING.md.tmpl"),
  "utf8"
);

describe("generated AGENTS.md onboarding guidance", () => {
  test("requires confirmed business research before schema design", () => {
    expect(template).toContain("company or product");
    expect(template).toContain("public domain");
    expect(template).toContain("permission to research");
    expect(template).toContain("cite the public sources");
  });

  test("discovers managed auth before requesting BYO OAuth credentials", () => {
    expect(template).toContain("client.organizations.list()");
    expect(template).toContain("client.connections.connectManaged");
    expect(template).toContain("local_bootstrap_command");
    expect(template).toContain("from the parent directory");
    expect(template).toContain("lobu login --email <address>");
    expect(template).toContain("before asking for OAuth client credentials");
    expect(template).toContain("Never revoke or repeat");
    expect(template).toContain("Never open or read this file");
    expect(template).toContain("`.env.example` when present");
  });

  test("derives Automation event triggers from feed eventKinds with explicit automationEvents winning", () => {
    expect(template).toContain("feeds_schema.<feed>.eventKinds");
    expect(template).toContain("`automation_events`");
    expect(template).toContain("detail.auth_schema");
    expect(template).toContain("detail.options_schema");
    expect(template).toContain("subscribable `event_type`");
    expect(template).toContain("automation_signals");
    expect(template).toContain(
      "SELECT id, title, payload_text, metadata, occurred_at FROM events"
    );
  });

  test("documents durable Automation chaining without making every event a trigger", () => {
    expect(template).toContain('source: "workspace"');
    expect(template).toContain("declared event output");
    expect(template).toContain(
      "Ordinary knowledge saves and connector-ingested events"
    );
    expect(template).toContain("do not activate workspace-source triggers");
    expect(template).toContain("exact event pointers");
    expect(template).toContain("docs/AUTOMATIONS.md");
  });

  test("treats Slack install, surfaces, and member knowledge as separate proofs", () => {
    expect(template).toContain("install the Lobu app into an existing");
    expect(template).toContain("their DM with Lobu, a named channel, or both");
    expect(template).toContain("Verify the App Home separately");
    expect(template).toContain("full workspace directory");
    expect(template).toContain("report that product gap");
    expect(template).toContain("approve Slack's OAuth");
    expect(template).toContain("do not invent or trigger a Slack");
    expect(template).toContain("`/lobu link <code>` is one-time");
    expect(template).toContain("`/lobu link <agent-id>`");
  });

  test("requires local proof before an explicit cloud apply", () => {
    expect(template).toContain("lobu apply --dry-run");
    expect(template).toContain("explicit cloud context");
    expect(template).toContain("lobu context use <cloud-name>");
    expect(template).toContain("authoritative `view_url`");
    expect(template).toContain("Do not call onboarding complete");
    expect(template).toContain("connectors that expose no sync-capable feed");
    expect(template).toContain(
      "never run the project from its parent directory"
    );
    expect(template).toContain("ask before accessing real provider");
  });
});

describe("generated TESTING.md onboarding guidance", () => {
  test("uses the current CLI and ClientSDK verification paths", () => {
    expect(testingTemplate).toContain("memory health --context local");
    expect(testingTemplate).toContain("--dry-run --new");
    expect(testingTemplate).toContain("client.feeds.trigger");
    expect(testingTemplate).not.toContain("connector run");
    expect(testingTemplate).not.toContain("browser-auth");
    expect(testingTemplate).toContain(
      "Browser actions require a paired extension"
    );
    expect(testingTemplate).toContain(
      "inspect its device metadata without invoking browser actions"
    );
    expect(testingTemplate).toContain(
      "explicitly approves provider-data access"
    );
    expect(testingTemplate).toContain("client.automations.trigger");
    expect(testingTemplate).toContain("client.operations.getRun");
    expect(testingTemplate).toContain("memory run search_memory");
    expect(testingTemplate).toContain("records the run but does not persist");
    expect(testingTemplate).not.toContain("xoxb-your-bot-token");
    expect(testingTemplate).not.toContain('"threadUrl"');
  });
});
