/**
 * Structural validation for a json_template (the JSON-UI DSL authored via
 * manage_entity_schema event kinds / the config `viewTemplate`).
 *
 * WHY server-side: storage is opaque JSONB, so without this a malformed template
 * saves fine and fails silently at render (in the browser). This validates the
 * invariants that actually cause silent breakage — node shape, required fields
 * per node type, handler bindings, and the `format` enum on data bindings — so
 * authoring fails FAST with a path-qualified error.
 *
 * WHAT IT DOESN'T DO (on purpose): it does NOT allowlist component `type`
 * strings. The renderer's component set is extended app-side (entity-board,
 * entity-table, charts, …) which the server can't know; the renderer already
 * degrades gracefully on a truly-unknown component. Validating structure, not
 * the component vocabulary, is the line that avoids coupling the server to
 * owletto while still catching the mistakes that matter.
 *
 * Mirrors owletto's `jsonTemplateSchema` node shape (json-renderer/types.ts) —
 * keep the node kinds in sync if the DSL grows. The `format` directives are
 * shared with the renderers via `@lobu/core/json-template`.
 */

import {
	isValueFormat,
	STRUCTURAL_NODE_TYPES,
	VALUE_FORMATS,
} from "@lobu/core/json-template";

class TemplateValidationError extends Error {}

function fail(path: string, message: string): never {
	throw new TemplateValidationError(`json_template${path}: ${message}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateHandlerProps(
	props: Record<string, unknown>,
	path: string,
	shadowedKeys?: Set<string>,
): void {
	for (const [key, value] of Object.entries(props)) {
		if (shadowedKeys?.has(key) || !/^on[A-Z]/.test(key)) continue;
		if (typeof value !== "string" || !value.startsWith("@") || value.length === 1) {
			fail(
				`${path}.${key}`,
				`handler props must bind an action as "@actionName" (got ${
					typeof value === "string" ? `"${value}"` : typeof value
				})`,
			);
		}
	}
}

function validateComponentHandlers(
	node: Record<string, unknown>,
	path: string,
): void {
	// The renderer accepts both flat props and an explicit `props` bag.
	const explicitProps = isPlainObject(node.props) ? node.props : undefined;
	validateHandlerProps(
		node,
		path,
		explicitProps ? new Set(Object.keys(explicitProps)) : undefined,
	);
	if (explicitProps) validateHandlerProps(explicitProps, `${path}.props`);
}

function validateNode(
	node: unknown,
	path: string,
	portableActions: Set<string>,
): void {
	if (!isPlainObject(node)) {
		fail(path, "each node must be an object");
	}
	const type = node.type;
	if (typeof type !== "string" || !type) {
		fail(path, "node is missing a string `type`");
	}

	// The structural set is shared with the renderers (`STRUCTURAL_NODE_TYPES`)
	// so the two cannot disagree about which types the DSL owns; the handling
	// below is deliberately its own, because validation fails on a malformed
	// node where rendering skips it.
	switch (type as (typeof STRUCTURAL_NODE_TYPES)[number]) {
		case "text": {
			if (typeof node.content !== "string") {
				fail(path, "a text node requires a string `content`");
			}
			return;
		}
		case "data": {
			if (typeof node.path !== "string" || !node.path) {
				fail(path, "a data node requires a non-empty string `path`");
			}
			if (
				node.format !== undefined &&
				!isValueFormat(node.format)
			) {
				fail(
					`${path}.format`,
					`unknown format "${String(node.format)}" — expected one of ${[...VALUE_FORMATS].join(", ")}`,
				);
			}
			return;
		}
		case "if": {
			if (typeof node.condition !== "string" || !node.condition) {
				fail(path, "an if node requires a string `condition`");
			}
			if (node.then === undefined) {
				fail(path, "an if node requires a `then` branch");
			}
			validateNode(node.then, `${path}.then`, portableActions);
			if (node.else !== undefined) {
				validateNode(node.else, `${path}.else`, portableActions);
			}
			return;
		}
		case "each": {
			if (typeof node.items !== "string" || !node.items) {
				fail(path, "an each node requires a string `items`");
			}
			if (typeof node.as !== "string" || !node.as) {
				fail(path, "an each node requires a string `as`");
			}
			// render may be a node or a string shorthand ("- {{var}}").
			if (typeof node.render === "string") return;
			if (node.render === undefined) {
				fail(path, "an each node requires a `render` (node or string)");
			}
			validateNode(node.render, `${path}.render`, portableActions);
			return;
		}
		default: {
			// Component node — permissive on `type` (app registry extends it), but
			// props/children must still be well-shaped so the renderer can walk them.
			if (node.props !== undefined && !isPlainObject(node.props)) {
				fail(`${path}.props`, "props must be an object");
			}
			validateComponentHandlers(node, path);
			const action = portableActionName(node);
			if (action) portableActions.add(action);
			if (node.children !== undefined) {
				if (!Array.isArray(node.children)) {
					fail(`${path}.children`, "children must be an array of nodes");
				}
				node.children.forEach((child, i) => {
					validateNode(child, `${path}.children[${i}]`, portableActions);
				});
			}
			return;
		}
	}
}

/**
 * Validate a json_template for STORAGE. It must be a bare root node (the storage
 * convention — a single node, optionally with a sibling `data_sources` key), NOT
 * a `{ version, root }` wrapper: consumers re-wrap the stored template as
 * `{ version: 1, root: json_template }` (owletto's buildEntityViews), so storing
 * a wrapper would double-nest it and render nothing. `data_sources` is validated
 * separately by the caller. Throws a path-qualified Error on the first problem.
 */
export function validateJsonTemplate(template: unknown): Set<string> {
	if (!isPlainObject(template)) {
		fail("", "must be an object");
	}
	// Reject a { version, root } wrapper outright — a common authoring mistake
	// that stores fine but double-wraps at render. Store the bare root node.
	if ("root" in template && !("type" in template)) {
		fail(
			"",
			"expected a bare root node, not a { version, root } wrapper — store `template.root` directly (consumers add the version wrapper)",
		);
	}
	const portableActions = new Set<string>();
	validateNode(template, "", portableActions);
	return portableActions;
}

function portableActionName(node: Record<string, unknown>): string | null {
	const props = isPlainObject(node.props) ? node.props : {};
	const handler =
		node.type === "button"
			? props.onClick ??
				node.onClick ??
				props.onPress ??
				node.onPress ??
				props.onSubmit ??
				node.onSubmit
			: node.type === "select"
				? props.onChange ?? node.onChange ?? props.onSelect ?? node.onSelect
				: null;
	return typeof handler === "string" && handler.startsWith("@")
		? handler.slice(1)
		: null;
}

/** Validate handler bindings without imposing a storage shape on the template. */
export function validateTemplateHandlers(template: unknown): void {
	if (!isPlainObject(template)) return;
	if ("type" in template) {
		walkHandlers(template, "");
	} else if (isPlainObject(template.root)) {
		walkHandlers(template.root, ".root");
	}
}

function walkHandlers(node: unknown, path: string): void {
	if (!isPlainObject(node)) return;
	if (node.type === "if") {
		walkHandlers(node.then, `${path}.then`);
		if (node.else !== undefined) walkHandlers(node.else, `${path}.else`);
		return;
	}
	if (node.type === "each") {
		if (typeof node.render !== "string") {
			walkHandlers(node.render, `${path}.render`);
		}
		return;
	}
	if (node.type === "text" || node.type === "data") return;

	validateComponentHandlers(node, path);
	if (Array.isArray(node.children)) {
		node.children.forEach((child, i) => {
			walkHandlers(child, `${path}.children[${i}]`);
		});
	}
}
