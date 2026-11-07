import { describe, expect, it } from "bun:test";
import {
  ActionDefinitionSchema,
  ManageActionsSchema,
  isActionFieldName,
  type ActionDefinition,
} from "@lobu/core/contracts/tools/manage-actions";
import { Value } from "@sinclair/typebox/value";
import { assertActionJson, validateActionParams } from "../../actions/registry";
import { getRequiredAccessLevel, isPublicReadable } from "../../auth/tool-access";
import { validateToolArgs } from "../../tools/validate-args";

function definition(): ActionDefinition {
  return {
    params: {
      type: "object",
      properties: { record_id: { type: "integer", minimum: 1 }, stage: { type: "string", enum: ["open", "done"] } },
      required: ["record_id", "stage"],
      additionalProperties: false,
    },
    target: { entityType: "test_record", idParam: "record_id" },
    invokePermission: "write",
    set: { stage: { param: "stage" }, changed_at: { server: "timestamp" }, change_event_id: { event: "id" } },
    emits: { kind: "test_record.stage_set", schemaVersion: 1, payload: { record_id: { param: "record_id" }, stage: { param: "stage" } } },
  };
}

describe("typed action contract", () => {
  it("preserves literal strings through the existing tool argument converter", () => {
    const original = definition();
    original.set.label = { literal: "true" };
    original.set.code = { literal: "42" };
    const parsed = validateToolArgs("manage_actions", ManageActionsSchema, {
      action: "publish", key: "test_record.stage_set", definition: original,
    });
    expect(parsed).toMatchObject({ definition: { set: { label: { literal: "true" }, code: { literal: "42" } } } });
  });

  it("does not coerce runtime params or remove unknown params", () => {
    const parsed = validateToolArgs("manage_actions", ManageActionsSchema, {
      action: "apply", key: "test_record.stage_set", version: 1,
      params: { record_id: "7", stage: "done" }, idempotency_key: "test-interaction",
    }) as { params: Record<string, unknown> };
    expect(parsed.params.record_id).toBe("7");
    expect(() => validateActionParams(definition(), parsed.params)).toThrow();
    expect(() => validateActionParams(definition(), { record_id: 7, stage: "done", hidden: true })).toThrow();
    expect(() => validateActionParams(definition(), { record_id: 7, stage: "done" })).not.toThrow();
  });

  it("rejects ambiguous bindings and the emitted event referencing itself", () => {
    const ambiguous = definition();
    ambiguous.set.stage = { param: "stage", literal: "done" } as typeof ambiguous.set.stage;
    expect(Value.Check(ActionDefinitionSchema, ambiguous)).toBe(false);
    const selfReference = definition();
    Object.assign(selfReference.emits.payload, { event_id: { event: "id" } });
    expect(Value.Check(ActionDefinitionSchema, selfReference)).toBe(false);
  });

  it("rejects unknown capabilities and definition fields", () => {
    expect(Value.Check(ActionDefinitionSchema, { ...definition(), invokePermission: "owner" })).toBe(false);
    expect(Value.Check(ActionDefinitionSchema, { ...definition(), function: "return true" })).toBe(false);
  });

  it("bounds non-JSON, cyclic and deeply nested requests before validation", () => {
    expect(() => assertActionJson({ invalid: Number.NaN }, "test")).toThrow();
    expect(() => assertActionJson({ invalid: () => null }, "test")).toThrow();
    expect(() => assertActionJson({ text: "x".repeat(65_536) }, "test")).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.child = cyclic;
    expect(() => assertActionJson(cyclic, "test")).toThrow();
    let nested: unknown = null;
    for (let i = 0; i < 18; i++) nested = { child: nested };
    expect(() => assertActionJson(nested, "test")).toThrow();
  });

  it("keeps metadata names and invocation authority narrow", () => {
    for (const name of ["$owner", "__proto__", "prototype", "constructor", "name", "content", "slug", "parent_id"]) {
      expect(isActionFieldName(name)).toBe(false);
    }
    expect(isActionFieldName("stage_event_id")).toBe(true);
    for (const action of ["publish", "set_enabled"]) {
      expect(getRequiredAccessLevel("manage_actions", { action }, false)).toBe("admin");
    }
    for (const action of ["apply", "validate"]) {
      expect(getRequiredAccessLevel("manage_actions", { action }, false)).toBe("write");
    }
    for (const action of ["list", "get"]) {
      expect(getRequiredAccessLevel("manage_actions", { action }, false)).toBe("read");
      expect(isPublicReadable("manage_actions", { action })).toBe(false);
    }
  });

  it("rejects unsupported async or reference schemas", () => {
    const asyncDefinition = definition();
    asyncDefinition.params.$async = true;
    expect(() => validateActionParams(asyncDefinition, { record_id: 1, stage: "done" })).toThrow();
    const referenced = definition();
    referenced.params.$ref = "#";
    expect(() => validateActionParams(referenced, { record_id: 1, stage: "done" })).toThrow();
  });
});
