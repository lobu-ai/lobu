/**
 * A view module declaring `def`. A view's key, name, description, attach,
 * params and actions live only in its source, so tests vary them here.
 */
export function viewModule(
	def: Record<string, unknown>,
	body = "export default function V() { return null; }",
): string {
	return `import { defineView } from "@lobu/views";\nexport const view = defineView(${JSON.stringify(def)});\n${body}\n`;
}
