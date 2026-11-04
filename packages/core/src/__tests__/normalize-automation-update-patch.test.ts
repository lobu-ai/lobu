import { describe, expect, it } from "vitest";
import {
  type ManageAutomationsArgs,
  normalizeAutomationUpdatePatch,
} from "../contracts/tools/manage-automations";

/**
 * The normalizer is the SINGLE SOURCE OF TRUTH for a manage_automations UPDATE's
 * stored write-normalization — the apply handler (handleUpdate SET clause) and
 * the config-approval review's `proposedAfter` both call it, so these coercions
 * are what "displayed == applied" rests on. Mirrors the SET-clause coercions in
 * server tools/admin/manage_automations/crud.ts handleUpdate.
 */
const update = (extra: Partial<ManageAutomationsArgs>): ManageAutomationsArgs =>
  ({ action: "update", automation_id: "1", ...extra }) as ManageAutomationsArgs;

describe("normalizeAutomationUpdatePatch", () => {
  it("only emits keys PRESENT in args (a PATCH — absent keys keep current)", () => {
    const triggers = [
      { kind: "schedule" as const, cron: "0 9 * * *", timezone: "UTC" },
    ];
    expect(normalizeAutomationUpdatePatch(update({ triggers }))).toEqual({
      triggers,
    });
  });

  it("tags falsy stores as [] (handler: args.tags || [])", () => {
    expect(
      normalizeAutomationUpdatePatch(update({ tags: null as never })).tags
    ).toEqual([]);
  });

  it("tags are trimmed, empties dropped, duplicates removed (matches toTextArrayParam)", () => {
    // The stored SQL array goes through the same normalizeAutomationTags, so the
    // review must show the SAME cleaned array — not the raw input.
    expect(
      normalizeAutomationUpdatePatch(
        update({ tags: ["  a  ", "a", "", "b", " b "] as never })
      ).tags
    ).toEqual(["a", "b"]);
  });

  it("execution_config null is PRESERVED (a real clear the write applies)", () => {
    // ?? undefined would serialize the key away and hide the clear from the
    // review; the write stores SQL null, so proposedAfter must keep null.
    const p = normalizeAutomationUpdatePatch(
      update({ execution_config: null as never })
    );
    expect("execution_config" in p).toBe(true);
    expect(p.execution_config).toBeNull();
  });

  it("delivery_target is patchable and null clears it", () => {
    const target = {
      connection_id: 541,
      channel_id: "slack:C0BQEB5JPU6",
    };
    const setPatch = normalizeAutomationUpdatePatch(
      update({ delivery_target: target } as never)
    );
    expect(setPatch).toMatchObject({ delivery_target: target });

    const clearPatch = normalizeAutomationUpdatePatch(
      update({ delivery_target: null } as never)
    );
    expect("delivery_target" in clearPatch).toBe(true);
    expect((clearPatch as Record<string, unknown>).delivery_target).toBeNull();
  });

  it("defaults a cleared cooldown to zero", () => {
    const p = normalizeAutomationUpdatePatch(
      update({
        min_cooldown_seconds: null as never,
      })
    );
    expect(p.min_cooldown_seconds).toBe(0);
  });

  it("non-empty values pass through unchanged", () => {
    const p = normalizeAutomationUpdatePatch(
      update({
        triggers: [
          {
            kind: "schedule",
            cron: "0 9 * * *",
            timezone: "Asia/Taipei",
          },
        ],
        tags: ["a"],
      })
    );
    expect(p).toMatchObject({
      triggers: [
        {
          kind: "schedule",
          cron: "0 9 * * *",
          timezone: "Asia/Taipei",
        },
      ],
      tags: ["a"],
    });
  });

  it("excludes version-owned + routing fields (name/prompt/automation_id/etc.)", () => {
    const p = normalizeAutomationUpdatePatch(
      update({
        name: "X",
        prompt: "Y",
        triggers: [{ kind: "schedule", cron: "0 9 * * *" }],
      } as never)
    );
    expect("name" in p).toBe(false);
    expect("prompt" in p).toBe(false);
    expect("automation_id" in p).toBe(false);
    expect("action" in p).toBe(false);
    expect(p.triggers).toEqual([{ kind: "schedule", cron: "0 9 * * *" }]);
  });
});
