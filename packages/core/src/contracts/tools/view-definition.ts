import { Value } from "@sinclair/typebox/value";
import { type Node, parse } from "acorn";
import {
  type ViewActionDecl,
  type ViewAttachment,
  type ViewDefinitionDecl,
  ViewDefinitionSchema,
  type ViewParamDecl,
} from "./manage-views";

/** A view's declaration with its defaults applied: what the server stores and
 *  what the CLI hashes, so both derive it from the same function. */
export interface ViewDefinitionRecord {
  key: string;
  name: string;
  description: string;
  attach: ViewAttachment[];
  params: Record<string, ViewParamDecl>;
  actions: Record<string, ViewActionDecl>;
}

const VIEWS_PACKAGE = "@lobu/views";

/**
 * Read `export const view = defineView({...})` out of a view module, without
 * running it. `js` is the module with TypeScript and JSX already stripped
 * (esbuild `transform`); the argument must be a plain literal (objects,
 * arrays, strings, numbers, booleans, null), so a declaration is data the
 * server can read safely from any author's source. Throws an Error whose
 * message names what to fix.
 */
export function readViewDefinition(js: string): ViewDefinitionRecord {
  let program: Node & { body: Node[] };
  try {
    program = parse(js, {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as Node & { body: Node[] };
  } catch (error) {
    throw new Error(`view module does not parse: ${(error as Error).message}`);
  }
  const callee = defineViewLocalName(program.body);
  const argument = callee ? viewExportArgument(program.body, callee) : null;
  if (!argument) {
    throw new Error(
      `the module must export const view = defineView({ key, attach, ... }) with defineView imported from "${VIEWS_PACKAGE}"`
    );
  }
  if (!hasDefaultExport(program.body)) {
    throw new Error("the module must have a default-export component");
  }
  const raw = literalValue(argument, "defineView");
  if (!Value.Check(ViewDefinitionSchema, raw)) {
    const first = Value.Errors(ViewDefinitionSchema, raw).First();
    const at = first?.path
      ? `defineView${first.path.split("/").join(".")}`
      : "defineView";
    // A union (an attach entry) names the shapes it accepts, not "Expected
    // union value".
    const schema = first?.schema as { anyOf?: unknown; description?: string };
    const message =
      schema?.anyOf && schema.description
        ? `Expected ${schema.description}`
        : (first?.message ?? "invalid view definition");
    throw new Error(`${at}: ${message}`);
  }
  const def = raw as ViewDefinitionDecl;
  return {
    key: def.key,
    name: def.name?.trim() ? def.name : def.key,
    description: def.description ?? "",
    attach: def.attach,
    params: def.params ?? {},
    actions: def.actions ?? {},
  };
}

type AnyNode = Node & Record<string, unknown>;

function defineViewLocalName(body: Node[]): string | null {
  for (const statement of body as AnyNode[]) {
    if (statement.type !== "ImportDeclaration") continue;
    if ((statement.source as AnyNode).value !== VIEWS_PACKAGE) continue;
    for (const spec of statement.specifiers as AnyNode[]) {
      if (spec.type !== "ImportSpecifier") continue;
      const imported = spec.imported as AnyNode;
      if (imported.name === "defineView" || imported.value === "defineView") {
        return (spec.local as AnyNode).name as string;
      }
    }
  }
  return null;
}

function hasDefaultExport(body: Node[]): boolean {
  return (body as AnyNode[]).some(
    (statement) =>
      statement.type === "ExportDefaultDeclaration" ||
      (statement.type === "ExportNamedDeclaration" &&
        ((statement.specifiers as AnyNode[]) ?? []).some(
          (spec) => (spec.exported as AnyNode).name === "default"
        ))
  );
}

function viewExportArgument(body: Node[], callee: string): AnyNode | null {
  for (const statement of body as AnyNode[]) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration as AnyNode | null;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations as AnyNode[]) {
      if ((declarator.id as AnyNode).name !== "view") continue;
      const init = declarator.init as AnyNode | null;
      const args = init?.arguments as AnyNode[] | undefined;
      if (
        init?.type === "CallExpression" &&
        (init.callee as AnyNode).type === "Identifier" &&
        (init.callee as AnyNode).name === callee &&
        args?.length === 1
      ) {
        return args[0] ?? null;
      }
    }
  }
  return null;
}

function literalValue(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (
          prop.type !== "Property" ||
          prop.kind !== "init" ||
          prop.computed ||
          prop.method ||
          prop.shorthand
        ) {
          throw notLiteral(path, "a spread, shorthand, method or computed key");
        }
        const keyNode = prop.key as AnyNode;
        const key =
          keyNode.type === "Identifier"
            ? (keyNode.name as string)
            : typeof keyNode.value === "string" ||
                typeof keyNode.value === "number"
              ? String(keyNode.value)
              : null;
        if (key === null || key === "__proto__") {
          throw notLiteral(path, "an unsupported key");
        }
        out[key] = literalValue(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element || element.type === "SpreadElement") {
          throw notLiteral(`${path}[${index}]`, "a hole or spread");
        }
        return literalValue(element, `${path}[${index}]`);
      });
    case "Literal":
      if (node.regex || node.bigint !== undefined) {
        throw notLiteral(path, "a regular expression or bigint");
      }
      return node.value;
    case "UnaryExpression": {
      const argument = node.argument as AnyNode;
      if (
        node.operator === "-" &&
        argument.type === "Literal" &&
        typeof argument.value === "number"
      ) {
        return -argument.value;
      }
      throw notLiteral(path, `the expression \`${node.operator}…\``);
    }
    case "TemplateLiteral":
      if ((node.expressions as AnyNode[]).length === 0) {
        return ((node.quasis as AnyNode[])[0]?.value as { cooked: string })
          .cooked;
      }
      throw notLiteral(path, "a template with ${…}");
    default:
      throw notLiteral(
        path,
        node.type === "Identifier"
          ? `the variable \`${node.name as string}\``
          : `a ${node.type}`
      );
  }
}

function notLiteral(path: string, found: string): Error {
  return new Error(
    `${path} must be written out as a literal (objects, arrays, strings, numbers, booleans, null); found ${found}`
  );
}
