/**
 * Hardened tests for agent-policy.ts.
 *
 * The existing agent-policy.test.ts covers file delivery detection.
 * This file covers: renderBaselineAgentPolicy, renderAlwaysOnToolPolicyRulesFor,
 * getCustomToolDescription for unknown tools, always-on rule narrowing
 * (rule narrowing by offered tool, ordering, multiple
 * rule matches), and buildUnconfiguredAgentNotice.
 */

import { describe, expect, test } from "bun:test";
import {
  buildUnconfiguredAgentNotice,
  getCustomToolDescription,
  renderAlwaysOnToolPolicyRulesFor,
  renderBaselineAgentPolicy,
  TOOL_RULES,
} from "../agent-policy";
import { SUGGESTION_LIMITS } from "../suggestions";

// ── renderBaselineAgentPolicy ─────────────────────────────────────────────────

describe("renderBaselineAgentPolicy", () => {
  test("returns a non-empty string", () => {
    const output = renderBaselineAgentPolicy();
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  test("contains the Baseline Policy heading", () => {
    expect(renderBaselineAgentPolicy()).toContain("## Baseline Policy");
  });

  test("forbids fabricating tool outputs", () => {
    expect(renderBaselineAgentPolicy()).toMatch(/fabricat/i);
  });

  test("is deterministic across calls", () => {
    expect(renderBaselineAgentPolicy()).toBe(renderBaselineAgentPolicy());
  });
});

// ── renderAlwaysOnToolPolicyRulesFor ─────────────────────────────────────────

// Every always-on rule's tools, so these cases exercise the same rule set the
// deleted unfiltered renderer used to emit. The narrowing itself — a rule is
// dropped when the turn carries none of its tools — is asserted separately
// below, because that is the whole reason only the filtered renderer survives.
const ALL_ALWAYS_ON_TOOLS = TOOL_RULES.flatMap((r) => r.tools);

describe("renderAlwaysOnToolPolicyRulesFor", () => {
  test("returns a non-empty string because there are always-on rules", () => {
    // Confirm the assumption: there are rules to render at all.
    expect(TOOL_RULES.length).toBeGreaterThan(0);

    const output = renderAlwaysOnToolPolicyRulesFor(ALL_ALWAYS_ON_TOOLS);
    expect(output.length).toBeGreaterThan(0);
  });

  test("includes the Built-In Tool Policies heading", () => {
    expect(renderAlwaysOnToolPolicyRulesFor(ALL_ALWAYS_ON_TOOLS)).toContain(
      "## Built-In Tool Policies"
    );
  });

  test("includes ask_user rule (always-on)", () => {
    expect(renderAlwaysOnToolPolicyRulesFor(["ask_user"])).toContain(
      "ask_user"
    );
  });

  test("includes upload_file rule (always-on)", () => {
    expect(renderAlwaysOnToolPolicyRulesFor(["upload_file"])).toContain(
      "upload_file"
    );
  });

  test("ignores a tool no rule is about", () => {
    // An unknown tool neither adds a rule nor suppresses the real ones.
    expect(
      renderAlwaysOnToolPolicyRulesFor([
        ...ALL_ALWAYS_ON_TOOLS,
        "generate_image",
      ])
    ).toBe(renderAlwaysOnToolPolicyRulesFor(ALL_ALWAYS_ON_TOOLS));
  });

  test("is deterministic across calls", () => {
    expect(renderAlwaysOnToolPolicyRulesFor(ALL_ALWAYS_ON_TOOLS)).toBe(
      renderAlwaysOnToolPolicyRulesFor(ALL_ALWAYS_ON_TOOLS)
    );
  });

  test("drops a rule whose tools the turn does not carry", () => {
    // The reason the unfiltered renderer was retired: a turn without
    // `upload_file` must not be told to deliver files with it.
    const output = renderAlwaysOnToolPolicyRulesFor(["ask_user"]);
    expect(output).not.toContain("upload_file");
  });

  test("returns an empty string when the turn carries none of the tools", () => {
    expect(renderAlwaysOnToolPolicyRulesFor([])).toBe("");
  });
});

// ── getCustomToolDescription ──────────────────────────────────────────────────

describe("getCustomToolDescription", () => {
  test("returns the registered description for upload_file", () => {
    const desc = getCustomToolDescription("upload_file");
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).not.toBe("upload_file");
  });

  test("returns the registered description for generate_image", () => {
    const desc = getCustomToolDescription("generate_image");
    expect(desc.length).toBeGreaterThan(0);
    expect(desc).not.toBe("generate_image");
  });

  test("returns the registered description for generate_audio", () => {
    const desc = getCustomToolDescription("generate_audio");
    expect(desc).toContain("audio");
  });

  test("returns the registered description for ask_user", () => {
    const desc = getCustomToolDescription("ask_user");
    expect(desc.length).toBeGreaterThan(0);
  });

  test("describes when and how to use suggest_actions", () => {
    const desc = getCustomToolDescription("suggest_actions");
    expect(desc).toContain("follow-up");
    expect(desc).toContain("user's next turn");
  });

  test("makes suggest_actions optional and states its real delivery contract", () => {
    const desc = getCustomToolDescription("suggest_actions");
    expect(desc).toMatch(/optional/i);
    expect(desc).toMatch(/skip/i);
    expect(desc).toMatch(/at most once/i);
    // The card is posted at tool-call time, not attached to the terminal reply
    // (see the /internal/suggestions/create route), so the copy must not claim
    // the chips hang under the reply or that a reply without them is broken.
    expect(desc).toMatch(/immediately/i);
    expect(desc).not.toMatch(
      /always call|every reply|dead end|under your reply/i
    );
    // The ceiling in the copy is the one sanitizeSuggestionPrompts enforces —
    // above it, extra prompts are silently dropped.
    expect(desc).toContain(`${SUGGESTION_LIMITS.maxPrompts} is the ceiling`);
  });

  test("registers the event presentation and scoped follow-up tools", () => {
    expect(getCustomToolDescription("present_event")).toContain(
      "declared json_template"
    );
    expect(getCustomToolDescription("schedule_followup")).toContain(
      "current conversation"
    );
  });

  test("falls back to the tool name for unknown tools", () => {
    expect(getCustomToolDescription("UnknownTool")).toBe("UnknownTool");
  });

  test("falls back to tool name for empty string", () => {
    expect(getCustomToolDescription("")).toBe("");
  });
});

// ── buildUnconfiguredAgentNotice ──────────────────────────────────────────────

describe("buildUnconfiguredAgentNotice", () => {
  test("includes the Agent Configuration Notice heading", () => {
    expect(buildUnconfiguredAgentNotice()).toContain(
      "## Agent Configuration Notice"
    );
  });

  test("without settingsUrl: no link is included", () => {
    const out = buildUnconfiguredAgentNotice();
    expect(out).not.toContain("[Open Agent Settings]");
  });

  test("with settingsUrl: includes a markdown link", () => {
    const out = buildUnconfiguredAgentNotice(
      "https://app.lobu.ai/agents/triage/settings"
    );
    expect(out).toContain(
      "[Open Agent Settings](https://app.lobu.ai/agents/triage/settings)"
    );
  });

  test("instructs to behave as helpful assistant when unconfigured", () => {
    expect(buildUnconfiguredAgentNotice()).toMatch(/helpful.*assistant/i);
  });

  test("is deterministic", () => {
    const url = "https://example.com";
    expect(buildUnconfiguredAgentNotice(url)).toBe(
      buildUnconfiguredAgentNotice(url)
    );
  });
});

// ── TOOL_RULES structural invariants ───────────────────────────────────

describe("TOOL_RULES structural invariants", () => {
  test("every rule has a unique id", () => {
    const ids = TOOL_RULES.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test("every rule has a non-empty title", () => {
    for (const rule of TOOL_RULES) {
      expect(rule.title.length).toBeGreaterThan(0);
    }
  });

  test("every rule has at least one tool", () => {
    for (const rule of TOOL_RULES) {
      expect(rule.tools.length).toBeGreaterThan(0);
    }
  });

  test("every rule has a positive numeric priority", () => {
    for (const rule of TOOL_RULES) {
      expect(rule.priority).toBeGreaterThan(0);
    }
  });

  test("every rule has at least one instruction line", () => {
    // A rule with no lines would render a heading and tell the model nothing.
    for (const rule of TOOL_RULES) {
      expect(rule.instructionLines.length).toBeGreaterThan(0);
    }
  });
});
