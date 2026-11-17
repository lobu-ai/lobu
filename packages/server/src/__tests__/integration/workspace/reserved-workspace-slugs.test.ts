/**
 * Integration test: a workspace can never take a slug the platform routes own.
 *
 * Server routes are registered ahead of the SPA fallback, so a workspace
 * slugged after one (`/connect`) has its root page replaced by the server's
 * response. RESERVED_PATHS is the contract, and the `org_slug_not_reserved`
 * CHECK is its only enforcement for workspace create and rename.
 */

import { RESERVED_PATHS, RESERVED_PATHS_SET } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../../index';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestOrganization } from '../../setup/test-fixtures';

describe('reserved workspace slugs', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
  });

  it('reserves every top-level server route a workspace slug could shadow', () => {
    // Only slug-shaped first segments: params, wildcards and file names
    // (`logo.png`, `.well-known`) can never be workspace slugs.
    const segments = new Set(
      app.routes
        .map((route) => route.path.split('/')[1] ?? '')
        .filter((segment) => /^[a-z0-9-]+$/.test(segment))
    );
    expect([...segments].filter((segment) => !RESERVED_PATHS_SET.has(segment)).sort()).toEqual([]);
  });

  it('enforces exactly RESERVED_PATHS in the database', async () => {
    const sql = getTestDb();
    const [row] = await sql<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'org_slug_not_reserved'
    `;
    const enforced = [...(row?.definition ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(enforced.sort()).toEqual([...RESERVED_PATHS].sort());
  });

  it.each(['connect', 'catalog', 'internal', 'memory'])('refuses a workspace slugged %s', async (slug) => {
    await expect(createTestOrganization({ name: `Reserved ${slug}`, slug })).rejects.toThrow(
      /org_slug_not_reserved/
    );
  });
});
