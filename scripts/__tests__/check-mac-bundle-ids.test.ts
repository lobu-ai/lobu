import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// @ts-expect-error — plain .mjs gate, no type declarations by design.
import {
  checkBundleIds,
  parseBundleIdsByConfiguration,
} from "../check-mac-bundle-ids.mjs";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PBXPROJ = join(
  REPO_ROOT,
  "packages/owletto/apps/mac/Owletto.xcodeproj/project.pbxproj"
);
const owlettoSubmoduleStubbed =
  process.env.OWLETTO_SUBMODULE_STUBBED === "true";

/** A minimal pbxproj shaped like the real one: settings, then the block's name. */
function pbxproj(configs: Array<{ name: string; bundleId?: string }>) {
  return configs
    .map(
      ({ name, bundleId }, index) => `
\t\tBA000000000000000000000${index + 1} /* ${name} */ = {
\t\t\tisa = XCBuildConfiguration;
\t\t\tbuildSettings = {
\t\t\t\tCODE_SIGN_STYLE = Automatic;${
        bundleId ? `\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = ${bundleId};` : ""
      }
\t\t\t};
\t\t\tname = ${name};
\t\t};`
    )
    .join("\n");
}

describe("check-mac-bundle-ids", () => {
  it.skipIf(owlettoSubmoduleStubbed)(
    "accepts the real checked-in pbxproj",
    () => {
      expect(checkBundleIds(readFileSync(PBXPROJ, "utf8"))).toEqual([]);
    }
  );

  // Guard the guard: if this ever returns nothing, every `toEqual([])` above
  // and below passes vacuously.
  it.skipIf(owlettoSubmoduleStubbed)(
    "actually finds an identity in the real pbxproj",
    () => {
      const found = parseBundleIdsByConfiguration(
        readFileSync(PBXPROJ, "utf8")
      );
      expect(found.length).toBeGreaterThan(0);
      expect(
        found.some(
          (e: { configuration: string }) => e.configuration === "Release"
        )
      ).toBe(true);
    }
  );

  it("accepts Release pinned with a build-scoped Debug identity", () => {
    const source = pbxproj([
      { name: "Debug", bundleId: "com.owletto.mac.debug" },
      { name: "Release", bundleId: "com.owletto.mac" },
    ]);
    expect(parseBundleIdsByConfiguration(source)).toEqual([
      { configuration: "Debug", bundleId: "com.owletto.mac.debug" },
      { configuration: "Release", bundleId: "com.owletto.mac" },
    ]);
    expect(checkBundleIds(source)).toEqual([]);
  });

  it("accepts both configurations on the release identity", () => {
    expect(
      checkBundleIds(
        pbxproj([
          { name: "Debug", bundleId: "com.owletto.mac" },
          { name: "Release", bundleId: "com.owletto.mac" },
        ])
      )
    ).toEqual([]);
  });

  // The case a set-of-distinct-values check structurally cannot catch: both
  // identities are present, so the set is right, but they are on the wrong
  // configurations and the release DMG would ship as the debug app.
  it("rejects swapped Release and Debug identities", () => {
    const problems = checkBundleIds(
      pbxproj([
        { name: "Debug", bundleId: "com.owletto.mac" },
        { name: "Release", bundleId: "com.owletto.mac.debug" },
      ])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "Release PRODUCT_BUNDLE_IDENTIFIER is 'com.owletto.mac.debug'"
    );
  });

  it("rejects an unrelated Release identity", () => {
    const problems = checkBundleIds(
      pbxproj([{ name: "Release", bundleId: "com.example.other" }])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("breaks installed-app upgrades");
  });

  it("rejects an unexpected Debug identity", () => {
    const problems = checkBundleIds(
      pbxproj([
        { name: "Debug", bundleId: "com.owletto.mac.staging" },
        { name: "Release", bundleId: "com.owletto.mac" },
      ])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(
      "Debug PRODUCT_BUNDLE_IDENTIFIER is 'com.owletto.mac.staging'"
    );
  });

  it("rejects a new configuration name rather than ignoring it", () => {
    const problems = checkBundleIds(
      pbxproj([
        { name: "Release", bundleId: "com.owletto.mac" },
        { name: "Beta", bundleId: "com.owletto.mac.beta" },
      ])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unexpected build configuration 'Beta'");
  });

  it("fails closed when the setting is absent rather than passing vacuously", () => {
    const problems = checkBundleIds(
      pbxproj([{ name: "Debug" }, { name: "Release" }])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not actually checking anything");
  });

  it("fails closed when no Release configuration sets an identity", () => {
    const problems = checkBundleIds(
      pbxproj([{ name: "Debug", bundleId: "com.owletto.mac" }])
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no Release build configuration");
  });

  // A block that sets no identity must not inherit the previous block's. The
  // `isa = XCBuildConfiguration` reset is what prevents that, and it only has
  // work to do when the preceding block never reached a `name` line to consume
  // its identity — so the fixture below is hand-built with a nameless block
  // rather than produced by pbxproj(), which always emits a name.
  it("does not leak an identity from a block that never named itself", () => {
    const source = [
      "\t\tBA0000000000000000000001 /* Release */ = {",
      "\t\t\tisa = XCBuildConfiguration;",
      "\t\t\tbuildSettings = {",
      "\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.owletto.mac.debug;",
      "\t\t\t};",
      "\t\t};",
      "\t\tBA0000000000000000000002 /* Debug */ = {",
      "\t\t\tisa = XCBuildConfiguration;",
      "\t\t\tbuildSettings = {",
      "\t\t\t\tCODE_SIGN_STYLE = Automatic;",
      "\t\t\t};",
      "\t\t\tname = Debug;",
      "\t\t};",
    ].join("\n");
    expect(parseBundleIdsByConfiguration(source)).toEqual([]);
  });

  it("does not carry an identity across configuration blocks", () => {
    expect(
      parseBundleIdsByConfiguration(
        pbxproj([
          { name: "Release", bundleId: "com.owletto.mac" },
          { name: "Debug" },
        ])
      )
    ).toEqual([{ configuration: "Release", bundleId: "com.owletto.mac" }]);
  });

  // The DMG filename the release publishes (attached asset and appcast
  // dmg-url must agree). Every user-facing Mac download link must name that
  // same file, or it 404s after the next release. Fails closed when any
  // source is missing.
  function publishedMacDmg(): string {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github/workflows/mac-release.yml"),
      "utf8"
    );
    const attachMatch = workflow.match(
      /\$\{\{\s*runner\.temp\s*\}\}\/(\S+\.dmg)/
    );
    if (!attachMatch) {
      throw new Error("release workflow attaches no DMG");
    }
    const appcastMatch = workflow.match(
      /--dmg-url "https:\/\/github\.com\/[^"]+\/releases\/download\/[^/]+\/([^"]+)"/
    );
    if (!appcastMatch) {
      throw new Error("release workflow publishes no appcast dmg-url");
    }
    expect(attachMatch[1]).toBe(appcastMatch[1]);
    return attachMatch[1];
  }

  it("keeps the README Mac download pointed at the published DMG", () => {
    const dmg = publishedMacDmg();
    const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
    const readmeMatch = readme.match(/releases\/latest\/download\/([^)\s]+)/);
    if (!readmeMatch) {
      throw new Error("README has no releases/latest/download link");
    }
    expect(readmeMatch[1]).toBe(dmg);
  });

  it("keeps the extension and catalog Mac downloads pointed at the published DMG", () => {
    const dmg = publishedMacDmg();
    const linked: Array<[string, string]> = [
      ["README.md", readFileSync(join(REPO_ROOT, "README.md"), "utf8")],
    ];
    if (!owlettoSubmoduleStubbed) {
      linked.push(
        [
          "packages/owletto/apps/chrome/sidepanel.html",
          readFileSync(
            join(REPO_ROOT, "packages/owletto/apps/chrome/sidepanel.html"),
            "utf8"
          ),
        ],
        [
          "packages/owletto/src/lib/connectors/app-catalog.tsx",
          readFileSync(
            join(
              REPO_ROOT,
              "packages/owletto/src/lib/connectors/app-catalog.tsx"
            ),
            "utf8"
          ),
        ]
      );
    }
    for (const [path, source] of linked) {
      const hrefs = [
        ...source.matchAll(/releases\/latest\/download\/([^)"'\s]+)/g),
      ].map((match) => match[1]);
      if (hrefs.length === 0) {
        throw new Error(`${path} has no Mac download link`);
      }
      for (const href of hrefs) {
        expect({ file: path, href }).toEqual({ file: path, href: dmg });
      }
    }
  });
});
