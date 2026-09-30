import { ManageClassifiersSchema } from "@lobu/core/contracts/tools/manage-classifiers";
import { describe, expect, it } from "vitest";
import { validateToolArgs } from "../../tools/validate-args";

const createArgs = {
	action: "create",
	slug: "sentiment",
	name: "Sentiment",
	attribute_key: "sentiment",
};

describe("manage_classifiers attribute_values validation", () => {
	it("rejects a string array instead of treating its indexes as classifier values", () => {
		expect(() =>
			validateToolArgs("manage_classifiers", ManageClassifiersSchema, {
				...createArgs,
				attribute_values: ["positive", "negative"],
			}),
		).toThrow(/Invalid arguments for manage_classifiers.*attribute_values/);
	});

	it.each([
		["an empty map", {}],
		["a missing description", { positive: { examples: ["great"] } }],
		[
			"a label vector (retired with the embedding engine)",
			{
				positive: {
					description: "Positive sentiment",
					examples: ["great"],
					embedding: [0.1, 0.2],
				},
			},
		],
		[
			"an unsupported nested field",
			{
				positive: {
					description: "Positive sentiment",
					examples: ["great"],
					ignored: true,
				},
			},
		],
	])("rejects %s before classifier creation", (_label, attributeValues) => {
		expect(() =>
			validateToolArgs("manage_classifiers", ManageClassifiersSchema, {
				...createArgs,
				attribute_values: attributeValues,
			}),
		).toThrow(/Invalid arguments for manage_classifiers.*attribute_values/);
	});

	it("accepts values that carry only a description (examples are optional context)", () => {
		expect(
			validateToolArgs("manage_classifiers", ManageClassifiersSchema, {
				...createArgs,
				attribute_values: { positive: { description: "Positive sentiment" } },
			}),
		).toBeTruthy();
	});

	it("accepts the structured attribute-value map consumed by classifier creation", () => {
		expect(
			validateToolArgs("manage_classifiers", ManageClassifiersSchema, {
				...createArgs,
				attribute_values: {
					positive: {
						description: "Positive sentiment",
						examples: ["great"],
					},
					negative: {
						description: "Negative sentiment",
						examples: ["bad"],
					},
				},
			}),
		).toMatchObject({
			attribute_values: {
				positive: { description: "Positive sentiment", examples: ["great"] },
				negative: { description: "Negative sentiment", examples: ["bad"] },
			},
		});
	});
});
