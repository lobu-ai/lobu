/**
 * Test setup and utilities for Gateway tests.
 *
 * Shared mocks (Queue, fetch, factories) live in @lobu/core fixtures.
 * This file re-exports them and adds gateway-specific helpers.
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../files/artifact-store.js";

export { MockMessageQueue } from "@lobu/core/testing";

/** Env vars every gateway test expects to be present. */
const mockEnvVars = {
  WORKER_STALE_TIMEOUT_MINUTES: "10",
  PUBLIC_GATEWAY_URL: "https://test-gateway.example.com",
};

export function setupTestEnv(): void {
  for (const [key, value] of Object.entries(mockEnvVars)) {
    process.env[key] = value;
  }
}

export function cleanupTestEnv(): void {
  for (const key of Object.keys(mockEnvVars)) {
    delete process.env[key];
  }
}

/**
 * Boilerplate-free `ArtifactStore` test fixture: creates a fresh on-disk
 * artifact dir, sets a deterministic ENCRYPTION_KEY for signed-URL HMAC,
 * and returns a `cleanup()` that restores the previous env + nukes the dir.
 *
 *   let env: ArtifactTestEnv;
 *   beforeEach(() => { env = createArtifactTestEnv(); });
 *   afterEach(() => env.cleanup());
 */
export const TEST_GATEWAY_URL = "https://gateway.example.com";

const TEST_ENCRYPTION_KEY = Buffer.from(
  "12345678901234567890123456789012"
).toString("base64");

export interface ArtifactTestEnv {
  artifactStore: ArtifactStore;
  artifactsDir: string;
  cleanup: () => Promise<void>;
}

export function createArtifactTestEnv(): ArtifactTestEnv {
  const previousKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  const artifactsDir = mkdtempSync(join(tmpdir(), "lobu-artifacts-test-"));
  const artifactStore = new ArtifactStore(artifactsDir);
  return {
    artifactStore,
    artifactsDir,
    cleanup: async () => {
      if (previousKey === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = previousKey;
      }
      await rm(artifactsDir, { recursive: true, force: true });
    },
  };
}
