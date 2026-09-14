import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decrypt, encrypt } from "@lobu/core";
import baseLogger from "../../utils/logger";

const logger = baseLogger.child({ module: "artifact-store" });

const DEFAULT_ARTIFACTS_DIR = path.join(os.tmpdir(), "lobu-artifacts");
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// Keep payload bytes separate from reserved metadata regardless of filename.
const ARTIFACT_PAYLOAD_FILENAME = "content";
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ARTIFACT_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ARTIFACT_METADATA_MAX_BYTES = 16 * 1024;
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const ARTIFACT_TRASH_DIRNAME = ".trash";
const DOWNLOAD_TOKEN_MAX_CHARS = 4096;

export interface StoredArtifactMetadata {
  artifactId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  sha256: string;
  /** Immutable Lobu resource identity allowed to read this artifact internally. */
  binding?: string;
}

interface PublishArtifactResult {
  artifactId: string;
  filename: string;
  size: number;
  contentType: string;
  downloadUrl: string;
  /**
   * Content hash of the stored bytes. `artifactId` is per-publication, so this
   * is the only field a caller can use to ask "are these the same bytes?"
   * across two publications of the same source attachment.
   */
  sha256: string;
}

export class ArtifactStorageError extends Error {
  readonly code = "ARTIFACT_STORAGE_UNAVAILABLE";

  constructor(operation: string, cause: unknown) {
    super(
      `Artifact storage ${operation} failed; operator intervention is required`,
      { cause },
    );
    this.name = "ArtifactStorageError";
  }
}

function storageFailure(operation: string, cause: unknown): ArtifactStorageError {
  if (cause instanceof ArtifactStorageError) return cause;
  logger.error(
    {
      operation,
      code:
        cause && typeof cause === "object" && "code" in cause
          ? String(cause.code)
          : undefined,
    },
    "Artifact storage operation failed",
  );
  return new ArtifactStorageError(operation, cause);
}

function isMissingOrUnsafe(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function sanitizeFilename(filename: string): string {
  const safe = path.basename(filename).trim();
  return safe || "download";
}

export function runArtifactBinding(runId: number): string {
  return `run:${runId}`;
}

export function eventArtifactBinding(params: {
  organizationId: string;
  connectionId?: number | null;
  feedId?: number | null;
  originId: string;
}): string {
  const sourceScope =
    params.connectionId != null
      ? `connection:${params.connectionId}`
      : params.feedId != null
        ? `feed:${params.feedId}`
        : "unscoped";
  return `event:${params.organizationId}:${sourceScope}:${params.originId}`;
}

function normalizeBaseUrl(publicGatewayUrl: string): string {
  const trimmed = publicGatewayUrl.trim();
  if (!trimmed) {
    return "http://localhost:8080";
  }
  return trimmed.replace(/\/$/, "");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function isStoredArtifactMetadata(
  value: unknown,
  artifactId: string,
): value is StoredArtifactMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const metadata = value as Record<string, unknown>;
  return (
    metadata.artifactId === artifactId &&
    typeof metadata.filename === "string" &&
    metadata.filename.length > 0 &&
    metadata.filename.length <= 1024 &&
    typeof metadata.contentType === "string" &&
    metadata.contentType.length > 0 &&
    metadata.contentType.length <= 512 &&
    typeof metadata.size === "number" &&
    Number.isSafeInteger(metadata.size) &&
    metadata.size >= 0 &&
    typeof metadata.createdAt === "number" &&
    Number.isFinite(metadata.createdAt) &&
    typeof metadata.sha256 === "string" &&
    ARTIFACT_SHA256_PATTERN.test(metadata.sha256) &&
    (metadata.binding === undefined ||
      (typeof metadata.binding === "string" && metadata.binding.length <= 2048))
  );
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    return buffer;
  } catch (error) {
    if (isMissingOrUnsafe(error)) return null;
    throw storageFailure("read", error);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writeDurableFile(
  filePath: string,
  contents: string | Buffer,
): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * fsync a directory so the entries created inside it survive a crash.
 *
 * Syncing a file only promises its CONTENTS are on disk; the link that makes it
 * findable lives in the parent directory and is durable only once that
 * directory is itself synced. Without this an unclean shutdown can leave an
 * artifact dir holding `metadata.json` but not `content`, or leave the artifact
 * dir missing entirely while both files are on the platters — exactly the
 * half-written states `read()`'s checksum and metadata checks then report as a
 * corrupt artifact.
 */
async function syncDirectoryEntry(dirPath: string): Promise<void> {
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function resolveArtifactsDir(baseDir: string | undefined): string {
  const configured = baseDir?.trim() || process.env.LOBU_ARTIFACTS_DIR?.trim();
  if (configured) return configured;
  if (process.env.ENVIRONMENT === "production") {
    throw new Error(
      "Production artifact storage requires LOBU_ARTIFACTS_DIR on a durable mounted filesystem",
    );
  }
  return DEFAULT_ARTIFACTS_DIR;
}

export class ArtifactStore {
  private readonly baseDir: string;

  constructor(
    baseDir?: string,
    private readonly defaultTtlMs = DEFAULT_TTL_MS,
  ) {
    this.baseDir = resolveArtifactsDir(baseDir);
  }

  private artifactDir(artifactId: string): string {
    return path.join(this.baseDir, artifactId);
  }

  private artifactFilePath(artifactId: string): string {
    return path.join(this.artifactDir(artifactId), ARTIFACT_PAYLOAD_FILENAME);
  }

  private metadataPath(artifactId: string): string {
    return path.join(this.artifactDir(artifactId), "metadata.json");
  }

  private async readMetadataRecord(
    artifactId: string,
  ): Promise<{ metadata: StoredArtifactMetadata; dirStat: Stats } | null> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) return null;
    let dirStat: Stats;
    try {
      dirStat = await fs.lstat(this.artifactDir(artifactId));
    } catch (error) {
      if (isMissingOrUnsafe(error)) return null;
      throw storageFailure("read", error);
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) return null;
    const raw = await readBoundedRegularFile(
      this.metadataPath(artifactId),
      ARTIFACT_METADATA_MAX_BYTES,
    );
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw.toString("utf8")) as unknown;
      if (!isStoredArtifactMetadata(parsed, artifactId)) return null;
      return { metadata: parsed, dirStat };
    } catch {
      return null;
    }
  }

  private async directoryIsUnchanged(
    artifactId: string,
    initial: Stats,
  ): Promise<boolean> {
    try {
      const final = await fs.lstat(this.artifactDir(artifactId));
      return (
        final.isDirectory() &&
        !final.isSymbolicLink() &&
        final.dev === initial.dev &&
        final.ino === initial.ino
      );
    } catch (error) {
      if (isMissingOrUnsafe(error)) return false;
      throw storageFailure("read", error);
    }
  }

  /**
   * Inside `baseDir` so the quarantine rename stays on one filesystem — the
   * configured directory is the PVC mount root, and a sibling would land on
   * the pod's ephemeral layer and fail with EXDEV. The name cannot collide
   * with an artifact directory because those are always UUIDs.
   */
  private trashDir(): string {
    return path.join(this.baseDir, ARTIFACT_TRASH_DIRNAME);
  }

  private async drainTrash(): Promise<void> {
    try {
      const trashDir = this.trashDir();
      await fs.mkdir(trashDir, { recursive: true, mode: 0o700 });
      for (const stale of await fs.readdir(trashDir)) {
        await fs.rm(path.join(trashDir, stale), {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 10,
        });
      }
    } catch (error) {
      throw storageFailure("cleanup", error);
    }
  }

  /**
   * Delete by rename-then-remove so a concurrent reader either sees the whole
   * artifact or nothing — never a directory losing its files underneath it.
   * The quarantined copy is removed immediately; one only lingers when that
   * removal fails. Every later publish drains earlier leftovers first and
   * fails closed if that is still impossible; the retained PVC has no other
   * process that can safely infer which directories are uncommitted.
   */
  private async quarantineAndDelete(artifactId: string): Promise<void> {
    const trashDir = this.trashDir();
    await fs.mkdir(trashDir, { recursive: true, mode: 0o700 });
    const source = this.artifactDir(artifactId);
    const quarantined = path.join(trashDir, `${artifactId}-${randomUUID()}`);
    try {
      await fs.rename(source, quarantined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.drainTrash();
        return;
      }
      throw storageFailure("quarantine", error);
    }
    await this.drainTrash();
  }

  async publish(params: {
    buffer: Buffer;
    filename: string;
    contentType?: string;
    publicGatewayUrl: string;
    ttlMs?: number;
    binding?: string;
  }): Promise<PublishArtifactResult> {
    if (params.buffer.length > MAX_ARTIFACT_BYTES) {
      throw new RangeError(
        `Artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte storage limit`,
      );
    }
    const artifactId = randomUUID();
    const filename = sanitizeFilename(params.filename);
    const contentType = params.contentType || "application/octet-stream";
    const createdAt = Date.now();
    const checksum = sha256(params.buffer);
    const metadata: StoredArtifactMetadata = {
      artifactId,
      filename,
      contentType,
      size: params.buffer.length,
      createdAt,
      sha256: checksum,
      ...(params.binding ? { binding: params.binding } : {}),
    };

    const dir = this.artifactDir(artifactId);
    let ownsDir = false;
    try {
      // Also creates `baseDir` itself, which the non-recursive mkdir below
      // relies on: a first publish onto an empty mount must not ENOENT.
      await this.drainTrash();
      // Exclusive: a collision on a freshly minted UUID means the directory is
      // not ours, so never adopt it.
      await fs.mkdir(dir, { recursive: false, mode: 0o700 });
      ownsDir = true;
      await writeDurableFile(this.artifactFilePath(artifactId), params.buffer);
      await writeDurableFile(
        this.metadataPath(artifactId),
        JSON.stringify(metadata, null, 2),
      );
      // Both files, then the directory that links them, then the directory that
      // links THAT — a publish that returns has survived power loss end to end.
      await syncDirectoryEntry(dir);
      await syncDirectoryEntry(this.baseDir);
    } catch (error) {
      if (ownsDir) {
        try {
          await this.quarantineAndDelete(artifactId);
        } catch (cleanupError) {
          // Message stays path-free like every other surface here: the causes
          // carry the detail, and the filesystem layout is not for callers.
          throw storageFailure(
            "publication",
            new AggregateError(
              [error, cleanupError],
              "Partial artifact directory could not be quarantined",
            ),
          );
        }
      }
      throw storageFailure("publication", error);
    }

    logger.info(
      `Published artifact ${artifactId} (${filename}, ${params.buffer.length} bytes)`,
    );

    return {
      artifactId,
      filename,
      size: params.buffer.length,
      contentType,
      downloadUrl: this.buildDownloadUrl(
        normalizeBaseUrl(params.publicGatewayUrl),
        artifactId,
        params.ttlMs,
        params.binding,
      ),
      sha256: checksum,
    };
  }

  async read(
    artifactId: string,
    options?: { binding?: string; maxBytes?: number },
  ): Promise<{ metadata: StoredArtifactMetadata; bytes: Buffer } | null> {
    const record = await this.readMetadataRecord(artifactId);
    if (!record) return null;
    const { metadata, dirStat } = record;
    if (options?.binding && metadata.binding !== options.binding) {
      return null;
    }
    const maxBytes = options?.maxBytes ?? MAX_ARTIFACT_BYTES;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      metadata.size > maxBytes
    ) {
      return null;
    }
    const bytes = await readBoundedRegularFile(
      this.artifactFilePath(artifactId),
      maxBytes,
    );
    if (
      !bytes ||
      bytes.length !== metadata.size ||
      sha256(bytes) !== metadata.sha256
    ) {
      logger.warn(`Artifact ${artifactId} failed size/checksum verification`);
      return null;
    }
    if (!(await this.directoryIsUnchanged(artifactId, dirStat))) return null;
    return { metadata, bytes };
  }

  /**
   * Validated metadata without loading the payload. Lets a caller tell
   * "too large to inline" apart from "absent", which a bounded `read` alone
   * reports identically.
   */
  async inspect(
    artifactId: string,
    options?: { binding?: string },
  ): Promise<StoredArtifactMetadata | null> {
    const record = await this.readMetadataRecord(artifactId);
    if (!record) return null;
    if (options?.binding && record.metadata.binding !== options.binding) {
      return null;
    }
    if (!(await this.directoryIsUnchanged(artifactId, record.dirStat))) {
      return null;
    }
    return record.metadata;
  }

  async delete(artifactId: string): Promise<void> {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) return;
    try {
      await this.quarantineAndDelete(artifactId);
    } catch (error) {
      throw storageFailure("cleanup", error);
    }
    logger.info(`Deleted artifact ${artifactId}`);
  }

  /**
   * A token carries the binding it was minted for so the download route can
   * enforce it without the minting side touching the filesystem. Only this
   * process can mint one (the payload is encrypted with the app key), so the
   * binding inside is as trustworthy as the artifact id beside it.
   *
   * A tokenless-ref re-sign (`resignFileRefs`) still mints unbound tokens: the
   * ids come from a transcript the caller is already authorized to read, and
   * there is no per-ref binding to carry. Unbound stays exactly as permissive
   * as it is today; bound is strictly tighter.
   */
  createDownloadToken(
    artifactId: string,
    ttlMs = this.defaultTtlMs,
    binding?: string,
  ): string {
    return encrypt(
      JSON.stringify({
        artifactId,
        exp: Date.now() + ttlMs,
        ...(binding ? { binding } : {}),
      }),
    );
  }

  validateDownloadToken(
    token: string,
    artifactId: string,
  ): {
    valid: boolean;
    error?: string;
    binding?: string;
  } {
    if (
      token.length === 0 ||
      token.length > DOWNLOAD_TOKEN_MAX_CHARS ||
      !ARTIFACT_ID_PATTERN.test(artifactId)
    ) {
      return { valid: false, error: "malformed" };
    }
    try {
      const payload = JSON.parse(decrypt(token)) as {
        artifactId?: string;
        exp?: number;
        binding?: unknown;
      };
      if (payload.artifactId !== artifactId) {
        return { valid: false, error: "artifact_mismatch" };
      }
      if (!payload.exp || Date.now() > payload.exp) {
        return { valid: false, error: "expired" };
      }
      const binding =
        typeof payload.binding === "string" && payload.binding.length > 0
          ? payload.binding
          : undefined;
      return { valid: true, ...(binding ? { binding } : {}) };
    } catch {
      return { valid: false, error: "malformed" };
    }
  }

  buildDownloadUrl(
    publicGatewayUrl: string,
    artifactId: string,
    ttlMs = this.defaultTtlMs,
    binding?: string,
  ): string {
    const baseUrl = normalizeBaseUrl(publicGatewayUrl);
    // Concatenate onto the base rather than `new URL("/api/v1/...", baseUrl)`:
    // a leading-slash path is absolute from the origin root, which silently
    // drops a base path prefix (e.g. the embedded/local gateway is mounted
    // under `/lobu`, so the worker must fetch `/lobu/api/v1/files/...`).
    const url = new URL(
      `${baseUrl}/api/v1/files/${encodeURIComponent(artifactId)}`,
    );
    url.searchParams.set(
      "token",
      this.createDownloadToken(artifactId, ttlMs, binding),
    );
    return url.toString();
  }
}
