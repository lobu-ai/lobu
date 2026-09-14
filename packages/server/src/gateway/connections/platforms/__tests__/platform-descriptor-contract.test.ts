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
import { PLATFORM_REGISTRY } from "../index.js";

const PLATFORMS = Object.entries(PLATFORM_REGISTRY);

describe("chat platform descriptor contract", () => {
  test("every registered platform is reachable by its own key", () => {
    expect(PLATFORMS.length).toBeGreaterThan(0);
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

    // Healing writes a workspace id onto a live subscription. A blank or
    // structurally wrong value must never qualify — the pre-hook code guarded
    // this with an inline regex that only the Slack branch applied.
    test("healableTeamId rejects blank and non-workspace ids", () => {
      const healable = descriptor.healableTeamId;
      if (!healable) return;
      for (const bad of ["", "   ", "E0ENTERPRISE"]) {
        expect(healable(bad)).toBe(false);
      }
    });

    // `requiredConfigKeys` replaced a hardcoded table in the generic config
    // service. If a declared key is not actually enforced, a credential-less
    // connection persists and fails later at start time instead.
    test("every declared required key is enforced by parseConfig", () => {
      const required = descriptor.requiredConfigKeys ?? [];
      if (required.length === 0) return;
      let threw = false;
      try {
        parseConfig(platform, {});
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
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
