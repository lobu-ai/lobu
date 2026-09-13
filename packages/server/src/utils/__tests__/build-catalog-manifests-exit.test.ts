import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const REPO_ROOT = resolve(import.meta.dir, '../../../../..');
const GENERATOR = join(REPO_ROOT, 'packages/server/scripts/build-catalog-manifests.ts');
const EXIT_DEADLINE_MS = 20_000;

type Manifest = {
  version?: unknown;
  kind?: unknown;
  entries?: unknown;
};

async function readManifest(outDir: string, kind: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(outDir, `${kind}.json`), 'utf8')) as Manifest;
}

describe('catalog manifest build process', () => {
  test(
    'generates valid manifests and exits without retaining metadata deadlines',
    async () => {
      const outDir = await mkdtemp(join(tmpdir(), 'lobu-catalog-build-'));
      let deadline: ReturnType<typeof setTimeout> | undefined;

      try {
        const child = Bun.spawn([process.execPath, GENERATOR], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            LOBU_CATALOG_BUILD_OUT_DIR: outDir,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const stdoutPromise = new Response(child.stdout).text();
        const stderrPromise = new Response(child.stderr).text();

        const outcome = await Promise.race([
          child.exited.then((exitCode) => ({ kind: 'exit' as const, exitCode })),
          new Promise<{ kind: 'timeout' }>((finish) => {
            deadline = setTimeout(() => finish({ kind: 'timeout' }), EXIT_DEADLINE_MS);
          }),
        ]);
        if (deadline) clearTimeout(deadline);

        if (outcome.kind === 'timeout') {
          child.kill('SIGKILL');
          await child.exited;
          throw new Error(
            `Catalog generator did not exit within ${EXIT_DEADLINE_MS}ms\n` +
              `stdout:\n${await stdoutPromise}\nstderr:\n${await stderrPromise}`
          );
        }

        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        expect(outcome.exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
        expect(stdout).toContain('catalog manifests:');

        for (const kind of ['connectors', 'skills', 'automations']) {
          const manifest = await readManifest(outDir, kind);
          expect(manifest.version).toBe(1);
          expect(manifest.kind).toBe(kind);
          expect(Array.isArray(manifest.entries)).toBe(true);
          if (!Array.isArray(manifest.entries)) {
            throw new Error(`${kind}.json entries must be an array`);
          }
          expect(manifest.entries.length).toBeGreaterThan(0);
          expect(JSON.stringify(manifest).includes(REPO_ROOT)).toBe(false);
          if (kind === 'connectors') {
            for (const entry of manifest.entries) {
              expect(entry.detail.source_uri).toBeUndefined();
              expect(entry.detail.source_path).toMatch(/^[^/\\][^:]*\.ts$/);
              expect(entry.detail.source_path.split('/')).not.toContain('..');
            }
          }
        }
      } finally {
        if (deadline) clearTimeout(deadline);
        await rm(outDir, { recursive: true, force: true });
      }
    },
    { timeout: EXIT_DEADLINE_MS + 10_000 }
  );
});
