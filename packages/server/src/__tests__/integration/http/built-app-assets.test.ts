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
import { getRateLimiter, RateLimitPresets } from '../../../utils/rate-limiter';

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
  const previousTrustedProxy = process.env.TRUSTED_PROXY;

  beforeAll(async () => {
    distDir = await mkdtemp(path.join(tmpdir(), 'built-app-assets-'));
    await mkdir(path.join(distDir, 'assets'));
    await writeFile(path.join(distDir, 'index.html'), '<html><head></head><body></body></html>');
    for (const [file] of BUILT_ASSETS) await writeFile(path.join(distDir, file), 'x');
    process.env.WEB_DIST_DIR = distDir;
    process.env.TRUSTED_PROXY = '1';
    __resetWebDistDirectoryForTests();
  });

  afterAll(async () => {
    if (previousDistDir === undefined) delete process.env.WEB_DIST_DIR;
    else process.env.WEB_DIST_DIR = previousDistDir;
    if (previousTrustedProxy === undefined) delete process.env.TRUSTED_PROXY;
    else process.env.TRUSTED_PROXY = previousTrustedProxy;
    __resetWebDistDirectoryForTests();
    await rm(distDir, { recursive: true, force: true });
  });

  it.each(BUILT_ASSETS)('serves %s as %s', async (file, mediaType) => {
    const response = await app.request(`http://localhost/${file}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.split(';')[0]).toBe(mediaType);
  });

  // An asset is a file request, not an anonymous page render: a visitor who
  // has spent their public-read budget must still load the page's scripts.
  it.each(BUILT_ASSETS)('serves %s to an anonymous visitor past the page-read limit', async (file, mediaType) => {
    const clientIP = '203.0.113.9';
    const preset = RateLimitPresets.PUBLIC_READ_PER_IP_MINUTE;
    for (let i = 0; i < preset.limit; i++) {
      getRateLimiter().checkLimit(`rate:public-read:ip:${clientIP}`, preset);
    }
    const response = await app.request(`http://localhost/${file}`, {
      headers: { accept: '*/*', 'x-forwarded-for': clientIP },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.split(';')[0]).toBe(mediaType);
  });
});
