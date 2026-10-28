/**
 * Tenant separation for worker deployment identity.
 *
 * `generateDeploymentName` is the shared key both the dispatcher and the
 * liveness probe derive from the same inputs; two conversations, platforms,
 * agents or organizations must never collapse onto one deployment.
 */

import { describe, expect, test } from "bun:test";
import {
  buildCanonicalConversationKey,
  generateDeploymentName,
} from "../orchestration/deployment-manager.js";

describe("generateDeploymentName / buildCanonicalConversationKey", () => {
  test("same identity always produces the same deployment name", () => {
    const identity = {
      userId: "u1",
      conversationId: "c1",
      channelId: "ch1",
      platform: "slack",
      agentId: "a1",
      organizationId: "org1",
    };
    const name1 = generateDeploymentName(identity);
    const name2 = generateDeploymentName(identity);
    expect(name1).toBe(name2);
  });

  test("different conversationIds produce different deployment names", () => {
    const base = {
      userId: "u1",
      channelId: "ch1",
      platform: "slack",
      agentId: "a1",
      organizationId: "org1",
    };
    const n1 = generateDeploymentName({ ...base, conversationId: "c1" });
    const n2 = generateDeploymentName({ ...base, conversationId: "c2" });
    expect(n1).not.toBe(n2);
  });

  test("different platforms produce different deployment names", () => {
    const base = {
      userId: "u1",
      channelId: "ch1",
      conversationId: "c1",
      agentId: "a1",
      organizationId: "org1",
    };
    const n1 = generateDeploymentName({ ...base, platform: "slack" });
    const n2 = generateDeploymentName({ ...base, platform: "telegram" });
    expect(n1).not.toBe(n2);
  });

  test("different agentIds in the same channel/thread produce different deployment names", () => {
    const base = {
      userId: "u1",
      channelId: "ch1",
      conversationId: "c1",
      platform: "slack",
      organizationId: "org1",
    };
    const n1 = generateDeploymentName({ ...base, agentId: "agent-a" });
    const n2 = generateDeploymentName({ ...base, agentId: "agent-b" });
    expect(n1).not.toBe(n2);
  });

  test("different organizationIds produce different deployment names", () => {
    const base = {
      userId: "u1",
      channelId: "ch1",
      conversationId: "c1",
      platform: "slack",
      agentId: "agent-a",
    };
    const n1 = generateDeploymentName({ ...base, organizationId: "org1" });
    const n2 = generateDeploymentName({ ...base, organizationId: "org2" });
    expect(n1).not.toBe(n2);
  });

  test("deployment name is filesystem-safe (no special chars)", () => {
    const name = generateDeploymentName({
      userId: "u1",
      conversationId: "c1",
      channelId: "ch1",
      platform: "slack",
      agentId: "a1",
      organizationId: "org1",
    });
    expect(/^[a-z0-9-]+$/.test(name)).toBe(true);
  });

  test("buildCanonicalConversationKey with platform+channelId", () => {
    const key = buildCanonicalConversationKey({
      conversationId: "conv",
      channelId: "ch",
      platform: "slack",
      agentId: "a1",
      organizationId: "org1",
    });
    expect(key).toBe("org1:a1:slack:ch:conv");
  });

  test("buildCanonicalConversationKey without platform falls back to channelId", () => {
    const key = buildCanonicalConversationKey({
      conversationId: "conv",
      channelId: "ch",
      agentId: "a1",
      organizationId: "org1",
    });
    expect(key).toBe("org1:a1:ch:conv");
  });

  test("buildCanonicalConversationKey without channelId falls back to conversationId", () => {
    const key = buildCanonicalConversationKey({
      conversationId: "conv",
      agentId: "a1",
      organizationId: "org1",
    });
    expect(key).toBe("org1:a1:conv");
  });
});
