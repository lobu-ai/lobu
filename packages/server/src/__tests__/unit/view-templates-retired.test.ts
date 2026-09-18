/**
 * PR4 retirement guard: the view-template path owns nothing queryable.
 *
 * The template tables are deleted (PR1 migration), `manage_view_templates` is
 * retired (PR1), and the owletto mounts are gone (PR3). This suite trips if
 * any registered tool reintroduces the old vocabulary — it enumerates every
 * tool in the registry rather than naming one file, so a re-added tool under
 * any name with the old table in its description fails here.
 */
import { describe, expect, it } from "bun:test";
import { getAllTools, getTool } from "../../tools/registry";

describe("view-template retirement", () => {
	it("serves manage_views and no manage_view_templates", () => {
		expect(getTool("manage_views")).toBeDefined();
		expect(getTool("manage_view_templates")).toBeUndefined();
	});

	it("exposes no view_template vocabulary on any registered tool", () => {
		const hits: string[] = [];
		for (const tool of getAllTools()) {
			const haystack = `${tool.name} ${tool.description ?? ""}`;
			if (/view_template/i.test(haystack)) hits.push(tool.name);
		}
		expect(hits).toEqual([]);
	});
});
