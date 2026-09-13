import { describe, expect, it } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { getMcpTools } from "../../tools/registry";
import { RunSchema, toMcpPublicSdkScriptResult } from "../../tools/sdk_run";

describe("MCP attachment input", () => {
  it("advertises native attachment transfer on run_sdk", () => {
    const tool = getMcpTools().find((item) => item.name === "run_sdk");
    expect(tool?._meta?.["openai/fileParams"]).toEqual(["files"]);
    expect(tool?.outputSchema.properties.files).toBeDefined();
    expect(
      getMcpTools().find((item) => item.name === "query_sdk")?.outputSchema.properties.files,
    ).toBeUndefined();
    const schema = RunSchema.properties.files;
    expect(schema).toBeDefined();
    expect(schema.items.required).toEqual(["download_url", "file_id"]);
    expect(Object.keys(schema.items.properties).sort()).toEqual([
      "download_url", "file_id", "file_name", "mime_type",
    ]);
  });

  it("accepts a host attachment without requiring optional metadata", () => {
    expect(Value.Check(RunSchema, {
      script: "export default async (ctx) => ctx.files",
      files: [{ download_url: "https://files.example.test/photo", file_id: "file-example" }],
    })).toBe(true);
    expect(Value.Check(RunSchema, {
      script: "export default async (ctx) => ctx.files",
      files: [{ file_id: "file-example" }],
    })).toBe(false);
  });

  it("keeps reusable uploads in the public result when the script fails", () => {
    const files = [{ $file: 'lobu://file/00000000-0000-4000-8000-000000000001', filename: 'photo.png', content_type: 'image/png', size_bytes: 3, sha256: 'a'.repeat(64) }];
    expect(toMcpPublicSdkScriptResult({ success: false, files, error: { message: 'Script failed after upload' } })).toMatchObject({ success: false, files });
  });
});
