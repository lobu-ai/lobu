#!/usr/bin/env bun
/**
 * Guard: keep "Automation" canonical across the live repository.
 *
 * The retired product and engine terms must not appear in live code,
 * documentation, tests, fixtures, paths, or generated inputs. Historical
 * migrations/changelog entries, generated third-party artifacts, and explicit
 * negative-test fixtures are the only exceptions.
 *
 * Semantic scans additionally cover the places where vocabulary can be
 * assembled indirectly:
 *
 *   - MCP tool schemas, names, descriptions, or titles
 *   - ClientSDK discovery metadata, aliases, or namespace method names
 *   - the connector-sdk public reaction contract
 *   - server and web-client response types for shared public tool payloads
 *   - query_sql's queryable-relation allowlist (QUERYABLE_SCHEMA table names),
 *     which the unknown-table error enumerates verbatim to the caller
 *
 * TypeBox schema initializers and referenced namespace types are scanned under
 * the core tool contracts and server tool/type sources. The repository-wide
 * pass includes tracked and untracked live files in both the parent repository
 * and Owletto, while skipping binary content and build output ignored by Git.
 *
 * Run: bun scripts/check-exposed-surface-naming.ts
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = /watcher|behaviou?r/i;
const BANNED_SNAKE_KEY = /^[a-z0-9_]*(?:watcher|behaviou?r)[a-z0-9_]*$/;
const RETIRED_CANONICAL_VOCABULARY = /watcher|behaviou?r/i;

type Violation = { file: string; line: number; excerpt: string };

function rel(abs: string): string {
  return relative(REPO_ROOT, abs);
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules" || name === "dist") {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
}

function addViolation(
  violations: Violation[],
  file: string,
  source: ts.SourceFile,
  node: ts.Node
): void {
  const start = node.getStart(source);
  const { line } = source.getLineAndCharacterOfPosition(start);
  const text = source.text.split("\n")[line]?.trim() ?? "";
  violations.push({
    file: rel(file),
    line: line + 1,
    excerpt: text.slice(0, 120),
  });
}

function isTemplateText(node: ts.Node): node is ts.TemplateLiteralLikeNode {
  return (
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
  );
}

function propertyName(node: ts.Node): ts.PropertyName | undefined {
  if (
    ts.isPropertyAssignment(node) ||
    ts.isPropertySignature(node) ||
    ts.isMethodSignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.name;
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

/** Scan exposed literals and context-appropriate property names, excluding comments. */
function scanSyntaxNode(
  file: string,
  source: ts.SourceFile,
  root: ts.Node,
  violations: Violation[],
  allPropertyNamesAreExposed = false
): void {
  function visit(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) || isTemplateText(node)) &&
      BANNED.test(node.text)
    ) {
      addViolation(violations, file, source, node);
    }

    const name = propertyName(node);
    const text = name && propertyNameText(name);
    if (
      text &&
      (allPropertyNamesAreExposed
        ? BANNED.test(text)
        : BANNED_SNAKE_KEY.test(text))
    ) {
      addViolation(violations, file, source, name);
    }

    ts.forEachChild(node, visit);
  }

  visit(root);
}

function scanExposedSyntax(file: string, violations: Violation[]): void {
  const source = parse(file);
  scanSyntaxNode(file, source, source, violations);
}

function containsTypeBoxCall(root: ts.Node): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Type"
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(root);
  return found;
}

/** Scan top-level declarations that construct TypeBox schemas, not handlers/SQL. */
function scanTypeBoxSchemas(file: string, violations: Violation[]): void {
  const source = parse(file);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (initializer && containsTypeBoxCall(initializer)) {
        scanSyntaxNode(file, source, initializer, violations, true);
      }
    }
  }
}

/**
 * Workspace packages whose types are part of the agent-facing surface. A
 * namespace signature reaches into these directly — `listCatalog(input?:
 * CatalogListInput)` imports `CatalogListInput` from `@lobu/core/...` — so
 * treating "not relative" as "not ours" would skip a live wire contract.
 * Third-party packages stay out of scope: node_modules is not our surface to
 * police.
 */
const WORKSPACE_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["@lobu/core/", join(REPO_ROOT, "packages/core/src/")],
  ["@lobu/connector-sdk/", join(REPO_ROOT, "packages/connector-sdk/src/")],
  ["@lobu/plugin-api/", join(REPO_ROOT, "packages/plugin-api/src/")],
];

/** Resolve an import specifier to a source file, relative or workspace-aliased. */
function resolveImport(
  fromFile: string,
  specifier: string
): string | undefined {
  let base: string | undefined;
  if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier);
  } else {
    for (const [prefix, root] of WORKSPACE_ALIASES) {
      if (specifier.startsWith(prefix)) {
        base = join(root, specifier.slice(prefix.length));
        break;
      }
    }
  }
  if (!base) return undefined;
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this candidate; try the next.
    }
  }
  return undefined;
}

/**
 * Map every locally-imported type name to the file that defines it AND the name
 * it is declared under there.
 *
 * The distinction matters for aliased imports. `import type { AuthProfileKind
 * as StoredAuthProfileKind }` is referenced locally as `StoredAuthProfileKind`,
 * but the declaring module knows it as `AuthProfileKind` — looking up the local
 * alias in the target file finds nothing and silently gives up, which is
 * exactly how this guard kept passing on a banned member of an imported type.
 */
function importedTypeOrigins(
  file: string,
  source: ts.SourceFile
): Map<string, { file: string; exportedName: string }> {
  const origins = new Map<string, { file: string; exportedName: string }>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const target = resolveImport(file, statement.moduleSpecifier.text);
    if (!target) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      origins.set(element.name.text, {
        file: target,
        // `propertyName` is the name in the source module when aliased.
        exportedName: (element.propertyName ?? element.name).text,
      });
    }
  }
  return origins;
}

/** Find a named type/interface declaration at the top level of a file. */
function findTypeDeclaration(
  source: ts.SourceFile,
  name: string
): ts.Node | undefined {
  for (const statement of source.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === name
    ) {
      return statement;
    }
  }
  return undefined;
}

/**
 * ClientSDK namespace surface: `*Namespace` method names plus every property
 * name and string literal reachable from an exported type in the file — method
 * parameter and return types, nested type literals, exported input/output
 * declarations, and the definitions of types they reference.
 *
 * Recursion matters in two directions, and missing either one has already
 * shipped a false negative past an earlier revision of this guard:
 *
 *   - Depth: an agent-facing key is agent-facing at any depth, so
 *     `{ source: { automation_id } }` and `method(input: { automation_id })` are
 *     violations exactly like a top-level member.
 *   - Reference: `profile_kind: AuthProfileKind` puts whatever
 *     `AuthProfileKind` resolves to on the wire. Scanning only the current
 *     file let a banned member of an imported type pass clean, so type
 *     references are followed into their defining module (local paths only —
 *     node_modules is not our surface to police).
 *
 * String literals count here, not just property names: a referenced type is
 * frequently a union of wire values, which is exposed vocabulary even though
 * no property carries the retired word.
 */
function scanNamespaceSurface(file: string, violations: Violation[]): void {
  const seen = new Set<string>();

  function scanFile(currentFile: string, rootNames: string[] | null): void {
    let source: ts.SourceFile;
    try {
      source = parse(currentFile);
    } catch {
      return;
    }
    const imports = importedTypeOrigins(currentFile, source);

    function walk(node: ts.Node): void {
      const name = propertyName(node);
      const text = name && propertyNameText(name);
      if (name && text && BANNED.test(text)) {
        addViolation(violations, currentFile, source, name);
      }

      if (
        (ts.isStringLiteral(node) || isTemplateText(node)) &&
        BANNED.test(node.text)
      ) {
        addViolation(violations, currentFile, source, node);
      }

      // Follow `foo: SomeType` into SomeType's declaration, and `interface X
      // extends Y` into Y's — an inherited member is on the wire exactly like a
      // declared one, and `extends` is an ExpressionWithTypeArguments rather
      // than a TypeReferenceNode, so it needs naming separately.
      const referencedName = ts.isTypeReferenceNode(node)
        ? ts.isIdentifier(node.typeName)
          ? node.typeName.text
          : undefined
        : ts.isExpressionWithTypeArguments(node) &&
            ts.isIdentifier(node.expression)
          ? node.expression.text
          : undefined;
      if (referencedName) {
        const referenced = referencedName;
        const local = findTypeDeclaration(source, referenced);
        if (local) {
          const key = `${currentFile}#${referenced}`;
          if (!seen.has(key)) {
            seen.add(key);
            walk(local);
          }
        } else {
          const origin = imports.get(referenced);
          if (origin) scanFile(origin.file, [origin.exportedName]);
        }
      }

      ts.forEachChild(node, walk);
    }

    if (rootNames) {
      for (const name of rootNames) {
        const key = `${currentFile}#${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const declaration = findTypeDeclaration(source, name);
        if (declaration) walk(declaration);
      }
      return;
    }

    for (const statement of source.statements) {
      const isNamespaceInterface =
        ts.isInterfaceDeclaration(statement) &&
        statement.name.text.endsWith("Namespace");
      const isExportedType =
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        );
      if (isNamespaceInterface || isExportedType) {
        walk(statement);
      }
    }
  }

  scanFile(file, null);
}

/**
 * query_sql's queryable-relation allowlist.
 *
 * BLIND SPOT THIS CLOSES: `QUERYABLE_SCHEMA` in
 * `packages/server/src/utils/table-schema.ts` is agent-facing vocabulary — the
 * allowlist error enumerates every relation name verbatim to the caller — but
 * `utils/` was in no scanned directory, and the name reaches the agent through
 * a runtime `[...QUERYABLE_TABLE_NAMES].join(', ')` rather than a static
 * literal, so neither the directory scans nor the literal scans could have
 * seen it. Retired relation names could therefore have remained exposed while
 * the guard reported clean.
 *
 * Scanning the whole file would fire on every legitimate internal use (physical
 * table names in the CTE builder, `automation_id` columns, comments). What is
 * agent-facing is precisely the `name:` of each entry in the
 * `QUERYABLE_SCHEMA.tables` array, so that is what is checked — the exposed
 * relation names only, not the physical mapping beside them.
 */
function scanQueryableRelationNames(
  file: string,
  violations: Violation[]
): void {
  const source = parse(file);

  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "QUERYABLE_SCHEMA" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          propertyNameText(property.name) !== "tables" ||
          !ts.isArrayLiteralExpression(property.initializer)
        ) {
          continue;
        }
        for (const entry of property.initializer.elements) {
          if (!ts.isObjectLiteralExpression(entry)) continue;
          for (const field of entry.properties) {
            if (
              ts.isPropertyAssignment(field) &&
              propertyNameText(field.name) === "name" &&
              ts.isStringLiteral(field.initializer) &&
              BANNED.test(field.initializer.text)
            ) {
              addViolation(violations, file, source, field.initializer);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
}

/** Published declaration text, including JSDoc. */
function scanFullText(file: string, violations: Violation[]): void {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (BANNED.test(line)) {
      violations.push({
        file: rel(file),
        line: i + 1,
        excerpt: line.trim().slice(0, 120),
      });
    }
  }
}

const CANONICAL_SCAN_EXCLUSIONS = new Set([
  "CHANGELOG.md",
  "scripts/check-exposed-surface-naming.ts",
  "scripts/__tests__/check-exposed-surface-naming.test.ts",
  "packages/server/src/__tests__/integration/db/automation-schema-vocabulary.test.ts",
  // Third-party OpenAPI client boilerplate generated by Hey API.
  "packages/client/src/generated/client/types.gen.ts",
  // Vendored/generated Kubernetes API descriptions use generic standards prose.
  "packages/owletto/deploy/k8s/infrastructure/cert-manager/cert-manager.yaml",
  "packages/owletto/deploy/k8s/clusters/buremba-prod/cert-manager.yaml",
  "packages/owletto/deploy/k8s/infrastructure/barman-plugin/manifest.yaml",
  "packages/owletto/deploy/k8s/clusters/lobu-prod/barman-plugin.yaml",
]);

function isCanonicalScanException(file: string): boolean {
  return (
    CANONICAL_SCAN_EXCLUSIONS.has(file) ||
    file.startsWith("packages/owletto/.pi-subagents/artifacts/") ||
    // Google Discovery documents, trimmed and pinned by
    // packages/connectors/scripts/pin-google-discovery.ts; their prose is Google's.
    file.startsWith("packages/connectors/src/_google/discovery/") ||
    file.startsWith("db/migrations/")
  );
}

/** Scan every tracked live text file, including the Owletto submodule. */
function scanCanonicalVocabulary(violations: Violation[]): void {
  const repositories = [REPO_ROOT, join(REPO_ROOT, "packages/owletto")];
  for (const repository of repositories) {
    const prefix = repository === REPO_ROOT ? "" : "packages/owletto/";
    const toplevel = execFileSync(
      "git",
      ["-C", repository, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" }
    ).trim();
    if (resolve(toplevel) !== resolve(repository)) {
      if (repository === REPO_ROOT) {
        console.error(
          "check-exposed-surface-naming: cannot resolve the repository root."
        );
        process.exit(1);
      }
      console.warn(
        `check-exposed-surface-naming: SKIPPED ${rel(repository)} — submodule ` +
          `not checked out. Its vocabulary is gated on runs that have it.`
      );
      continue;
    }
    const output = execFileSync(
      "git",
      [
        "-C",
        repository,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { encoding: "utf8" }
    );
    for (const path of output.split("\0")) {
      if (!path) continue;
      const repoPath = `${prefix}${path}`;
      if (isCanonicalScanException(repoPath)) continue;
      // Before the content read: a binary or unreadable file still has a path,
      // and the path is exposed vocabulary on its own.
      if (RETIRED_CANONICAL_VOCABULARY.test(repoPath)) {
        violations.push({
          file: repoPath,
          line: 1,
          excerpt: "retired term in path",
        });
      }
      const file = join(repository, path);
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\0")) continue;
      const lines = content.split("\n");
      lines.forEach((line, index) => {
        // Tests may load an immutable historical migration by its exact
        // timestamped filename. The filename is history, not a live contract.
        const canonicalLine = line
          .replace(/\b20\d{12}_[A-Za-z0-9_-]+\.sql\b/g, "")
          // External platform APIs use this standards-shaped property name.
          // Strip only exact known option values; owned contracts use canonical
          // vocabulary and remain fully scanned.
          .replace(
            /["'`]?\bbehavior["'`]?\s*:\s*["'`](?:auto|default|instant|merge|smooth)["'`]/g,
            ""
          )
          .replace(/\bbehavior\s*:\s*(?:default|merge)\b/g, "")
          .replace(/\bbehavior\s*=\s*["'`](?:instant|smooth)["'`]/g, "")
          // AppKit owns these exact NSWindow names, in both their property
          // (`collectionBehavior`) and type (`NSWindow.CollectionBehavior`)
          // spellings. Match member access only, so an owned key or prose using
          // the same words still fails the canonical vocabulary gate.
          .replace(/\.(?:collectionBehavior|animationBehavior)\b/gi, "")
          // Chrome owns these exact `chrome.sidePanel` identifiers. Unlike the
          // AppKit names this matches the bare token, not just member access:
          // the extension stubs the setter as a bare object key in tests, and
          // no owned surface is spelled exactly this. Banning them is what
          // made #863 rename `setPanelBehavior` to `setPanelAutomation` — a
          // name no Chrome build ships — which left the Owletto toolbar icon
          // silently unable to open the side panel
          // (packages/owletto/apps/chrome/side-panel-action-click.js).
          // A retired term is ours to retire; a platform's identifier is not.
          .replace(/\b(?:setPanelBehavior|getPanelBehavior)\b/g, "")
          .replace(/\bscroll-behavior\b/g, "");
        if (RETIRED_CANONICAL_VOCABULARY.test(canonicalLine)) {
          violations.push({
            file: rel(file),
            line: index + 1,
            excerpt: line.trim(),
          });
        }
      });
    }
  }
}

const violations: Violation[] = [];

scanCanonicalVocabulary(violations);

// Public connector type declarations: JSDoc is published with the types.
scanFullText(
  join(REPO_ROOT, "packages/connector-sdk/src/reaction-client-types.ts"),
  violations
);

// TypeBox declarations that feed MCP and ClientSDK request/result schemas.
for (const dir of [
  join(REPO_ROOT, "packages/core/src/contracts/tools"),
  join(REPO_ROOT, "packages/server/src/tools"),
  join(REPO_ROOT, "packages/server/src/types"),
]) {
  for (const file of collectTsFiles(dir)) {
    scanTypeBoxSchemas(file, violations);
  }
}

// query_sql's queryable-relation allowlist: enumerated verbatim to agents in
// the unknown-table error, so the relation names are agent-facing vocabulary.
scanQueryableRelationNames(
  join(REPO_ROOT, "packages/server/src/utils/table-schema.ts"),
  violations
);

// Tool names/descriptions/titles and SDK discovery text/names/aliases.
for (const file of [
  join(REPO_ROOT, "packages/server/src/tools/registry.ts"),
  join(REPO_ROOT, "packages/server/src/tools/admin/index.ts"),
  join(REPO_ROOT, "packages/server/src/sandbox/method-metadata.ts"),
  join(REPO_ROOT, "packages/server/src/sandbox/sdk-aliases.ts"),
  join(REPO_ROOT, "packages/server/src/sandbox/sdk-manifest.ts"),
]) {
  scanExposedSyntax(file, violations);
}

// Runtime-callable ClientSDK namespace member names, plus the exported input /
// output types that describe their arguments — `automation_id` on an exported
// namespace interface is an agent-facing wire key even though it is not a
// method name.
const namespacesDir = join(REPO_ROOT, "packages/server/src/sandbox/namespaces");
for (const file of collectTsFiles(namespacesDir)) {
  scanNamespaceSurface(file, violations);
}

// Plain TypeScript response types are not TypeBox initializers, but they still
// describe public tool payloads. Keep the server projection and the trusted web
// client's wire models under the same vocabulary gate so a generic
// Type.Record result cannot hide a stale key from the schema scan.
for (const file of [
  join(
    REPO_ROOT,
    "packages/server/src/tools/admin/manage_operations/activity-feed.ts"
  ),
  join(REPO_ROOT, "packages/owletto/src/lib/api/activity.ts"),
  join(REPO_ROOT, "packages/owletto/src/lib/api/automations.ts"),
  join(REPO_ROOT, "packages/owletto/src/lib/api/content.ts"),
  join(REPO_ROOT, "packages/owletto/src/lib/api/runs.ts"),
]) {
  scanNamespaceSurface(file, violations);
}

const seen = new Set<string>();
const unique = violations.filter((violation) => {
  const key = `${violation.file}:${violation.line}:${violation.excerpt}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
unique.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

if (unique.length > 0) {
  console.error(
    `check-exposed-surface-naming: retired watcher/Behavior vocabulary is banned from ` +
      `the live repository. Found ${unique.length} occurrence(s):\n`
  );
  for (const violation of unique) {
    console.error(
      `  ${violation.file}:${violation.line}: ${violation.excerpt}`
    );
  }
  console.error(
    `\nScope: all tracked live code and documentation, plus semantic scans of ` +
      `MCP schemas, ClientSDK types, query_sql, and reaction contracts. Only ` +
      `immutable history, generated third-party material, exact external ` +
      `protocol properties, and negative naming fixtures are exempt.`
  );
  process.exit(1);
}

console.log(
  "check-exposed-surface-naming: clean — Automation is canonical across live tracked files."
);
