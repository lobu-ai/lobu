/**
 * Hardened tests for agent-policy.ts.
 *
 * The existing agent-policy.test.ts covers file delivery detection.
 * This file covers: renderBaselineAgentPolicy, renderAlwaysOnToolPolicyRulesFor,
 * getCustomToolDescription for unknown tools, detectToolIntentRules edge cases
 * (empty prompt, whitespace-only, alwaysInclude exclusion, ordering, multiple
 * rule matches), and buildUnconfiguredAgentNotice.
 */

import { describe, expect, test } from "bun:test";
import {
  buildUnconfiguredAgentNotice,
  detectToolIntentRules,
  getCustomToolDescription,
  renderAlwaysOnToolPolicyRulesFor,
  renderBaselineAgentPolicy,
  renderDetectedToolIntentRules,
  TOOL_INTENT_RULES,
} from "../agent-policy";

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
const ALL_ALWAYS_ON_TOOLS = TOOL_INTENT_RULES.filter(
  (r) => r.alwaysInclude
).flatMap((r) => r.tools);

describe("renderAlwaysOnToolPolicyRulesFor", () => {
  test("returns a non-empty string because there are alwaysInclude rules", () => {
    const alwaysOnCount = TOOL_INTENT_RULES.filter(
      (r) => r.alwaysInclude
    ).length;
    // Confirm the assumption: there are always-on rules
    expect(alwaysOnCount).toBeGreaterThan(0);

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

  test("does NOT include image-generation rule (not alwaysInclude)", () => {
    // image-generation has no alwaysInclude flag, so offering its tool is
    // still not enough to emit it here.
    const output = renderAlwaysOnToolPolicyRulesFor([
      ...ALL_ALWAYS_ON_TOOLS,
      "generate_image",
    ]);
    expect(output).not.toContain("Image Generation");
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

// ── detectToolIntentRules ─────────────────────────────────────────────────────

describe("detectToolIntentRules", () => {
  test("returns empty array for empty prompt", () => {
    expect(detectToolIntentRules("")).toEqual([]);
  });

  test("returns empty array for whitespace-only prompt", () => {
    expect(detectToolIntentRules("   \t\n   ")).toEqual([]);
  });

  test("returns empty array for a generic unrelated prompt", () => {
    const rules = detectToolIntentRules("What is 2 + 2?");
    expect(rules).toEqual([]);
  });

  test("does NOT return alwaysInclude rules (they go via renderAlwaysOnToolPolicyRulesFor)", () => {
    // A prompt that definitely matches patterns should not include alwaysInclude rules
    const rules = detectToolIntentRules(
      "send me the file as an attachment please"
    );
    for (const rule of rules) {
      expect(rule.alwaysInclude).not.toBe(true);
    }
  });

  test("detects image generation request", () => {
    const rules = detectToolIntentRules("generate an image of a sunset");
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("image-generation");
  });

  test("detects download file request", () => {
    const rules = detectToolIntentRules(
      "save this as a PDF file and give it to me"
    );
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("file-delivery");
  });

  test("returns rules sorted by ascending priority", () => {
    // Trigger both file-delivery (priority 30) and image-generation (priority 70)
    const rules = detectToolIntentRules(
      "generate an image and export it as a file for download"
    );
    const priorities = rules.map((r) => r.priority);
    // Should be in ascending order
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]!).toBeGreaterThanOrEqual(priorities[i - 1]!);
    }
  });

  test("file delivery pattern: noun-verb order", () => {
    const rules = detectToolIntentRules(
      "the CSV file, please share it with me"
    );
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("file-delivery");
  });

  test("image generation pattern: verb-noun order", () => {
    const rules = detectToolIntentRules("design a logo for my company");
    const ids = rules.map((r) => r.id);
    expect(ids).toContain("image-generation");
  });

  test("does not include conversation-history rule from detectToolIntentRules (alwaysInclude=true)", () => {
    const rules = detectToolIntentRules("what did we talk about earlier?");
    for (const rule of rules) {
      expect(rule.id).not.toBe("conversation-history");
    }
  });
});

// ── renderDetectedToolIntentRules ─────────────────────────────────────────────

describe("renderDetectedToolIntentRules", () => {
  test("returns empty string for unrelated prompt", () => {
    expect(renderDetectedToolIntentRules("hello there")).toBe("");
  });

  test("returns empty string for empty prompt", () => {
    expect(renderDetectedToolIntentRules("")).toBe("");
  });

  test("includes Priority Tool Guidance heading when rules detected", () => {
    const out = renderDetectedToolIntentRules(
      "generate an image of a mountain"
    );
    expect(out).toContain("## Priority Tool Guidance For This Request");
  });

  test("includes tool name in output", () => {
    const out = renderDetectedToolIntentRules(
      "generate an image of a mountain"
    );
    expect(out).toContain("generate_image");
  });

  test("is deterministic for same input", () => {
    const prompt = "send me the report as a PDF";
    expect(renderDetectedToolIntentRules(prompt)).toBe(
      renderDetectedToolIntentRules(prompt)
    );
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

// ── TOOL_INTENT_RULES structural invariants ───────────────────────────────────

describe("TOOL_INTENT_RULES structural invariants", () => {
  test("every rule has a unique id", () => {
    const ids = TOOL_INTENT_RULES.map((r) => r.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  test("every rule has a non-empty title", () => {
    for (const rule of TOOL_INTENT_RULES) {
      expect(rule.title.length).toBeGreaterThan(0);
    }
  });

  test("every rule has at least one tool", () => {
    for (const rule of TOOL_INTENT_RULES) {
      expect(rule.tools.length).toBeGreaterThan(0);
    }
  });

  test("every rule has a positive numeric priority", () => {
    for (const rule of TOOL_INTENT_RULES) {
      expect(rule.priority).toBeGreaterThan(0);
    }
  });

  test("non-alwaysInclude rules have at least one pattern", () => {
    for (const rule of TOOL_INTENT_RULES) {
      if (!rule.alwaysInclude) {
        expect(rule.patterns.length).toBeGreaterThan(0);
      }
    }
  });
});
