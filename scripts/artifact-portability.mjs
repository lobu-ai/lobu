import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";

/** Reject build-machine locations in the actual staged package, before pack. */
export function assertPortableArtifact(
  directory,
  buildRoot,
  buildHome = homedir()
) {
  const roots = new Set([resolve(buildRoot), resolve(buildHome)]);
  if (existsSync(buildRoot)) roots.add(realpathSync(buildRoot));
  const markers = [...roots].flatMap((root) => [
    root,
    pathToFileURL(root).href,
    JSON.stringify(root).slice(1, -1),
  ]);
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (
        /(?:^|\/)(?:__tests__|__fixtures__|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
          relative(directory, path).replaceAll("\\", "/")
        )
      )
        continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const bytes = readFileSync(path);
        // File URLs and serialized strings can encode path separators. Decode
        // ASCII escapes without assuming a whole JavaScript bundle is a URL.
        const normalized = bytes
          .toString("utf8")
          .replace(/%([0-9a-f]{2})/gi, (_, hex) =>
            String.fromCharCode(Number.parseInt(hex, 16))
          )
          .replace(/\\(?:u00|x)([0-9a-f]{2})/gi, (_, hex) =>
            String.fromCharCode(Number.parseInt(hex, 16))
          )
          .replace(/\\\//g, "/")
          .replace(/\\+/g, "/");
        if (
          markers.some(
            (marker) =>
              bytes.includes(marker) ||
              normalized.includes(marker.replaceAll("\\", "/"))
          ) ||
          /(?:^|[\s"'`([{=:])(?:file:\/\/(?:localhost)?)?\/Users\/[^/\r\n"'`<>]+(?:\/|(?=[\s"'`),;]|$))/m.test(
            normalized
          ) ||
          /(?:^|[\s"'`([{=:])(?:file:\/\/\/)?[a-z]:\/(?:Users|Documents and Settings)\/[^/\r\n"'`<>]+(?:\/|(?=[\s"'`),;]|$))/im.test(
            normalized
          ) ||
          /\/home\/runner\/work\//.test(normalized)
        ) {
          throw new Error(
            `Build-machine path leaked into artifact: ${relative(directory, path)}`
          );
        }
      }
    }
  }
  visit(directory);

  // Builtin catalog metadata is portable even when it came from an earlier
  // build directory. Custom user catalogs are not part of release artifacts.
  const catalogPath = join(directory, "dist/catalogs/connectors.json");
  if (!existsSync(catalogPath)) return;
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  for (const entry of catalog.entries) {
    const source = entry.detail?.source_path;
    if (
      entry.detail?.source_uri !== undefined ||
      typeof source !== "string" ||
      !source ||
      source.includes("\\") ||
      source.includes(":") ||
      source.split("/").includes("..") ||
      source.startsWith("/") ||
      win32.isAbsolute(source)
    ) {
      throw new Error(
        `Non-portable builtin catalog source for ${entry.id}: retain only a relative source_path`
      );
    }
  }
}
