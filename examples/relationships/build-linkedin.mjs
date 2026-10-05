/**
 * From a Lobu checkout after its package build:
 *   node examples/relationships/build-linkedin.mjs <output-directory>
 *
 * Emits one URL-installable linkedin.js for the existing install form. Source
 * stays in personal-agent; nothing is published or installed by this command.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolateConnectorCompiler } from "@lobu/connector-worker/compile";
import { assertPortableArtifact } from "../../scripts/artifact-portability.mjs";

export async function buildLinkedInArtifact(
  outputDirectory,
  sourceDirectory = fileURLToPath(
    new URL("../personal-agent/", import.meta.url)
  )
) {
  const artifact =
    await createIsolateConnectorCompiler().compileConnectorArtifactFromFile(
      join(sourceDirectory, "linkedin.connector.ts"),
      sourceDirectory
    );
  const staging = await mkdtemp(join(tmpdir(), "relationships-linkedin-"));
  try {
    const filename = "linkedin.js";
    await writeFile(join(staging, filename), artifact.compiledCode);
    assertPortableArtifact(staging, sourceDirectory);
    await mkdir(outputDirectory, { recursive: true });
    const output = join(outputDirectory, filename);
    await writeFile(output, await readFile(join(staging, filename)));
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2])
    throw new Error("Usage: build-linkedin.mjs <output-directory>");
  console.log(await buildLinkedInArtifact(resolve(process.argv[2])));
}
