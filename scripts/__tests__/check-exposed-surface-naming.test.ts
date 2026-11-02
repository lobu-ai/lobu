/**
 * The naming guard is only worth having if it actually fails on a regression.
 * Three earlier revisions of it passed clean on violations they were written to
 * catch: a key-anchored regex that could not match `watcher_source`, a scan that
 * saw only `*Namespace` method names, and one that saw only direct members of
 * exported types.
 *
 * These fixtures mutate a scratch copy of the real scanned files, run the guard
 * as a subprocess, and assert the exit code — the same signal `make pre-pr` and
 * CI act on.
 */

import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const GUARD = join(REPO_ROOT, "scripts/check-exposed-surface-naming.ts");
const NAMESPACE_FILE = join(
  REPO_ROOT,
  "packages/server/src/sandbox/namespaces/automations.ts"
);
const CONTRACT_FILE = join(
  REPO_ROOT,
  "packages/core/src/contracts/tools/manage-entity.ts"
);
const PUBLIC_ACTIVITY_FILE = join(
  REPO_ROOT,
  "packages/server/src/tools/admin/manage_operations/activity-feed.ts"
);
/** Defines `AuthProfileKind`, which the auth-profiles namespace imports aliased. */
const IMPORTED_TYPE_FILE = join(
  REPO_ROOT,
  "packages/server/src/utils/auth-profiles.ts"
);

/** Namespace whose method signature the alias fixture hangs a probe type off. */
const CATALOG_NAMESPACE_FILE = join(
  REPO_ROOT,
  "packages/server/src/sandbox/namespaces/catalog.ts"
);
/** Written and deleted per-test; reached only via the `@lobu/core/` alias. */
const CORE_PROBE_FILE = join(REPO_ROOT, "packages/core/src/guard-probe.ts");
const GENERIC_BEHAVIOR_PROBE_FILE = join(
  REPO_ROOT,
  "packages/core/src/guard-probe.json"
);
/**
 * The AppKit exemption is content-shaped, not path-scoped, so a main-repo probe
 * exercises it. A probe under `packages/owletto` would instead pass vacuously on
 * a checkout without the submodule, which the guard skips.
 */
const APPKIT_BEHAVIOR_PROBE_FILE = join(
  REPO_ROOT,
  "packages/core/src/guard-probe.swift"
);
const RETIRED_PATH_PROBE_FILE = join(
  REPO_ROOT,
  "packages/core/src/watcher-probe.bin"
);
const ROOT_AGENT_FILE = join(REPO_ROOT, "AGENTS.md");

const touched: string[] = [];
const created: string[] = [];

function mutate(file: string, anchor: string, insert: string): void {
  // Back up only on first touch: a fixture that mutates the same file twice
  // would otherwise overwrite the pristine copy with an already-mutated one and
  // leave the repo dirty after the run.
  if (!touched.includes(file)) {
    copyFileSync(file, `${file}.guardbak`);
    touched.push(file);
  }
  const source = readFileSync(file, "utf8");
  const at = source.indexOf(anchor);
  if (at < 0) throw new Error(`anchor not found in ${file}: ${anchor}`);
  writeFileSync(file, source.slice(0, at) + insert + source.slice(at));
}

function create(file: string, contents: string): void {
  created.push(file);
  writeFileSync(file, contents);
}

function runGuard(): number {
  const result = Bun.spawnSync(["bun", GUARD], { cwd: REPO_ROOT });
  return result.exitCode;
}

afterEach(() => {
  for (const file of touched.splice(0)) {
    copyFileSync(`${file}.guardbak`, file);
    rmSync(`${file}.guardbak`, { force: true });
  }
  for (const file of created.splice(0)) {
    rmSync(file, { force: true });
  }
});

describe("check-exposed-surface-naming", () => {
  it("passes on the clean tree", () => {
    expect(runGuard()).toBe(0);
  });

  it("allows an exact external platform behavior option", () => {
    create(GENERIC_BEHAVIOR_PROBE_FILE, '{"behavior":"smooth"}\n');
    expect(runGuard()).toBe(0);
  });

  it.each([
    ['await page.unrouteAll({ behavior: "wait" });', 0],
    ["await context.unrouteAll({ behavior: 'wait' });", 0],
    ['const options = { behavior: "wait" };', 1],
    ['page.unrouteAllLater({ behavior: "wait" });', 1],
    ['page.unrouteAll({ behavior: "product" });', 1],
    ['page.unrouteAll({ behavior: "wait" }); // Behavior run', 1],
  ])("keeps the Playwright teardown exception narrow: %s", (source, code) => {
    create(GENERIC_BEHAVIOR_PROBE_FILE, `${source}\n`);
    expect(runGuard()).toBe(code);
  });

  it("allows exact AppKit behavior property and type spellings", () => {
    create(
      APPKIT_BEHAVIOR_PROBE_FILE,
      "panel.collectionBehavior = NSWindow.CollectionBehavior.stationary\n" +
        "panel.animationBehavior = .none\n"
    );
    expect(runGuard()).toBe(0);
  });

  it("allows the exact Chrome sidePanel identifiers", () => {
    // The extension calls these as members and stubs them as bare property
    // keys, so both spellings have to survive the gate. Without this, keeping
    // the calling file scanned means renaming a Chrome API — which is how #863
    // broke the toolbar icon.
    create(
      GENERIC_BEHAVIOR_PROBE_FILE,
      "chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })\n" +
        "await chrome.sidePanel.getPanelBehavior()\n" +
        "const stub = { setPanelBehavior: fake }\n"
    );
    expect(runGuard()).toBe(0);
  });

  it("does not exempt an owned key that merely resembles the Chrome name", () => {
    create(GENERIC_BEHAVIOR_PROBE_FILE, '{"panelBehavior":"owned"}\n');
    expect(runGuard()).toBe(1);
  });

  it("does not exempt an owned AppKit-shaped behavior key", () => {
    create(GENERIC_BEHAVIOR_PROBE_FILE, '{"collectionBehavior":"owned"}\n');
    expect(runGuard()).toBe(1);
  });

  it("does not turn the generic-option exception into a product-term escape", () => {
    create(GENERIC_BEHAVIOR_PROBE_FILE, '{"behavior":"product"}\n');
    expect(runGuard()).toBe(1);
  });

  it("fails on a retired term in a binary file path", () => {
    create(RETIRED_PATH_PROBE_FILE, "\0binary fixture");
    expect(runGuard()).toBe(1);
  });

  it("fails on retired British-spelling product prose", () => {
    create(
      GENERIC_BEHAVIOR_PROBE_FILE,
      '{"description":"Two Behaviour runs are racing"}\n'
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on generic lowercase prose in owned live files", () => {
    create(
      GENERIC_BEHAVIOR_PROBE_FILE,
      '{"description":"Preserve the existing behavior"}\n'
    );
    expect(runGuard()).toBe(1);
  });

  it("scans live agent instructions for retired product prose", () => {
    mutate(
      ROOT_AGENT_FILE,
      "## Repo map",
      "A Behavior run is still documented here.\n\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a snake_case wire key in a TypeBox tool contract", () => {
    mutate(
      CONTRACT_FILE,
      "  automation_source: Type.Optional(",
      "  watcher_source: Type.Optional(Type.Number()),\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a camelCase key in a TypeBox tool contract", () => {
    mutate(
      CONTRACT_FILE,
      "  automation_source: Type.Optional(",
      "  watcherId: Type.Optional(Type.String()),\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a banned key in a plain public response type", () => {
    mutate(
      PUBLIC_ACTIVITY_FILE,
      "\tautomation_id?: number;",
      "\twatcher_id?: number;"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a banned key in an exported namespace input type", () => {
    mutate(
      NAMESPACE_FILE,
      "export interface",
      "export interface GuardFixtureDirect { watcher_id: number }\n\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a banned key nested inside an exported type", () => {
    mutate(
      NAMESPACE_FILE,
      "export interface",
      "export interface GuardFixtureNested { source: { watcher_id: number } }\n\n"
    );
    expect(runGuard()).toBe(1);
  });

  // `auth-profiles` namespace exposes `profile_kind: AuthProfileKind`, which
  // resolves through `Exclude<StoredAuthProfileKind, …>` to a type imported
  // *under an alias* from ../../utils/auth-profiles. The banned value therefore
  // lives in a file the guard never scans directly and is reachable only by
  // following the reference — and by mapping the alias back to the name the
  // defining module actually declares. Adding the union member to the real
  // referenced type is what makes this fixture exercise that path; a fresh
  // unreferenced type would prove nothing, since nothing points at it.
  it("fails on a banned literal inside an aliased imported type", () => {
    // Anchored on the first union member so the inserted one joins the existing
    // declaration rather than creating a second, unreferenced one.
    mutate(IMPORTED_TYPE_FILE, "  | 'env'", "  | 'watcher_kind'\n");
    expect(runGuard()).toBe(1);
  });

  // `@lobu/core/...` is not a relative specifier, so an earlier revision skipped
  // it as "not ours" — while `CatalogNamespace.listCatalog` takes a type
  // imported from exactly there. The probe type lives outside
  // contracts/tools so the TypeBox scanner cannot claim the catch; only alias
  // resolution reaches it.
  it("fails on a banned key reached through a workspace-alias import", () => {
    create(
      CORE_PROBE_FILE,
      "export interface GuardProbeInput { watcher_id: number }\n"
    );
    mutate(
      CATALOG_NAMESPACE_FILE,
      "\tlistCatalog(",
      "\tprobe(input: GuardProbeInput): Promise<void>;\n"
    );
    mutate(
      CATALOG_NAMESPACE_FILE,
      "import type",
      'import type { GuardProbeInput } from "@lobu/core/guard-probe";\n'
    );
    expect(runGuard()).toBe(1);
  });

  // An inherited member is on the wire exactly like a declared one, and
  // `extends` parses as ExpressionWithTypeArguments rather than a
  // TypeReferenceNode — so following only type references walked straight past
  // it.
  it("fails on a banned key inherited through an extends clause", () => {
    mutate(
      NAMESPACE_FILE,
      "export interface",
      "interface GuardBase { watcher_id: number }\nexport interface GuardChild extends GuardBase {}\n\n"
    );
    expect(runGuard()).toBe(1);
  });

  it("fails on a banned key in an inline method parameter type", () => {
    mutate(
      NAMESPACE_FILE,
      "export interface",
      "export interface GuardFixtureNamespace {\n  run(input: { watcher_id: number }): Promise<void>;\n}\n\n"
    );
    expect(runGuard()).toBe(1);
  });
});
