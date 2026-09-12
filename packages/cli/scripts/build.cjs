const fs = require("node:fs");
const path = require("node:path");

function copyDirIfExists(src, dest, filter) {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, filter });
}

// Skip internal test material (a __tests__ dir, or a *.test.* / *.spec.* file).
// cpSync skips a directory's entire subtree when the filter returns false.
function excludeTests(srcPath) {
  const segments = srcPath.split(path.sep);
  if (segments.includes("__tests__")) return false;
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path.basename(srcPath));
}

// Copy templates
copyDirIfExists("src/templates", "dist/templates");

// Copy the single bundled Lobu starter skill (includes memory guidance).
copyDirIfExists("../../skills/lobu", "dist/bundled-skills/lobu");

// Copy the concise cross-client skill used by `lobu connect`. The same source
// ships inside the Claude/Codex plugin so all supported hosts get one contract.
copyDirIfExists(
  "../../claude-plugin/skills/lobu",
  "dist/bundled-skills/lobu-connect"
);

// Copy mcp-servers.json
const jsonSrc = "src/mcp-servers.json";
const jsonDest = "dist/mcp-servers.json";
if (fs.existsSync(jsonSrc)) {
  fs.cpSync(jsonSrc, jsonDest);
}

// Copy providers.json from monorepo config
const providersSrc = "../../config/providers.json";
const providersDest = "dist/providers.json";
if (fs.existsSync(providersSrc)) {
  fs.cpSync(providersSrc, providersDest);
}

// Copy bundled connector source files next to the embedded server bundle.
// The server lists these runtime code-based connectors for picker UIs and
// compiles them on demand when a workspace installs or runs one. Only the
// runtime connector source/manifests ship — internal tests are filtered out.
copyDirIfExists("../connectors/src", "dist/connectors", excludeTests);

// The CLI carries configuration/compilation, not the server or native runtime.
// Runtime packages are generated beside (outside) the CLI's publishable dist.
async function buildRuntimeArtifacts() {
  const { bundleCompiler, buildRuntimeComponents, runtimeCatalog } =
    await import("../../../scripts/runtime-components.mjs");
  await bundleCompiler();
  fs.writeFileSync(
    "dist/runtime-components.json",
    `${JSON.stringify(runtimeCatalog(), null, 2)}\n`
  );
  if (fs.existsSync("../server/dist/server-main.bundle.mjs")) {
    await buildRuntimeComponents();
  }
}
buildRuntimeArtifacts().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
