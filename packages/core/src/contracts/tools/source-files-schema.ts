import { Type } from "@sinclair/typebox";
import { SOURCE_MAX_FILES } from "./source-files";

/** Paths are relative to the author's project, never a build machine. */
export const SourceFilesSchema = Type.Object(
  {
    entrypoint: Type.String({ minLength: 1, maxLength: 240 }),
    files: Type.Record(Type.String(), Type.String(), {
      maxProperties: SOURCE_MAX_FILES,
    }),
  },
  {
    description:
      "Author files consumed by the build, keyed by portable project-relative paths. entrypoint identifies the file matching source_code. Never include secrets, machine paths, node_modules, or resolved credentials.",
  }
);
export const SourceDependenciesSchema = Type.Record(
  Type.String(),
  Type.String(),
  {
    maxProperties: SOURCE_MAX_FILES,
    description:
      "Direct npm dependencies and their exact installed versions, captured with source_files. This is not a lockfile.",
  }
);
