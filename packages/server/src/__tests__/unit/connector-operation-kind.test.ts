import { describe, expect, it } from "bun:test";
import { getLocalActionKind } from "../../operations/connector-operations";

describe("local connector operation classification", () => {
	it("honors explicit read kinds", () => {
		expect(getLocalActionKind({ kind: "read" })).toBe("read");
	});

	it("honors MCP-compatible readOnlyHint annotations", () => {
		expect(
			getLocalActionKind({ annotations: { readOnlyHint: true } }),
		).toBe("read");
	});

	it("fails closed to write when no semantic kind is declared", () => {
		expect(
			getLocalActionKind({
				annotations: { idempotentHint: true, destructiveHint: false },
			}),
		).toBe("write");
	});
});
