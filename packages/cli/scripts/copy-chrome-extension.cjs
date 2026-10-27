// Copy the Lobu Chrome extension into dist/chrome-extension for `lobu browser`.
// Run by the CLI build, and by `make e2e-browser` so a worktree's browser picks
// up extension edits without rebuilding the whole CLI.
const fs = require("node:fs");
const path = require("node:path");

const cliRoot = path.join(__dirname, "..");
const source = path.join(cliRoot, "..", "owletto", "apps", "chrome");
const target = path.join(cliRoot, "dist", "chrome-extension");

function copyChromeExtension() {
  if (!fs.existsSync(source)) return false;
  fs.rmSync(target, { recursive: true, force: true });
  // Runtime files only, with the manifest `key` intact: the key pins the
  // extension id that the gateway's CORS allow-list and the pairing host expect.
  fs.cpSync(source, target, {
    recursive: true,
    filter: (srcPath) => {
      const name = path.basename(srcPath);
      return (
        !name.endsWith(".test.js") &&
        !["README.md", "build-info.json"].includes(name) &&
        !name.endsWith(".sh") &&
        !name.startsWith(".")
      );
    },
  });

  // A named browser is a profile the user created for Lobu agents, so this copy
  // declares site access as required: Chrome grants it to an unpacked extension
  // at load, with no per-site prompt. History, bookmarks, and downloads stay
  // optional because granting them advertises feeds that sync browsing data.
  const manifestPath = path.join(target, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = [
    ...new Set([...(manifest.host_permissions ?? []), "<all_urls>"]),
  ];
  manifest.optional_host_permissions = (
    manifest.optional_host_permissions ?? []
  ).filter((pattern) => pattern !== "<all_urls>");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

module.exports = { copyChromeExtension };

if (require.main === module && !copyChromeExtension()) {
  console.error(`error: no extension source at ${source}`);
  process.exitCode = 1;
}
