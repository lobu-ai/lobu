import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  ingestInputFiles,
  inputArtifactId,
  inputFileBinding,
} from "../files/input-files.js";
import { createArtifactTestEnv, TEST_GATEWAY_URL, type ArtifactTestEnv } from "./setup.js";

const owner = { isAuthenticated: true, organizationId: "org-files-test", userId: "user-files-test" };

describe("required input attachments", () => {
  let env: ArtifactTestEnv;
  beforeEach(() => { env = createArtifactTestEnv(); });
  afterEach(() => env.cleanup());

  test("accepts multipart Blob bytes and returns a reusable scoped reference", async () => {
    const [file] = await ingestInputFiles([{
      name: "photo.png", mimeType: "image/png", data: new Blob(["image-bytes"]),
    }], owner, env.artifactStore, TEST_GATEWAY_URL);
    const id = inputArtifactId(file)!;
    const binding = inputFileBinding(owner);
    expect(file?.sha256).toBe(createHash("sha256").update("image-bytes").digest("hex"));
    expect(JSON.stringify(file)).not.toContain("token=");
    expect((await env.artifactStore.read(id, { binding }))?.bytes.toString()).toBe("image-bytes");
    for (const other of [
      { ...owner, userId: "other-user-test" },
      { ...owner, organizationId: "other-org-test" },
      { ...owner, agentId: "agent-files-test" },
    ]) {
      expect(await env.artifactStore.read(id, { binding: inputFileBinding(other) })).toBeNull();
    }
  });

  test("removes already stored files when a later required attachment fails", async () => {
    const published = spyOn(env.artifactStore, "publish");
    await expect(ingestInputFiles([
      { name: "good.png", mimeType: "image/png", data: Buffer.from("good") },
      { name: "missing.png", mimeType: "image/png", fetchData: async () => { throw new Error("source expired"); } },
    ], owner, env.artifactStore, TEST_GATEWAY_URL)).rejects.toThrow("source expired");
    const artifact = await published.mock.results[0]!.value;
    expect(await env.artifactStore.inspect(artifact.artifactId)).toBeNull();
  });
});
