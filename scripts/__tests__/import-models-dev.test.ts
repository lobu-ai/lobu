import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProvidersConfigFile } from "@lobu/core";
import { importModelsDev, type ModelsDevPolicy } from "../import-models-dev";

const registryRaw = readFileSync(
  new URL("../../config/providers.json", import.meta.url),
  "utf8"
);
const registry: ProvidersConfigFile = JSON.parse(registryRaw);

// Synthetic snapshot: only the fields the importer consumes. The live pin is
// exercised separately with the verified api.json, never fetched by tests.
function fixture() {
  const model = (id: string) => ({
    id,
    tool_call: true,
    modalities: { output: ["text"] },
  });
  const snapshot = {
    alibaba: {
      id: "alibaba",
      api: "https://example.invalid/foreign-endpoint",
      models: Object.fromEntries(
        [
          "qwen3.8-max",
          "qwen-max",
          "qwen-plus",
          "qwen-turbo",
          "unselected",
        ].map((id) => [id, model(id)])
      ),
    },
    unrelated: { id: "unrelated", models: {} },
  };
  const policy: ModelsDevPolicy = JSON.parse(
    readFileSync(
      new URL("../../config/models-dev.json", import.meta.url),
      "utf8"
    )
  );
  const input = structuredClone(registry);
  const qwen = input.providers.find((entry) => entry.id === "qwen")!
    .providers[0]!;
  qwen.models!.splice(4, 0, "qwen-turbo");
  const run = () => {
    const bytes = Buffer.from(JSON.stringify(snapshot));
    policy.snapshot.sha256 = createHash("sha256").update(bytes).digest("hex");
    policy.snapshot.providerCount = Object.keys(snapshot).length;
    return importModelsDev(input, bytes, policy);
  };
  return { snapshot, policy, input, qwen, run };
}

describe("bounded models.dev import", () => {
  test("removes turbo but preserves every other field, list and local model", () => {
    const { input, snapshot, run } = fixture();
    const before = structuredClone(input);
    expect(snapshot.alibaba.models["qwen-turbo"]).toBeDefined();
    const result = run();
    expect(result).toEqual(registry);
    expect(input).toEqual(before);
    expect(
      result.providers.find((p) => p.id === "qwen")!.providers[0]!.models
    ).toEqual([
      "qwen3.8-max",
      "qwen3.8-max-preview",
      "qwen-max",
      "qwen-plus",
      "qwen2.5-coder-32b-instruct",
      "qwen2.5-72b-instruct",
    ]);
  });

  test("local exclusion wins even when turbo is shortlisted upstream", () => {
    const { policy, run } = fixture();
    policy.providers.qwen!.shortlist.push("qwen-turbo");
    expect(run()).toEqual(registry);
  });

  test("rejects bytes that do not match the pin", () => {
    const { policy, input } = fixture();
    expect(() => importModelsDev(input, Buffer.from("{}"), policy)).toThrow(
      /SHA-256/
    );
  });

  test("rejects a truncated catalog even with a matching checksum", () => {
    const { policy, input } = fixture();
    const bytes = Buffer.from("{}");
    policy.snapshot.sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(() => importModelsDev(input, bytes, policy)).toThrow(
      /provider count/
    );
  });

  test("rejects an unknown source mapping instead of guessing an alias", () => {
    const { policy, run } = fixture();
    policy.providers.qwen!.modelsDevProvider = "qwen";
    expect(run).toThrow(/source provider/);
  });

  test("rejects ambiguous local provider entries", () => {
    const { input, qwen, run } = fixture();
    input.providers.find((p) => p.id === "qwen")!.providers.push(qwen);
    expect(run).toThrow(/exactly one/);
  });

  test("rejects duplicate provider slugs", () => {
    const { input, run } = fixture();
    input.providers.push(input.providers.find((p) => p.id === "qwen")!);
    expect(run).toThrow(/exactly one/);
  });

  test("fails on a missing shortlisted model instead of silently dropping it", () => {
    const { snapshot, run } = fixture();
    delete snapshot.alibaba.models["qwen-plus"];
    expect(run).toThrow(/qwen-plus/);
  });

  test("rejects mismatched provider and model IDs", () => {
    const providerCase = fixture();
    providerCase.snapshot.alibaba.id = "another-provider";
    expect(providerCase.run).toThrow(/source provider/);
    const modelCase = fixture();
    modelCase.snapshot.alibaba.models["qwen-plus"]!.id = "another-model";
    expect(modelCase.run).toThrow(/qwen-plus/);
  });

  test("rejects shortlisted models without text output or tool calls", () => {
    const noText = fixture();
    noText.snapshot.alibaba.models["qwen-plus"]!.modalities.output = ["image"];
    expect(noText.run).toThrow(/qwen-plus/);
    const noTools = fixture();
    noTools.snapshot.alibaba.models["qwen-plus"]!.tool_call = false;
    expect(noTools.run).toThrow(/qwen-plus/);
  });

  test("local exceptions must be existing choices with a reason", () => {
    const absent = fixture();
    absent.qwen.models = absent.qwen.models!.filter(
      (id) => id !== "qwen3.8-max-preview"
    );
    expect(absent.run).toThrow(/local model/);
    const unreasoned = fixture();
    unreasoned.policy.providers.qwen!.localModels["qwen3.8-max-preview"] = "";
    expect(unreasoned.run).toThrow(/local model/);
  });

  test("does not change a default to make an invalid shortlist work", () => {
    const { qwen, run } = fixture();
    qwen.defaultModel = "qwen-turbo";
    expect(run).toThrow(/default/);
  });

  test("rejects empty and duplicate shortlists", () => {
    const empty = fixture();
    empty.policy.providers.qwen!.shortlist = [];
    expect(empty.run).toThrow(/shortlist/);
    const duplicate = fixture();
    duplicate.policy.providers.qwen!.shortlist.push("qwen-max");
    expect(duplicate.run).toThrow(/shortlist/);
  });

  test("repeat imports are deterministic", () => {
    const { run, input } = fixture();
    const first = run();
    input.providers = first.providers;
    expect(run()).toEqual(first);
  });
});

function withCli(
  check: (context: {
    run: (...args: string[]) => ReturnType<typeof spawnSync>;
    registryPath: string;
    snapshotPath: string;
    before: string;
  }) => void
) {
  const dir = mkdtempSync(join(tmpdir(), "models-dev-import-"));
  try {
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "config"));
    symlinkSync(
      new URL("../../node_modules", import.meta.url),
      join(dir, "node_modules")
    );
    const scriptPath = join(dir, "scripts/import-models-dev.ts");
    copyFileSync(
      new URL("../import-models-dev.ts", import.meta.url),
      scriptPath
    );
    const { snapshot, policy, run } = fixture();
    run(); // Pin the synthetic bytes for this isolated CLI invocation.
    const snapshotPath = join(dir, "api.json");
    const registryPath = join(dir, "config/providers.json");
    const before = registryRaw.replace(
      '            "qwen2.5-coder-32b-instruct",',
      '            "qwen-turbo",\n            "qwen2.5-coder-32b-instruct",'
    );
    writeFileSync(snapshotPath, JSON.stringify(snapshot));
    writeFileSync(registryPath, before);
    writeFileSync(join(dir, "config/models-dev.json"), JSON.stringify(policy));
    check({
      run: (...args) =>
        spawnSync(process.execPath, [scriptPath, ...args], {
          cwd: tmpdir(), // Paths must resolve from the script, not the caller.
          encoding: "utf8",
        }),
      registryPath,
      snapshotPath,
      before,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("models.dev importer CLI", () => {
  test("check detects drift without writing; write regenerates and is idempotent", () => {
    withCli(({ run, registryPath, snapshotPath, before }) => {
      const stale = run(snapshotPath);
      expect(stale.status).toBe(1);
      expect(String(stale.stderr)).toContain("shortlists differ");
      expect(readFileSync(registryPath, "utf8")).toBe(before);
      const written = run(snapshotPath, "--write");
      expect(written.status).toBe(0);
      expect(String(written.stdout)).toContain("shortlists written: qwen");
      const expected = registryRaw;
      expect(readFileSync(registryPath, "utf8")).toBe(expected);
      expect(run(snapshotPath, "--check").status).toBe(0);
      expect(run(snapshotPath, "--write").status).toBe(0);
      expect(readFileSync(registryPath, "utf8")).toBe(expected);
    });
  });

  test("a checksum failure cannot overwrite the registry", () => {
    withCli(({ run, registryPath, snapshotPath, before }) => {
      writeFileSync(snapshotPath, "{}");
      const result = run(snapshotPath, "--write");
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain("SHA-256 mismatch");
      expect(readFileSync(registryPath, "utf8")).toBe(before);
    });
  });

  test("invalid arguments fail without writing", () => {
    withCli(({ run, registryPath, snapshotPath, before }) => {
      for (const args of [
        [],
        [snapshotPath, "--unknown"],
        [snapshotPath, "--write", "extra"],
      ]) {
        const result = run(...args);
        expect(result.status).toBe(1);
        expect(String(result.stderr)).toContain("Usage:");
        expect(readFileSync(registryPath, "utf8")).toBe(before);
      }
    });
  });
});
