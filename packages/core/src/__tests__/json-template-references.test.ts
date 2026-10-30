import { describe, expect, test } from "bun:test";
import { parseNativeReference } from "../json-template-references";

describe("native identity selectors", () => {
  test("accepts the server's maximum safe numeric identity", () => {
    expect(
      parseNativeReference("automation-ref", {
        mode: "live",
        workspace: "demo",
        automationId: String(Number.MAX_SAFE_INTEGER),
      })
    ).not.toBeNull();
  });

  test("copies selectors, never authored live labels, links, status or handlers", () => {
    expect(
      parseNativeReference("automation-ref", {
        mode: "live",
        workspace: "demo",
        automationId: "42",
        label: "Invented trusted title",
        href: "https://example.test",
        status: "active",
        onClick: "@delete",
      })
    ).toEqual({
      mode: "live",
      workspace: "demo",
      automationId: "42",
      appearance: "row",
    });
  });
  test("snapshots carry display text only, never an executable identity", () => {
    expect(
      parseNativeReference("agent-ref", {
        mode: "snapshot",
        label: "Proposed helper",
        workspace: "demo",
        agentId: "real-agent",
        href: "/demo/agents/real-agent",
        onClick: "@update",
      })
    ).toEqual({ mode: "snapshot", label: "Proposed helper" });
  });
  test.each([
    "../other",
    "demo/other",
    "demo?x=1",
    "",
    "x".repeat(129),
  ])("rejects unsafe or out-of-bounds workspace %s", (workspace) => {
    expect(
      parseNativeReference("automation-ref", {
        mode: "live",
        workspace,
        automationId: "42",
      })
    ).toBeNull();
  });
  test.each([
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "1",
  ])("rejects invalid connection identity %s", (connectionId) => {
    expect(
      parseNativeReference("connector-ref", {
        mode: "live",
        workspace: "demo",
        connectorKey: "mail",
        connectionId,
      })
    ).toBeNull();
  });
  test.each([
    "",
    "0",
    "-1",
    "one",
    String(Number.MAX_SAFE_INTEGER + 1),
    "9".repeat(128),
    " 42",
    "x".repeat(129),
  ])("rejects noncanonical Automation id %s", (automationId) => {
    expect(
      parseNativeReference("automation-ref", {
        mode: "live",
        workspace: "demo",
        automationId,
      })
    ).toBeNull();
  });
});
