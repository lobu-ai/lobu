/**
 * Contract tests over the WHOLE platform registry, not any one platform.
 *
 * These hooks exist so generic modules stop branching on a connector slug, and
 * the failure mode of that move is a platform quietly declaring a hook that
 * misbehaves. So every assertion here enumerates `PLATFORM_REGISTRY` — a new
 * platform is covered the moment it is registered, with no edit to this file.
 */

import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../chat-connection-service.js";
import { getPlatformDescriptor, PLATFORM_REGISTRY } from "../index.js";

const PLATFORMS = Object.entries(PLATFORM_REGISTRY);

describe("chat platform descriptor contract", () => {
  // Every generic call site reaches a hook through `getPlatformDescriptor`, so
  // a registry entry that the lookup does not return is a platform whose hooks
  // silently never run.
  test("every registered platform is reachable by its own key", () => {
    expect(PLATFORMS.length).toBeGreaterThan(0);
    for (const [platform, descriptor] of PLATFORMS) {
      expect(getPlatformDescriptor(platform)).toBe(descriptor);
    }
  });

  /**
   * A GOLDEN pin, deliberately naming platforms — the rest of this file is
   * generic on purpose, but the per-platform contract tests above derive their
   * expectation FROM `requiredConfigKeys`, so they stay green if a key is
   * deleted from a declaration. Dropping one is silent and can be
   * security-relevant (without `signingSecret` a Slack connection accepts
   * unverified inbound webhooks), so the sets are pinned here. Adding a
   * platform means adding a line; changing a line should be a decision.
   */
  test("each platform's required credentials are what they should be", () => {
    const declared = Object.fromEntries(
      PLATFORMS.map(([platform, descriptor]) => [
        platform,
        (descriptor.requiredConfigKeys ?? []).map((requirement) =>
          typeof requirement === "string" ? requirement : [...requirement],
        ),
      ]),
    );
    expect(declared).toEqual({
      slack: ["botToken", "signingSecret"],
      telegram: ["botToken"],
      discord: ["botToken", "applicationId", "publicKey"],
      whatsapp: ["accessToken", "phoneNumberId", "appSecret", "verifyToken"],
      teams: ["appId", "appPassword"],
      gchat: [
        ["credentials", "useApplicationDefaultCredentials"],
        "googleChatProjectNumber",
      ],
    });
  });

  // Golden pin, same reason as the credentials one above: a hook that is merely
  // "read off the descriptor" can be deleted from a platform without any
  // outcome-level test noticing, because the absent-hook fallback is a legal
  // answer everywhere. Naming the exact set makes removal loud.
  test("exactly the platforms whose message id pins a message declare it", () => {
    const declaring = PLATFORMS.filter(
      ([, descriptor]) => descriptor.messageIdIdentifiesMessage !== undefined,
    ).map(([platform]) => platform);
    expect(declaring).toEqual(["gchat"]);
  });

  test("gchat pins only a full space-scoped resource name", () => {
    const pins = PLATFORM_REGISTRY.gchat.messageIdIdentifiesMessage;
    if (!pins) throw new Error("gchat must declare messageIdIdentifiesMessage");
    // The real shape the notice path produced in prod.
    expect(pins("spaces/3eodnKAAAAE/messages/abc.abc")).toBe(true);
    // A bare space, a thread route, and Slack's `ts` are all conversation- or
    // thread-scoped, so none of them may suppress the thread check.
    expect(pins("spaces/3eodnKAAAAE")).toBe(false);
    expect(pins("spaces/3eodnKAAAAE/threads/t1")).toBe(false);
    expect(pins("1712345678.000001")).toBe(false);
    expect(pins("")).toBe(false);
  });

  describe.each(PLATFORMS)("%s", (platform, descriptor) => {
    // The `##general` class: `preview/slack.ts` and the conversations listing
    // each held their own copy of the `#` rule and only one stripped an
    // existing prefix, so an already-`#`-prefixed stored name double-prefixed.
    // One owner + idempotence is what makes that unrepresentable.
    test("formatChannelLabel is idempotent", () => {
      const format = descriptor.formatChannelLabel;
      if (!format) return;
      for (const name of ["general", "#general", "#", "a#b", ""]) {
        expect(format(format(name))).toBe(format(name));
      }
    });

    // A slash command hands over a bare id, an inbound event an already
    // canonical one; both reach the same lookup, so canonicalizing twice must
    // not double-prefix.
    test("canonicalChannelId is idempotent", () => {
      const canonical = descriptor.canonicalChannelId;
      if (!canonical) return;
      for (const id of ["C123", "D456", `${platform}:C123`, "slack:C123"]) {
        expect(canonical(canonical(id))).toBe(canonical(id));
      }
    });

    // Both the subscription self-heal and the fallback-link materialization
    // write this id onto a live binding. A blank or structurally wrong value
    // must never qualify — the pre-hook code spelled the rule as an inline
    // regex copied into each of those two call sites.
    test("bindableTeamId rejects blank and non-workspace ids", () => {
      const bindable = descriptor.bindableTeamId;
      if (!bindable) return;
      for (const bad of ["", "   ", "E0ENTERPRISE"]) {
        expect(bindable(bad)).toBe(false);
      }
    });

    // `requiredConfigKeys` replaced a hardcoded table in the generic config
    // service; without that check a credential-less connection persists and
    // fails later at start time. Assert the MESSAGE, not just that something
    // threw: it pins the rejection to THIS platform's declared requirements
    // (an empty config can also trip the schema) and to the `a or b` rendering
    // an either-or group is reported with.
    test("every declared required key is enforced by parseConfig", () => {
      const required = descriptor.requiredConfigKeys ?? [];
      if (required.length === 0) return;
      expect(() => parseConfig(platform, {})).toThrow(
        `Missing required ${platform} configuration: ${required
          .map((requirement) =>
            typeof requirement === "string"
              ? requirement
              : requirement.join(" or "),
          )
          .join(", ")}`,
      );
    });

    // A blank key can never be satisfied, so the platform would be
    // permanently unconfigurable; an empty either-or group is the same trap.
    test("requiredConfigKeys declares no blank key or empty group", () => {
      for (const requirement of descriptor.requiredConfigKeys ?? []) {
        const keys =
          typeof requirement === "string" ? [requirement] : requirement;
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) expect(key.trim().length).toBeGreaterThan(0);
      }
    });
  });
});
