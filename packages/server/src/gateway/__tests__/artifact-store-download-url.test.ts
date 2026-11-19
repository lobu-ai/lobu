import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  ArtifactStorageError,
  ArtifactStore,
  MAX_ARTIFACT_BYTES,
  runArtifactBinding,
} from "../files/artifact-store.js";
import {
  type ArtifactTestEnv,
  createArtifactTestEnv,
  TEST_GATEWAY_URL,
} from "./setup.js";

describe("ArtifactStore.buildDownloadUrl", () => {
  let env: ArtifactTestEnv;

  beforeEach(() => {
    env = createArtifactTestEnv();
  });

  afterEach(() => env.cleanup());

  test("preserves a base-path prefix on the public gateway URL", () => {
    // Regression: the embedded/local gateway is mounted under `/lobu`, so the
    // worker must fetch `/lobu/api/v1/files/...`. Building the URL with
    // `new URL("/api/v1/files/...", base)` silently dropped the prefix (a
    // leading-slash path is absolute from the origin root), so the worker hit
    // `/api/v1/files/...` → 404 and inbound attachments never reached the agent.
    const url = env.artifactStore.buildDownloadUrl(
      "http://localhost:8954/lobu",
      "artifact-123",
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/lobu/api/v1/files/artifact-123");
    expect(parsed.searchParams.get("token")).toBeTruthy();
  });

  test("works for a root-mounted gateway (no path prefix)", () => {
    const url = env.artifactStore.buildDownloadUrl(
      "https://gateway.example.com",
      "artifact-456",
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/files/artifact-456");
  });

  test("tolerates a trailing slash on the base URL", () => {
    const url = env.artifactStore.buildDownloadUrl(
      "http://localhost:8954/lobu/",
      "artifact-789",
    );
    expect(new URL(url).pathname).toBe("/lobu/api/v1/files/artifact-789");
  });

  test("rejects oversized download tokens before decryption", () => {
    expect(
      env.artifactStore.validateDownloadToken(
        "x".repeat(4097),
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toEqual({ valid: false, error: "malformed" });
  });

  test("round-trips: a published artifact is served from its own URL path", async () => {
    const { artifactId, downloadUrl } = await env.artifactStore.publish({
      buffer: Buffer.from("hello world"),
      filename: "note.txt",
      contentType: "text/plain",
      publicGatewayUrl: "http://localhost:8954/lobu",
    });
    const parsed = new URL(downloadUrl);
    expect(parsed.pathname).toBe(`/lobu/api/v1/files/${artifactId}`);
    const token = parsed.searchParams.get("token");
    expect(token).toBeTruthy();
    expect(
      env.artifactStore.validateDownloadToken(token as string, artifactId)
        .valid,
    ).toBe(true);
    const read = await env.artifactStore.read(artifactId);
    expect(read?.metadata.filename).toBe("note.txt");
  });

  test("enforces immutable internal bindings and supports cleanup", async () => {
    const binding = runArtifactBinding(42);
    const { artifactId } = await env.artifactStore.publish({
      buffer: Buffer.from("bound"),
      filename: "bound.txt",
      contentType: "text/plain",
      publicGatewayUrl: "http://localhost:8954/lobu",
      binding,
    });

    expect(await env.artifactStore.read(artifactId, { binding })).toBeTruthy();
    expect(
      await env.artifactStore.read(artifactId, {
        binding: runArtifactBinding(43),
      }),
    ).toBeNull();

    await env.artifactStore.delete(artifactId);
    expect(await env.artifactStore.read(artifactId)).toBeNull();
  });

  test("carries the binding inside the token so the download route can enforce it", async () => {
    const binding = runArtifactBinding(42);
    const { artifactId } = await env.artifactStore.publish({
      buffer: Buffer.from("bound"),
      filename: "bound.txt",
      contentType: "text/plain",
      publicGatewayUrl: TEST_GATEWAY_URL,
      binding,
    });

    const token = new URL(
      env.artifactStore.buildDownloadUrl(
        TEST_GATEWAY_URL,
        artifactId,
        undefined,
        binding,
      ),
    ).searchParams.get("token") as string;

    const validation = env.artifactStore.validateDownloadToken(
      token,
      artifactId,
    );
    expect(validation.valid).toBe(true);
    expect(validation.binding).toBe(binding);
  });

  test("a bound token cannot be redeemed against another resource's artifact", async () => {
    // The grafting attack the binding exists to stop: an id belonging to one
    // Lobu resource, re-signed under the binding of a resource the caller can
    // read. The mint side never touches the filesystem, so this is the only
    // place the mismatch can be caught.
    const { artifactId } = await env.artifactStore.publish({
      buffer: Buffer.from("someone else's bytes"),
      filename: "victim.txt",
      publicGatewayUrl: TEST_GATEWAY_URL,
      binding: runArtifactBinding(1),
    });

    const attackerBinding = runArtifactBinding(2);
    const token = new URL(
      env.artifactStore.buildDownloadUrl(
        TEST_GATEWAY_URL,
        artifactId,
        undefined,
        attackerBinding,
      ),
    ).searchParams.get("token") as string;

    const validation = env.artifactStore.validateDownloadToken(
      token,
      artifactId,
    );
    // The token itself is well-formed — only the binding check refuses it.
    expect(validation.valid).toBe(true);
    expect(validation.binding).toBe(attackerBinding);
    expect(
      await env.artifactStore.read(artifactId, {
        binding: validation.binding,
      }),
    ).toBeNull();
  });

  test("an unbound token stays as permissive as it is today", async () => {
    // `resignFileRefs` mints unbound tokens from transcript text; changing
    // their semantics would break agent-history downloads.
    const { artifactId } = await env.artifactStore.publish({
      buffer: Buffer.from("unbound"),
      filename: "u.txt",
      publicGatewayUrl: TEST_GATEWAY_URL,
      binding: runArtifactBinding(7),
    });

    const token = new URL(
      env.artifactStore.buildDownloadUrl(TEST_GATEWAY_URL, artifactId),
    ).searchParams.get("token") as string;

    const validation = env.artifactStore.validateDownloadToken(
      token,
      artifactId,
    );
    expect(validation.valid).toBe(true);
    expect(validation.binding).toBeUndefined();
    expect(await env.artifactStore.read(artifactId)).toBeTruthy();
  });
});

describe("ArtifactStore durable filesystem backend", () => {
  let env: ArtifactTestEnv;

  beforeEach(() => {
    env = createArtifactTestEnv();
  });

  afterEach(() => env.cleanup());

  test("fails closed when production has no durable artifacts directory", () => {
    const previousEnvironment = process.env.ENVIRONMENT;
    const previousArtifactsDir = process.env.LOBU_ARTIFACTS_DIR;
    try {
      process.env.ENVIRONMENT = "production";
      delete process.env.LOBU_ARTIFACTS_DIR;
      expect(() => new ArtifactStore()).toThrow(
        "Production artifact storage requires LOBU_ARTIFACTS_DIR on a durable mounted filesystem",
      );
    } finally {
      if (previousEnvironment === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = previousEnvironment;
      if (previousArtifactsDir === undefined)
        delete process.env.LOBU_ARTIFACTS_DIR;
      else process.env.LOBU_ARTIFACTS_DIR = previousArtifactsDir;
    }
  });

  test("shares verified private artifacts across store instances", async () => {
    const writer = new ArtifactStore(env.artifactsDir);
    const reader = new ArtifactStore(env.artifactsDir);
    const binding = runArtifactBinding(314);
    const bytes = Buffer.from("shared-image-bytes");

    const published = await writer.publish({
      buffer: bytes,
      filename: "mémory photo.webp",
      contentType: "image/webp",
      publicGatewayUrl: "https://lobu.example.com",
      binding,
    });

    expect(
      await reader.read(published.artifactId, {
        binding,
        maxBytes: bytes.length - 1,
      }),
    ).toBeNull();
    expect(
      await reader.read(published.artifactId, {
        binding: runArtifactBinding(315),
      }),
    ).toBeNull();

    const stored = await reader.read(published.artifactId, { binding });
    expect(stored?.metadata).toEqual(
      expect.objectContaining({
        filename: "mémory photo.webp",
        contentType: "image/webp",
        size: bytes.length,
        binding,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(stored?.bytes).toEqual(bytes);

    await writer.delete(published.artifactId);
    expect(await reader.read(published.artifactId)).toBeNull();
  });

  test("rejects artifacts larger than the bounded read contract", async () => {
    await expect(
      env.artifactStore.publish({
        buffer: Buffer.alloc(MAX_ARTIFACT_BYTES + 1),
        filename: "too-large.bin",
        publicGatewayUrl: "https://lobu.example.com",
      }),
    ).rejects.toThrow(
      `Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte storage limit`,
    );
    expect(await fs.readdir(env.artifactsDir)).toEqual([]);
  });

  test("rejects metadata without the required checksum", async () => {
    const published = await env.artifactStore.publish({
      buffer: Buffer.from("verified-bytes"),
      filename: "verified.txt",
      publicGatewayUrl: "https://lobu.example.com",
      binding: runArtifactBinding(314),
    });
    const metadataPath = join(
      env.artifactsDir,
      published.artifactId,
      "metadata.json",
    );
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    delete metadata.sha256;
    await fs.writeFile(metadataPath, JSON.stringify(metadata));

    expect(await env.artifactStore.read(published.artifactId)).toBeNull();
  });

  test("keeps reserved metadata filenames separate from payload bytes", async () => {
    const bytes = Buffer.from("not artifact metadata");
    const published = await env.artifactStore.publish({
      buffer: bytes,
      filename: "metadata.json",
      contentType: "application/json",
      publicGatewayUrl: "https://lobu.example.com",
    });

    const stored = await env.artifactStore.read(published.artifactId);
    expect(stored?.metadata.filename).toBe("metadata.json");
    expect(stored?.bytes).toEqual(bytes);
  });

  test("rejects artifact ids that can escape the configured directory", async () => {
    expect(await env.artifactStore.read("../outside")).toBeNull();
    await expect(
      env.artifactStore.delete("../outside"),
    ).resolves.toBeUndefined();
  });

  test("rejects oversized metadata before parsing it", async () => {
    const published = await env.artifactStore.publish({
      buffer: Buffer.from("small"),
      filename: "small.txt",
      publicGatewayUrl: "https://lobu.example.com",
    });
    await fs.writeFile(
      join(env.artifactsDir, published.artifactId, "metadata.json"),
      JSON.stringify({
        artifactId: published.artifactId,
        filename: "x".repeat(128 * 1024),
        contentType: "text/plain",
        size: 5,
        createdAt: Date.now(),
        sha256: createHash("sha256").update("small").digest("hex"),
      }),
    );

    expect(await env.artifactStore.read(published.artifactId)).toBeNull();
  });

  test("does not follow a replacement symlink even when bytes match", async () => {
    const bytes = Buffer.from("same-secret-bytes");
    const published = await env.artifactStore.publish({
      buffer: bytes,
      filename: "safe.txt",
      publicGatewayUrl: "https://lobu.example.com",
    });
    const outside = join(env.artifactsDir, "outside-secret");
    await fs.writeFile(outside, bytes);
    const payload = join(env.artifactsDir, published.artifactId, "content");
    await fs.rm(payload);
    await fs.symlink(outside, payload);

    expect(await env.artifactStore.read(published.artifactId)).toBeNull();
  });

  test("propagates retained-storage I/O failures instead of reporting missing", async () => {
    const published = await env.artifactStore.publish({
      buffer: Buffer.from("still-present"),
      filename: "present.txt",
      publicGatewayUrl: "https://lobu.example.com",
    });
    const realOpen = fs.open;
    const openSpy = spyOn(fs, "open").mockImplementation(
      async (target, ...args) => {
        if (String(target).endsWith("/content")) {
          const error = new Error("injected mount failure") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
        return realOpen(target, ...args);
      },
    );

    try {
      const read = env.artifactStore.read(published.artifactId);
      await expect(read).rejects.toBeInstanceOf(ArtifactStorageError);
      await expect(read).rejects.toMatchObject({
        code: "ARTIFACT_STORAGE_UNAVAILABLE",
      });
    } finally {
      openSpy.mockRestore();
    }
  });

  test("does not delete a pre-existing directory when publication collides", async () => {
    const realMkdir = fs.mkdir;
    let collidedDir: string | undefined;
    const mkdirSpy = spyOn(fs, "mkdir").mockImplementation(
      async (target, options) => {
        const targetPath = String(target);
        if (/\/[0-9a-f-]{36}$/i.test(targetPath)) {
          collidedDir = targetPath;
          await realMkdir(target, options);
          await fs.writeFile(join(targetPath, "committed-marker"), "keep");
          const collision = new Error("injected UUID collision") as NodeJS.ErrnoException;
          collision.code = "EEXIST";
          throw collision;
        }
        return realMkdir(target, options);
      },
    );

    try {
      await expect(
        env.artifactStore.publish({
          buffer: Buffer.from("must-not-replace"),
          filename: "collision.bin",
          publicGatewayUrl: "https://lobu.example.com",
        }),
      ).rejects.toBeInstanceOf(ArtifactStorageError);
    } finally {
      mkdirSpy.mockRestore();
    }

    expect(collidedDir).toBeDefined();
    expect(await fs.readFile(join(collidedDir!, "committed-marker"), "utf8")).toBe(
      "keep",
    );
  });

  test("keeps partial-publication failures on the typed storage contract", async () => {
    const realOpen = fs.open;
    const realRm = fs.rm;
    const openSpy = spyOn(fs, "open").mockImplementation(
      async (target, ...args) => {
        if (String(target).endsWith("/content")) {
          throw new Error("injected publication failure");
        }
        return realOpen(target, ...args);
      },
    );
    const rmSpy = spyOn(fs, "rm").mockImplementation(
      async (target, options) => {
        if (String(target).includes(`${join(env.artifactsDir, ".trash")}/`)) {
          throw new Error("injected quarantine cleanup failure");
        }
        return realRm(target, options);
      },
    );

    try {
      const publication = env.artifactStore.publish({
        buffer: Buffer.from("partial"),
        filename: "partial.bin",
        publicGatewayUrl: "https://lobu.example.com",
      });
      await expect(publication).rejects.toBeInstanceOf(ArtifactStorageError);
      await expect(publication).rejects.toMatchObject({
        code: "ARTIFACT_STORAGE_UNAVAILABLE",
      });
      await expect(publication).rejects.not.toThrow(env.artifactsDir);
    } finally {
      openSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  test("quarantines a failed delete and drains the leftover before another publish", async () => {
    const published = await env.artifactStore.publish({
      buffer: Buffer.from("abandoned"),
      filename: "abandoned.bin",
      publicGatewayUrl: "https://lobu.example.com",
    });
    const realRm = fs.rm;
    let failQuarantinedRemoval = true;
    const rmSpy = spyOn(fs, "rm").mockImplementation(
      async (target, options) => {
        if (
          failQuarantinedRemoval &&
          String(target).includes(`${join(env.artifactsDir, ".trash")}/`)
        ) {
          failQuarantinedRemoval = false;
          throw new Error("injected retained-PVC removal failure");
        }
        return realRm(target, options);
      },
    );

    try {
      const deletion = env.artifactStore.delete(published.artifactId);
      await expect(deletion).rejects.toBeInstanceOf(ArtifactStorageError);
      await expect(deletion).rejects.toMatchObject({
        code: "ARTIFACT_STORAGE_UNAVAILABLE",
      });
      await expect(deletion).rejects.not.toThrow(env.artifactsDir);
    } finally {
      rmSpy.mockRestore();
    }
    expect(await env.artifactStore.read(published.artifactId)).toBeNull();
    const trashDir = join(env.artifactsDir, ".trash");
    const [quarantined] = await fs.readdir(trashDir);
    expect(quarantined).toContain(published.artifactId);

    // A retained PVC has nothing else to reclaim the leftover. Publication
    // cannot continue while known uncommitted bytes remain abandoned.
    const next = await env.artifactStore.publish({
      buffer: Buffer.from("next"),
      filename: "next.bin",
      publicGatewayUrl: "https://lobu.example.com",
    });
    expect(await fs.readdir(trashDir)).toEqual([]);

    await env.artifactStore.delete(next.artifactId);
    expect(await fs.readdir(trashDir)).toEqual([]);
  });

  test("fails closed when a quarantined orphan still cannot be removed", async () => {
    const published = await env.artifactStore.publish({
      buffer: Buffer.from("abandoned"),
      filename: "abandoned.bin",
      publicGatewayUrl: "https://lobu.example.com",
    });
    const realRm = fs.rm;
    const rmSpy = spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes(`${join(env.artifactsDir, ".trash")}/`)) {
        throw new Error("retained PVC remains unavailable");
      }
      return realRm(target, options);
    });

    try {
      const deletion = env.artifactStore.delete(published.artifactId);
      await expect(deletion).rejects.toBeInstanceOf(ArtifactStorageError);
      await expect(deletion).rejects.not.toThrow(env.artifactsDir);
      const publication = env.artifactStore.publish({
        buffer: Buffer.from("must-not-publish"),
        filename: "blocked.bin",
        publicGatewayUrl: "https://lobu.example.com",
      });
      await expect(publication).rejects.toBeInstanceOf(ArtifactStorageError);
      await expect(publication).rejects.not.toThrow(env.artifactsDir);
    } finally {
      rmSpy.mockRestore();
    }

    expect(await fs.readdir(join(env.artifactsDir, ".trash"))).toHaveLength(1);
  });

  test("replicas sweeping the shared volume at once delete each expired artifact once", async () => {
    const replicas = [
      new ArtifactStore(env.artifactsDir),
      new ArtifactStore(env.artifactsDir),
    ];
    const publish = (retainMs?: number) =>
      replicas[0]!.publish({
        buffer: Buffer.from("source-bytes"),
        filename: "notice.pdf",
        publicGatewayUrl: "https://lobu.example.com",
        retainMs,
      });
    const due = await Promise.all([publish(1_000), publish(1_000)]);
    const later = await publish(60_000);
    const kept = await publish();
    const now = Date.now() + 1_000;

    const results = await Promise.all(
      replicas.map((replica) => replica.sweepExpired(now)),
    );

    expect(results.reduce((sum, result) => sum + result.deleted, 0)).toBeGreaterThanOrEqual(2);
    const entries = await fs.readdir(env.artifactsDir);
    for (const { artifactId } of due) expect(entries).not.toContain(artifactId);
    expect(entries).toContain(later.artifactId);
    expect(entries).toContain(kept.artifactId);
    expect(await fs.readdir(join(env.artifactsDir, ".expiring"))).toHaveLength(1);
    expect(await fs.readdir(join(env.artifactsDir, ".trash"))).toEqual([]);
  });
});
