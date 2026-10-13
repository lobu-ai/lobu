import { describe, expect, test } from "bun:test";
import type { PlatformConnection } from "../../types.js";
import { slackPlatform } from "../slack.js";

function install(metadata: Record<string, unknown>): PlatformConnection {
  return {
    id: "slackinst-tenant-test",
    platform: "slack",
    organizationId: "org-tenant-test",
    config: { platform: "slack" },
    settings: {},
    metadata,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  } as PlatformConnection;
}

const sameTenant = (metadata: Record<string, unknown>, raw: unknown) =>
  slackPlatform.senderIsSameTenant?.(install(metadata), raw) ?? false;

describe("Slack senderIsSameTenant", () => {
  test("vouches for a sender whose home team is the install team", () => {
    expect(sameTenant({ teamId: "T0HOME" }, { team: "T0HOME", user: "U0A" })).toBe(true);
  });

  test("does not treat a replay routing team as proof of sender membership", () => {
    expect(sameTenant({ teamId: "T0HOME" }, { team_id: "T0HOME", user: "U0EXTERNAL" })).toBe(false);
  });

  test("does not vouch for a Slack Connect sender from another team", () => {
    expect(sameTenant({ teamId: "T0HOME" }, { team: "T0HOME", user_team: "T0OTHER", source_team: "T0OTHER" })).toBe(false);
    // A home-team user posting into a channel originating elsewhere is not vouched either.
    expect(sameTenant({ teamId: "T0HOME" }, { team: "T0HOME", user_team: "T0HOME", source_team: "T0OTHER" })).toBe(false);
  });

  test("a Grid org-wide install (enterprise E…) vouches for nobody", () => {
    expect(sameTenant({ teamId: "E0ENTERPRISE", isEnterpriseInstall: true }, { team: "T0WORKSPACE" })).toBe(false);
    expect(sameTenant({ teamId: "E0ENTERPRISE" }, { team: "E0ENTERPRISE" })).toBe(false);
  });

  test("fails closed without an install team or a sender team", () => {
    expect(sameTenant({}, { team: "T0HOME" })).toBe(false);
    expect(sameTenant({ teamId: "T0HOME" }, {})).toBe(false);
    expect(sameTenant({ teamId: "T0HOME" }, null)).toBe(false);
    expect(sameTenant({ teamId: "T0HOME" }, { team: 42 })).toBe(false);
  });
});
