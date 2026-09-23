import { type Static, Type } from "@sinclair/typebox";

export const SOURCE_MAX_BYTES = 1_000_000;
const MAX_FILES = 128;

/** Paths are relative to the author's project, never a build machine. */
export const SourceFilesSchema = Type.Object(
  {
    entrypoint: Type.String({ minLength: 1, maxLength: 240 }),
    files: Type.Record(Type.String(), Type.String(), {
      maxProperties: MAX_FILES,
    }),
  },
  {
    description:
      "Author files consumed by the build, keyed by portable project-relative paths. entrypoint identifies the file matching source_code. Never include secrets, machine paths, node_modules, or resolved credentials.",
  }
);
export type SourceFiles = Static<typeof SourceFilesSchema>;
export const SourceDependenciesSchema = Type.Record(
  Type.String(),
  Type.String(),
  {
    maxProperties: MAX_FILES,
    description:
      "Direct npm dependencies and their exact installed versions, captured with source_files. This is not a lockfile.",
  }
);
export type SourceDependencies = Static<typeof SourceDependenciesSchema>;

export interface RetainedSource {
  sourceFiles: SourceFiles;
  dependencies: SourceDependencies;
}

export function assertSourcePath(path: string): void {
  const parts = path.split("/");
  if (
    !path ||
    path.length > 240 ||
    /[\\:%]/.test(path) ||
    path.includes("\0") ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part === "node_modules" ||
        part === ".git" ||
        part === ".lobu" ||
        part === ".npmrc" ||
        part.startsWith(".env")
    )
  ) {
    throw new Error(`Source path must be a portable project file: ${path}`);
  }
}

/** Shared validation at capture and API boundaries. No caller can assert completeness. */
export function validateRetainedSource(
  sourceCode: string,
  sourceFiles: SourceFiles,
  dependencies: SourceDependencies
): void {
  assertSourcePath(sourceFiles.entrypoint);
  const files = Object.entries(sourceFiles.files);
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new Error(`Source must contain between 1 and ${MAX_FILES} files`);
  }
  for (const [path, contents] of files) {
    assertSourcePath(path);
    if (typeof contents !== "string")
      throw new Error(`Source file must be text: ${path}`);
  }
  if (
    !Object.keys(sourceFiles.files).includes(sourceFiles.entrypoint) ||
    sourceFiles.files[sourceFiles.entrypoint] !== sourceCode
  ) {
    throw new Error("Source entrypoint must match source_code exactly");
  }
  const packages = Object.entries(dependencies);
  if (packages.length > MAX_FILES)
    throw new Error("Too many source dependencies");
  for (const [name, version] of packages) {
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    ) {
      throw new Error(
        `Source dependency requires a package name and exact version: ${name}`
      );
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify({ sourceFiles, dependencies }))
      .length > SOURCE_MAX_BYTES
  ) {
    throw new Error(`Source files exceed ${SOURCE_MAX_BYTES} bytes`);
  }
}
