/**
 * Integration test: the production server serves every file type the web app
 * build emits with a real Content-Type, never the `application/octet-stream`
 * fallback.
 *
 * Browsers refuse a module script or module worker whose Content-Type is not a
 * JavaScript type. Vite emits pdf.js's worker as `.mjs`; served as
 * `application/octet-stream`, the worker and pdf.js's `import()` fallback both
 * failed, so every PDF preview read "This file could not be shown as a PDF."
 * while dev (served by Vite) worked.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { __resetWebDistDirectoryForTests, app } from '../../../index';

/** Every extension `packages/owletto` writes into its dist, with the type a browser needs. */
const BUILT_ASSETS: Array<[file: string, mediaType: string]> = [
  ['assets/index-abc.js', 'application/javascript'],
  ['assets/pdf.worker.min-abc.mjs', 'application/javascript'],
  ['assets/index-abc.css', 'text/css'],
  ['assets/index-abc.js.map', 'application/json'],
  ['assets/font-abc.woff2', 'font/woff2'],
  ['favicon.ico', 'image/x-icon'],
  ['icon.png', 'image/png'],
  ['logo.svg', 'image/svg+xml'],
  ['site.webmanifest', 'application/manifest+json'],
];

describe('built web app assets', () => {
  let distDir: string;
  const previousDistDir = process.env.WEB_DIST_DIR;

  beforeAll(async () => {
    distDir = await mkdtemp(path.join(tmpdir(), 'built-app-assets-'));
    await mkdir(path.join(distDir, 'assets'));
    await writeFile(path.join(distDir, 'index.html'), '<html><head></head><body></body></html>');
    for (const [file] of BUILT_ASSETS) await writeFile(path.join(distDir, file), 'x');
    process.env.WEB_DIST_DIR = distDir;
    __resetWebDistDirectoryForTests();
  });

  afterAll(async () => {
    if (previousDistDir === undefined) delete process.env.WEB_DIST_DIR;
    else process.env.WEB_DIST_DIR = previousDistDir;
    __resetWebDistDirectoryForTests();
    await rm(distDir, { recursive: true, force: true });
  });

  it.each(BUILT_ASSETS)('serves %s as %s', async (file, mediaType) => {
    const response = await app.request(`http://localhost/${file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.split(';')[0]).toBe(mediaType);
  });
});
