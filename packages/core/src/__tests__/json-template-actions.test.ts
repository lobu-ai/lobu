import { describe, expect, test } from "bun:test";
import {
  collectTemplateActionInvocations,
  isTemplateSdkInteractionDefinition,
  MAX_TEMPLATE_SDK_SCRIPT_LENGTH,
  templateInteractionValue,
} from "../json-template";

test("templateInteractionValue accepts only shared wire primitives", () => {
  expect([
    templateInteractionValue("yes"),
    templateInteractionValue(2),
    templateInteractionValue(false),
    templateInteractionValue(null),
    templateInteractionValue({ id: 1 }),
  ]).toEqual(["yes", "2", "false", null, null]);
});

describe("SDK interaction declarations", () => {
  test("requires an unambiguous bounded script and explicit access mode", () => {
    const sdk = {
      script: "export default async () => ({ total: 42 })",
      mode: "read",
    };
    expect(isTemplateSdkInteractionDefinition({ sdk })).toBe(true);
    for (const value of [
      { emits: "choice.recorded", sdk },
      { sdk: { ...sdk, script: " " } },
      {
        sdk: { ...sdk, script: "x".repeat(MAX_TEMPLATE_SDK_SCRIPT_LENGTH + 1) },
      },
      { sdk: { ...sdk, mode: "unknown" } },
      { sdk: { ...sdk, timeout_ms: 60_001 } },
      { sdk: { ...sdk, timeout_ms: 999 } },
      { sdk: { ...sdk, timeout_ms: 1500.5 } },
      Object.create({ sdk }),
    ])
      expect(isTemplateSdkInteractionDefinition(value)).toBe(false);
  });
});

describe("collectTemplateActionInvocations", () => {
  test("uses the same portable button aliases as every renderer", () => {
    expect(
      collectTemplateActionInvocations(
        {
          type: "card",
          children: [
            {
              type: "button",
              props: { onPress: "@approve", value: "yes" },
            },
            {
              type: "button",
              onSubmit: "@refresh",
            },
          ],
        },
        {}
      )
    ).toEqual([
      { action: "approve", value: "yes" },
      { action: "refresh", value: null },
    ]);
  });
});
