import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const mac = join(root, "packages/owletto/apps/mac");
const entitlements = join(mac, "Owletto/Owletto.entitlements");
const signingPaths = [
  "scripts/build-owletto-mac.sh",
  ".github/workflows/mac-release.yml",
].flatMap((path) => {
  const commands = [
    ...readFileSync(join(root, path), "utf8").matchAll(
      /^[\t ]*codesign\b(?:[^\n]*\\\n)*[^\n]*"\$APP"[\t ]*$/gm
    ),
  ];
  return commands
    .filter(
      ([command]) =>
        !command.includes("--verify") && !command.includes("--deep --sign")
    )
    .map(([command], index) => ({
      name: `${path} app signature ${index + 1}`,
      command,
    }));
});

// Execute the actual final signing commands, with only the signing identity
// replaced. A signature can pass codesign --verify while losing permissions.
describe.skipIf(process.platform !== "darwin")(
  "Mac app signing entitlements",
  () => {
    let work: string;
    let app: string;
    beforeAll(() => {
      work = mkdtempSync(join(tmpdir(), "lobu-app-signing-"));
      app = join(work, "App with spaces.app");
      mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
      writeFileSync(
        join(app, "Contents/Info.plist"),
        '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.example.signing</string><key>CFBundleExecutable</key><string>fixture</string></dict></plist>'
      );
      writeFileSync(join(work, "fixture.c"), "int main(void) { return 0; }\n");
      execFileSync("clang", [
        join(work, "fixture.c"),
        "-o",
        join(app, "Contents/MacOS/fixture"),
      ]);
      // First clang run on a loaded macOS runner can exceed bun's 5s default.
    }, 60_000);
    afterAll(() => rmSync(work, { recursive: true, force: true }));

    it("covers local, signed release, and ad-hoc release paths", () => {
      expect(signingPaths).toHaveLength(3);
    });

    for (const { name, command } of signingPaths) {
      it(name, () => {
        // Start as Xcode does: with the declared entitlements already present.
        execFileSync("codesign", [
          "--force",
          "--sign",
          "-",
          "--entitlements",
          entitlements,
          app,
        ]);
        execFileSync(
          "bash",
          ["-c", `OPTS=(--force --options runtime --sign -)\n${command}`],
          {
            cwd: root,
            env: { ...process.env, APP: app, MAC: mac, ROOT: root },
          }
        );
        const result = spawnSync(
          "python3",
          [
            join(root, "scripts/verify-mac-app-entitlements.py"),
            app,
            entitlements,
          ],
          { encoding: "utf8" }
        );
        expect(result.stdout + result.stderr).toContain(
          "Mac app entitlements verified"
        );
        expect(result.status).toBe(0);
      });
    }

    it("rejects a valid signature that has lost its entitlements", () => {
      execFileSync("codesign", ["--force", "--sign", "-", app]);
      execFileSync("codesign", ["--verify", "--strict", app]);
      const result = spawnSync(
        "python3",
        [
          join(root, "scripts/verify-mac-app-entitlements.py"),
          app,
          entitlements,
        ],
        { encoding: "utf8" }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No signed entitlements");
    });
  }
);
