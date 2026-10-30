import { describe, expect, test } from "bun:test";
import { createAjv, formatAjvError } from "../utils/ajv";

function firstError(schema: object, input: unknown): string {
  const validate = createAjv({ allErrors: false, strict: false }).compile(
    schema
  );
  expect(validate(input)).toBe(false);
  const error = validate.errors?.[0];
  if (!error) throw new Error("expected a validation error");
  return formatAjvError(error);
}

describe("formatAjvError", () => {
  const schema = {
    type: "object",
    required: ["ref"],
    properties: {
      ref: {
        type: "object",
        required: ["backend_node_id"],
        properties: { backend_node_id: { type: "integer" } },
      },
    },
  };

  test("a missing top-level field is named on its own", () => {
    expect(firstError(schema, {})).toBe("missing required field: ref");
  });

  test("a missing nested field carries its parent path", () => {
    expect(firstError(schema, { ref: {} })).toBe(
      "missing required field: ref/backend_node_id"
    );
  });
});
