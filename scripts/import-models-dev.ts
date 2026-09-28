#!/usr/bin/env bun
// bun scripts/import-models-dev.ts <api.json> [--check|--write]
// Offline maintenance only: pin new bytes in config/models-dev.json after
// reviewing the source and shortlist. Never fetch models.dev at build/runtime.
// Only explicit mapped shortlists are generated; provider metadata stays local.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { ProvidersConfigFile } from "@lobu/core";
import ts from "typescript";

export interface ModelsDevPolicy {
  snapshot: { url: string; sha256: string; providerCount: number };
  providers: Record<
    string,
    {
      modelsDevProvider: string;
      shortlist: string[];
      localModels: Record<string, string>;
      exclude: Record<string, string>;
    }
  >;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function importModelsDev(
  registry: ProvidersConfigFile,
  snapshotBytes: Uint8Array,
  policy: ModelsDevPolicy
): ProvidersConfigFile {
  const hash = createHash("sha256").update(snapshotBytes).digest("hex");
  if (hash !== policy.snapshot.sha256) {
    throw new Error(
      `models.dev SHA-256 mismatch: expected ${policy.snapshot.sha256}, got ${hash}`
    );
  }
  const snapshot: unknown = JSON.parse(
    Buffer.from(snapshotBytes).toString("utf8")
  );
  if (
    !object(snapshot) ||
    Object.keys(snapshot).length !== policy.snapshot.providerCount
  ) {
    throw new Error("models.dev provider count does not match the pin");
  }
  const result = structuredClone(registry);
  for (const [slug, selection] of Object.entries(policy.providers)) {
    const entries = result.providers.filter((entry) => entry.id === slug);
    const entry = entries[0];
    if (entries.length !== 1 || entry?.providers.length !== 1) {
      throw new Error(`${slug}: expected exactly one local provider`);
    }
    const provider = entry.providers[0]!;
    const source = snapshot[selection.modelsDevProvider];
    if (
      !object(source) ||
      source.id !== selection.modelsDevProvider ||
      !object(source.models)
    ) {
      throw new Error(
        `${slug}: invalid source provider ${selection.modelsDevProvider}`
      );
    }
    if (
      !selection.shortlist.length ||
      new Set(selection.shortlist).size !== selection.shortlist.length
    ) {
      throw new Error(`${slug}: shortlist must be nonempty and unique`);
    }
    const models: string[] = [];
    for (const id of selection.shortlist) {
      if (Object.hasOwn(selection.exclude, id)) continue;
      if (Object.hasOwn(selection.localModels, id)) {
        // Exceptions preserve known local choices, never introduce unverified IDs.
        if (
          !selection.localModels[id]?.trim() ||
          !provider.models?.includes(id)
        ) {
          throw new Error(
            `${slug}: local model ${id} must already exist and have a reason`
          );
        }
      } else {
        const model = source.models[id];
        if (
          !object(model) ||
          model.id !== id ||
          model.tool_call !== true ||
          !object(model.modalities) ||
          !Array.isArray(model.modalities.output) ||
          !model.modalities.output.includes("text")
        ) {
          throw new Error(
            `${slug}: ${id} is missing or is not a text/tool model in ${selection.modelsDevProvider}`
          );
        }
      }
      models.push(id);
    }
    if (
      !models.length ||
      !provider.defaultModel ||
      !models.includes(provider.defaultModel)
    ) {
      throw new Error(
        `${slug}: shortlist must retain the unchanged default ${provider.defaultModel}`
      );
    }
    provider.models = models;
  }
  return result;
}

// Use the workspace's JSON parser to replace only the selected array spans.
// Re-serializing the registry also rewrites unrelated lists and escaped metadata.
function renderRegistry(before: string, result: ProvidersConfigFile): string {
  const original: ProvidersConfigFile = JSON.parse(before);
  const tree = ts.parseJsonText("providers.json", before);
  const statement = tree.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    throw new Error("Expected a JSON registry object");
  }
  function property(node: ts.Node | undefined, key: string): ts.Expression {
    if (node && ts.isObjectLiteralExpression(node)) {
      for (const item of node.properties) {
        if (
          ts.isPropertyAssignment(item) &&
          ts.isStringLiteral(item.name) &&
          item.name.text === key
        ) {
          return item.initializer;
        }
      }
    }
    throw new Error(`Missing registry property ${key}`);
  }
  function array(node: ts.Node): ts.ArrayLiteralExpression {
    if (!ts.isArrayLiteralExpression(node))
      throw new Error("Expected a registry array");
    return node;
  }
  const entries = array(property(statement.expression, "providers"));
  const edits: { start: number; end: number; text: string }[] = [];
  result.providers.forEach((entry, index) => {
    entry.providers.forEach((provider, providerIndex) => {
      if (
        JSON.stringify(provider.models) ===
        JSON.stringify(
          original.providers[index]!.providers[providerIndex]!.models
        )
      )
        return;
      const providers = array(property(entries.elements[index], "providers"));
      const models = array(
        property(providers.elements[providerIndex], "models")
      );
      const start = models.getStart(tree);
      const indent = before
        .slice(before.lastIndexOf("\n", start) + 1, start)
        .match(/^[ \t]*/)![0];
      edits.push({
        start,
        end: models.end,
        text: JSON.stringify(provider.models, null, 2).replace(
          /\n/g,
          `\n${indent}`
        ),
      });
    });
  });
  let after = before;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  }
  if (JSON.stringify(JSON.parse(after)) !== JSON.stringify(result)) {
    throw new Error("Registry edits did not produce the validated shortlists");
  }
  return after;
}

if (import.meta.main) {
  try {
    const [snapshotPath, mode = "--check", ...extra] = process.argv.slice(2);
    if (
      !snapshotPath ||
      snapshotPath.startsWith("--") ||
      extra.length ||
      !["--check", "--write"].includes(mode)
    ) {
      throw new Error(
        "Usage: bun scripts/import-models-dev.ts <api.json> [--check|--write]"
      );
    }
    const policy: ModelsDevPolicy = JSON.parse(
      readFileSync(
        new URL("../config/models-dev.json", import.meta.url),
        "utf8"
      )
    );
    const registryPath = new URL("../config/providers.json", import.meta.url);
    const before = readFileSync(registryPath, "utf8");
    const result = importModelsDev(
      JSON.parse(before),
      readFileSync(snapshotPath),
      policy
    );
    const after = renderRegistry(before, result);
    if (before !== after) {
      if (mode === "--check") {
        throw new Error(
          "Provider shortlists differ; review the policy, then run with --write"
        );
      }
      writeFileSync(registryPath, after);
    }
    console.log(
      `models.dev shortlists ${mode === "--write" ? "written" : "verified"}: ${Object.keys(policy.providers).join(", ")}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
