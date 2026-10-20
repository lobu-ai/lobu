import { describe, expect, test } from "bun:test";
import { sanitizeSuggestionPrompts, SUGGESTION_LIMITS } from "../types";
import { parseFollowUpSuggestions } from "../suggestions";

describe("sanitizeSuggestionPrompts", () => {
  test("drops malformed entries, trims, and deduplicates valid prompts", () => {
    expect(
      sanitizeSuggestionPrompts([
        null,
        "plain text",
        { title: " ", message: "empty title" },
        { title: "Missing message" },
        { title: "  Ship  ", message: "  Ship it  " },
        { title: "Ship", message: "Ship it" },
      ])
    ).toEqual([{ title: "Ship", message: "Ship it" }]);
    expect(sanitizeSuggestionPrompts({ prompts: [] })).toEqual([]);
  });

  test("caps the number and length of prompts without splitting surrogate pairs", () => {
    const emojiTitle = "😀".repeat(SUGGESTION_LIMITS.maxTitleChars + 1);
    const prompts = Array.from(
      { length: SUGGESTION_LIMITS.maxPrompts + 1 },
      (_, index) => ({
        title: index === 0 ? emojiTitle : `Title ${index}`,
        message: "x".repeat(SUGGESTION_LIMITS.maxMessageChars + 1),
      })
    );

    const result = sanitizeSuggestionPrompts(prompts);
    expect(result).toHaveLength(SUGGESTION_LIMITS.maxPrompts);
    // UTF-16 units, not code points — that is what Slack's cap measures. A
    // code-point cap would let these 72 emoji through as 144 units.
    expect(result[0]!.title.length).toBeLessThanOrEqual(
      SUGGESTION_LIMITS.maxTitleChars
    );
    // …and it must still fill the budget rather than over-trim.
    expect(result[0]!.title.length).toBeGreaterThan(
      SUGGESTION_LIMITS.maxTitleChars - 2
    );
    expect(result[0]!.title.endsWith("😀")).toBe(true);
    expect(result[0]!.message).toHaveLength(SUGGESTION_LIMITS.maxMessageChars);
  });
});

describe("parseFollowUpSuggestions", () => {
  test("reads the chips object, with or without a fence or surrounding prose", () => {
    const chips = {
      prompts: [
        { title: "Fix LinkedIn", message: "Reconnect my LinkedIn feed" },
      ],
    };
    expect(parseFollowUpSuggestions(JSON.stringify(chips))).toEqual(
      chips.prompts
    );
    expect(
      parseFollowUpSuggestions(`\`\`\`json\n${JSON.stringify(chips)}\n\`\`\``)
    ).toEqual(chips.prompts);
    expect(
      parseFollowUpSuggestions(`Here you go: ${JSON.stringify(chips)}`)
    ).toEqual(chips.prompts);
  });

  test("an empty set, prose, malformed JSON, or a wrong shape is no chips", () => {
    expect(parseFollowUpSuggestions('{"prompts":[]}')).toEqual([]);
    expect(parseFollowUpSuggestions("No suggestions needed.")).toEqual([]);
    expect(parseFollowUpSuggestions('{"prompts":[{"title":"A"')).toEqual([]);
    expect(parseFollowUpSuggestions('{"prompts":"Show me"}')).toEqual([]);
    expect(parseFollowUpSuggestions("")).toEqual([]);
  });

  test("applies the shared sanitizer to what the model returned", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      title: `T${i}`,
      message: `M${i}`,
    }));
    expect(
      parseFollowUpSuggestions(JSON.stringify({ prompts: many }))
    ).toHaveLength(SUGGESTION_LIMITS.maxPrompts);
  });
});
