/**
 * Entity-type and relationship-type CRUD via the post-#348 SDK surface.
 *
 * Replaces the deleted `manage_entity_schema` integration tests. Each scenario
 * uses TestApiClient (direct handler) so we exercise real DB writes without
 * paying the HTTP/sandbox round-trip on every assertion. The MCP wire path is
 * covered separately in `mcp-auth-wire.test.ts` and `sandbox-execute.test.ts`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

describe('entity schema CRUD', () => {
  let owner: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Schema Test Org' });
    const user = await createTestUser({ email: 'schema-owner@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });
  });

  describe('entity_type', () => {
    it('creates → reads back → updates → deletes', async () => {
      await owner.entity_schema.createType({
        slug: 'lifecycle-asset',
        name: 'Asset',
        description: 'A trackable asset',
      });

      const got = (await owner.entity_schema.getType('lifecycle-asset')) as {
        entity_type?: { name: string; description?: string };
      };
      expect(got.entity_type?.name).toBe('Asset');
      expect(got.entity_type?.description).toBe('A trackable asset');

      await owner.entity_schema.updateType({
        slug: 'lifecycle-asset',
        name: 'Asset (renamed)',
      });
      const after = (await owner.entity_schema.getType('lifecycle-asset')) as {
        entity_type?: { name: string };
      };
      expect(after.entity_type?.name).toBe('Asset (renamed)');

      await owner.entity_schema.deleteType({ slug: 'lifecycle-asset' });
      const tombstone = (await owner.entity_schema.getType('lifecycle-asset')) as {
        entity_type: null | unknown;
      };
      expect(tombstone.entity_type).toBeNull();
    });

    it('round-trips a slug that needs normalizing through every entity-type verb', async () => {
      await owner.entity_schema.createType({
        slug: 'stock_movement',
        name: 'Stock Movement',
      });

      const got = (await owner.entity_schema.getType('stock_movement')) as {
        entity_type?: { slug: string; name: string };
      };
      expect(got.entity_type?.name).toBe('Stock Movement');
      expect(got.entity_type?.slug).toBe('stock-movement');

      const alias = (await owner.entity_schema.getType('stock-movement')) as {
        entity_type?: { slug: string };
      };
      expect(alias.entity_type?.slug).toBe('stock-movement');

      await owner.entity_schema.updateType({
        slug: 'stock_movement',
        name: 'Stok Fisi',
      });
      const after = (await owner.entity_schema.getType('stock-movement')) as {
        entity_type?: { name: string };
      };
      expect(after.entity_type?.name).toBe('Stok Fisi');

      const audit = (await owner.entity_schema.auditType('stock_movement')) as {
        audit_entries?: Array<{ action: string }>;
      };
      expect(audit.audit_entries?.map((entry) => entry.action)).toEqual(
        expect.arrayContaining(['create', 'update'])
      );

      await owner.entity_schema.deleteType({ slug: 'stock_movement' });
      const tombstone = (await owner.entity_schema.getType('stock-movement')) as {
        entity_type: null | unknown;
      };
      expect(tombstone.entity_type).toBeNull();
    });

    it('preserves system entity-type slugs while normalizing lookups', async () => {
      const got = (await owner.entity_schema.getType('$MEMBER')) as {
        entity_type?: { slug: string };
      };
      expect(got.entity_type?.slug).toBe('$member');
    });

    it('accepts declared jsonTemplate interactions, and event_kinds:null to clear (lobu apply)', async () => {
      // `lobu apply` sends event_kinds on every upsert: an object to declare,
      // `null` to clear. The schema must accept BOTH — a regression here halted
      // apply for every type that declares no event kinds (caught by sdk-e2e).
      await owner.entity_schema.createType({
        slug: 'deal-ek',
        name: 'Deal',
        event_kinds: {
          valuation: {
            description: 'A snapshot',
            metadataSchema: { type: 'object', properties: { amount: {} } },
            jsonTemplate: {
              type: 'card',
              children: [
                { type: 'button', props: { label: 'Refresh', onClick: '@refresh' } },
              ],
            },
            interactions: { refresh: { emits: 'valuation_requested' } },
          },
          valuation_requested: { description: 'A verified refresh request' },
        },
      });
      const got = (await owner.entity_schema.getType('deal-ek')) as {
        entity_type?: { event_kinds?: Record<string, unknown> | null };
      };
      expect(got.entity_type?.event_kinds).toMatchObject({ valuation: { description: 'A snapshot' } });

      await expect(
        owner.entity_schema.updateType({
          slug: 'deal-ek',
          event_kinds: {
            valuation: {
              jsonTemplate: { type: 'button', props: { onClick: '@refresh' } },
              interactions: { refresh: { emits: 'missing_kind' } },
            },
          },
        })
      ).rejects.toThrow(/must name another declared event kind/i);

      await expect(
        owner.entity_schema.updateType({
          slug: 'deal-ek',
          event_kinds: {
            valuation: {
              jsonTemplate: { type: 'button', props: { onClick: '@different' } },
              interactions: { refresh: { emits: 'valuation_requested' } },
            },
            valuation_requested: {},
          },
        })
      ).rejects.toThrow(/no portable @refresh button\/select handler/i);

      await expect(
        owner.entity_schema.updateType({
          slug: 'deal-ek',
          event_kinds: {
            valuation: {
              interactions: { refresh: { emits: 'valuation_requested' } },
            },
            valuation_requested: {},
          },
        })
      ).rejects.toThrow(/requires jsonTemplate/i);

      await expect(
        owner.entity_schema.updateType({
          slug: 'deal-ek',
          event_kinds: {
            valuation: {
              jsonTemplate: { type: 'button', props: { onClick: '@refresh' } },
            },
          },
        })
      ).rejects.toThrow(/interactions must declare every portable jsonTemplate action/i);

      await expect(
        owner.entity_schema.updateType({
          slug: 'deal-ek',
          event_kinds: {
            valuation: {
              jsonTemplate: {
                type: 'card',
                children: [
                  { type: 'button', props: { onClick: '@refresh' } },
                  { type: 'button', props: { onPress: '@archive' } },
                ],
              },
              interactions: { refresh: { emits: 'valuation_requested' } },
            },
            valuation_requested: {},
          },
        })
      ).rejects.toThrow(/must declare portable @archive/i);

      await expect(
        owner.entity_schema.updateType({
          slug: 'deal-ek',
          event_kinds: {
            valuation: {
              jsonTemplate: { type: 'button', props: { onClick: '@refresh' } },
              interactions: { refresh: { emits: 'toString' } },
            },
          },
        })
      ).rejects.toThrow(/must name another declared event kind/i);

      // Clearing via null must validate and wipe the column.
      await owner.entity_schema.updateType({ slug: 'deal-ek', event_kinds: null });
      const cleared = (await owner.entity_schema.getType('deal-ek')) as {
        entity_type?: { event_kinds?: Record<string, unknown> | null };
      };
      expect(cleared.entity_type?.event_kinds ?? null).toBeNull();

      await owner.entity_schema.deleteType({ slug: 'deal-ek' });
    });

    it('rejects a duplicate slug create with a coded 409', async () => {
      await owner.entity_schema.createType({ slug: 'dup-asset', name: 'Dup' });
      // `lobu apply` upserts by probing create and retrying as update ONLY on
      // this explicit duplicate signal — the code + 409 are load-bearing.
      const err = await owner.entity_schema
        .createType({ slug: 'dup-asset', name: 'Dup 2' })
        .then(() => null)
        .catch((e: unknown) => e as Error & { httpStatus?: number });
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/\[entity_type_exists\].*already exists/);
      expect(err?.httpStatus).toBe(409);
      await owner.entity_schema.deleteType({ slug: 'dup-asset' });
    });

    it('concurrent creates of the same slug: one wins, every loser gets the coded 409 (not raw 23505)', async () => {
      // The precheck SELECT is not a lock, so concurrent replicas can all pass
      // it and race the partial unique index. Fire many at once: exactly one
      // INSERT commits, and every loser must surface the SAME coded 409 the
      // sequential path emits — otherwise `lobu apply` sees a raw Postgres
      // 23505 and its probe-create-then-update path aborts. Pre-fix, the losers
      // rejected with a raw unique-violation.
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          owner.entity_schema.createType({ slug: 'race-asset', name: 'Race' })
        )
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(5);
      for (const r of rejected) {
        const e = r.reason as Error & { httpStatus?: number };
        expect(e.message).toMatch(/\[entity_type_exists\].*already exists/);
        expect(e.message).not.toMatch(/23505|duplicate key value/);
        expect(e.httpStatus).toBe(409);
      }
      await owner.entity_schema.deleteType({ slug: 'race-asset' });
    });

    it('surfaces a 422 schema-validation error with the real message (issue #1177)', async () => {
      // A non-boolean x-table-column trips [invalid_schema]; before the fix
      // this surfaced through `lobu apply` as a misleading "Entity type 'task'
      // not found" instead of the real message. Any 422 schema fault exercises
      // the same path — the cap on x-table-column count was removed, so we use
      // the surviving per-field type check here.
      const err = await owner.entity_schema
        .createType({
          slug: 'bad-schema',
          name: 'Bad Schema',
          metadata_schema: {
            type: 'object',
            properties: { a: { type: 'string', 'x-table-column': 'yes' } },
          },
        })
        .then(() => null)
        .catch((e: unknown) => e as Error & { httpStatus?: number });
      expect(err).not.toBeNull();
      expect(err?.message).toContain('[invalid_schema]');
      expect(err?.message).toContain('metadata_schema.properties.a.x-table-column must be a boolean');
      expect(err?.httpStatus).toBe(422);
      // Validation rejected the create entirely — nothing persisted, so a
      // follow-up create-after-fix is a clean create (not an update).
      const got = (await owner.entity_schema.getType('bad-schema')) as {
        entity_type: unknown;
      };
      expect(got.entity_type).toBeNull();
    });

    it('validates collection display annotations before persisting a type', async () => {
      for (const [annotation, value] of [
        ['x-facet', 'yes'],
        ['x-sidebar', 1],
        ['x-enum-labels', { active: 42 }],
      ] as const) {
        const slug = `bad-${annotation}`;
        const err = await owner.entity_schema.createType({
          slug,
          name: 'Invalid display config',
          metadata_schema: { type: 'object', properties: {
            status: { type: 'string', enum: ['active'], [annotation]: value },
          } },
        }).then(() => null).catch((e: unknown) => e as Error & { httpStatus?: number });
        expect(err?.httpStatus).toBe(422);
        expect(err?.message).toContain(`metadata_schema.properties.status.${annotation}`);
        const got = await owner.entity_schema.getType(slug) as { entity_type: unknown };
        expect(got.entity_type).toBeNull();
      }
      await owner.entity_schema.createType({
        slug: 'facet-asset', name: 'Facet asset',
        metadata_schema: { type: 'object', properties: {
          status: { type: 'string', enum: ['active'], 'x-facet': true,
            'x-sidebar': true, 'x-enum-labels': { active: 'Active assets' } },
        } },
      });
      await owner.entity_schema.deleteType({ slug: 'facet-asset' });
    });

    it('lists user-created types alongside system types', async () => {
      await owner.entity_schema.createType({ slug: 'lst-asset', name: 'Lst' });
      const list = (await owner.entity_schema.listTypes()) as {
        entity_types?: Array<{ slug: string }>;
      };
      const slugs = list.entity_types?.map((t) => t.slug) ?? [];
      expect(slugs).toContain('lst-asset');
      await owner.entity_schema.deleteType({ slug: 'lst-asset' });
    });

		it('reports list scope and can restrict results to the bound organization', async () => {
			const publicOrg = await createTestOrganization({
				name: 'Public Schema Catalog',
				visibility: 'public',
			});
			const publicOwner = await createTestUser({ email: 'public-schema-owner@test.com' });
			await addUserToOrganization(publicOwner.id, publicOrg.id, 'owner');
			const publicClient = await TestApiClient.for({
				organizationId: publicOrg.id,
				userId: publicOwner.id,
				memberRole: 'owner',
			});
			await publicClient.entity_schema.createType({
				slug: 'public-schema-only',
				name: 'Public Schema Only',
			});

			const accessible = (await owner.entity_schema.listTypes()) as {
				list_scope: string;
				entity_types: Array<{ slug: string }>;
			};
			expect(accessible.list_scope).toBe('accessible');
			expect(accessible.entity_types.map((type) => type.slug)).toContain(
				'public-schema-only'
			);

			const local = (await owner.entity_schema.listTypes({
				list_scope: 'organization',
			})) as {
				list_scope: string;
				entity_types: Array<{ slug: string }>;
			};
			expect(local.list_scope).toBe('organization');
			expect(local.entity_types.map((type) => type.slug)).not.toContain(
				'public-schema-only'
			);
		});

    it('round-trips a derived backing (sql) and reverts to stored', async () => {
      type Got = {
        entity_type?: {
          backing_sql?: string | null;
          measure_columns?: string[];
          metadata_schema?: { properties?: Record<string, Record<string, unknown>> } | null;
        };
      };

      await owner.entity_schema.createType({
        slug: 'spend-by-vendor',
        name: 'Spend by vendor',
        backing: {
          sql: 'SELECT company_id, currency, SUM(amount) AS total_spend, COUNT(DISTINCT u) AS users FROM events GROUP BY company_id, currency',
        },
      });
      const created = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(created.entity_type?.backing_sql).toContain('SUM(amount)');
      // Measure columns are classified ON READ (not persisted into metadata_schema).
      expect((created.entity_type?.measure_columns ?? []).sort()).toEqual([
        'total_spend',
        'users',
      ]);
      // No inferred annotations are persisted — metadata_schema stays as authored.
      const props = created.entity_type?.metadata_schema?.properties ?? {};
      expect(props.total_spend).toBeUndefined();

      // update the view sql → backing_sql changes, measure_columns recompute
      await owner.entity_schema.updateType({
        slug: 'spend-by-vendor',
        backing: { sql: 'SELECT company_id, AVG(amount) AS avg_spend FROM events GROUP BY company_id' },
      });
      const updated = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(updated.entity_type?.backing_sql).toContain('AVG(amount)');
      expect(updated.entity_type?.measure_columns).toEqual(['avg_spend']);

      // revert to stored: backing = null clears the view; no measure_columns.
      await owner.entity_schema.updateType({ slug: 'spend-by-vendor', backing: null });
      const reverted = (await owner.entity_schema.getType('spend-by-vendor')) as Got;
      expect(reverted.entity_type?.backing_sql ?? null).toBeNull();
      expect(reverted.entity_type?.measure_columns ?? []).toEqual([]);

      await owner.entity_schema.deleteType({ slug: 'spend-by-vendor' });
    });

    it('round-trips declared metrics_config verbatim (create → get → update → clear)', async () => {
      type Got = { entity_type?: { metrics_config?: Record<string, unknown> | null } };
      const metrics = {
        eventSets: {
          charges: {
            by: 'alias',
            field: "metadata->>'description'",
            against: 'aliases',
            where: "semantic_type='transaction'",
            dedupeKey: ["metadata->>'date'", "metadata->>'amount'"],
          },
        },
        segments: {
          outflow: {
            description: 'Money out.',
            where: "metadata->>'direction'='out'",
            on: 'event',
            appliedBefore: 'dedupe',
          },
        },
        measures: {
          spend: {
            eventSet: 'charges',
            agg: 'sum',
            expr: "(metadata->>'amount')::numeric",
            segments: ['outflow'],
            description: 'Total outflow.',
          },
        },
        dimensions: { currency: { expr: "metadata->>'currency'", description: 'Currency.' } },
      };

      await owner.entity_schema.createType({
        slug: 'metric-company',
        name: 'Company',
        metrics_config: metrics,
      });
      const created = (await owner.entity_schema.getType('metric-company')) as Got;
      // Stored and read back verbatim (jsonb round-trip).
      expect(created.entity_type?.metrics_config).toEqual(metrics);

      // Update a measure → metrics_config changes.
      const updatedMetrics = { ...metrics, measures: { spend: { ...metrics.measures.spend, agg: 'count' } } };
      await owner.entity_schema.updateType({
        slug: 'metric-company',
        metrics_config: updatedMetrics,
      });
      const updated = (await owner.entity_schema.getType('metric-company')) as Got;
      expect((updated.entity_type?.metrics_config as typeof metrics)?.measures?.spend?.agg).toBe(
        'count'
      );

      // Clear with null → no metrics.
      await owner.entity_schema.updateType({ slug: 'metric-company', metrics_config: null });
      const cleared = (await owner.entity_schema.getType('metric-company')) as Got;
      expect(cleared.entity_type?.metrics_config ?? null).toBeNull();

      await owner.entity_schema.deleteType({ slug: 'metric-company' });
    });

    it('a stored type carries no backing_sql', async () => {
      await owner.entity_schema.createType({ slug: 'plain-thing', name: 'Plain' });
      const got = (await owner.entity_schema.getType('plain-thing')) as {
        entity_type?: { backing_sql?: string | null };
      };
      expect(got.entity_type?.backing_sql ?? null).toBeNull();
      await owner.entity_schema.deleteType({ slug: 'plain-thing' });
    });

    it('rejects an empty / whitespace backing.sql (no corrupt derived type)', async () => {
      // TypeBox minLength isn't enforced for this tool, so the handler guards.
      await expect(
        owner.entity_schema.createType({
          slug: 'blank-view',
          name: 'Blank',
          backing: { sql: '   ' },
        })
      ).rejects.toThrow(/backing\.sql cannot be empty/i);
    });

		it('rejects the silently ignored top-level properties alias', async () => {
			await expect(
				owner.entity_schema.createType({
					slug: 'wrong-schema-shape',
					name: 'Wrong Schema Shape',
					properties: { title: { type: 'string' } },
				} as never)
			).rejects.toThrow(
				/unknown argument\(s\): properties.*search_sdk 'entitySchema\.createType'/i,
			);
		});
  });

  describe('relationship_type', () => {
    it('creates a symmetric type', async () => {
      const result = (await owner.entity_schema.createRelType({
        slug: 'collaborates-with',
        name: 'Collaborates With',
      })) as { relationship_type?: { slug: string; status: string } };
      expect(result.relationship_type?.slug).toBe('collaborates-with');
      expect(result.relationship_type?.status).toBe('active');
      await owner.entity_schema.deleteRelType({ slug: 'collaborates-with' });
    });

    it('rejects a duplicate relationship slug with a coded 409', async () => {
      await owner.entity_schema.createRelType({ slug: 'dup-rel', name: 'Dup' });
      const err = await owner.entity_schema
        .createRelType({ slug: 'dup-rel', name: 'Dup 2' })
        .then(() => null)
        .catch((e: unknown) => e as Error & { httpStatus?: number });
      expect(err).not.toBeNull();
      expect(err?.message).toMatch(/\[relationship_type_exists\].*already exists/);
      expect(err?.httpStatus).toBe(409);
      await owner.entity_schema.deleteRelType({ slug: 'dup-rel' });
    });

    it('concurrent creates of the same slug: one wins, every loser gets the coded 409 (not raw 23505)', async () => {
      // Same check-then-insert race as entity_type: prove the loser of the
      // partial-unique-index race surfaces the coded 409, not a raw 23505.
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          owner.entity_schema.createRelType({ slug: 'race-rel', name: 'Race' })
        )
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(5);
      for (const r of rejected) {
        const e = r.reason as Error & { httpStatus?: number };
        expect(e.message).toMatch(/\[relationship_type_exists\].*already exists/);
        expect(e.message).not.toMatch(/23505|duplicate key value/);
        expect(e.httpStatus).toBe(409);
      }
      await owner.entity_schema.deleteRelType({ slug: 'race-rel' });
    });
  });

  describe('access control', () => {
    it('blocks a member without admin scope from creating types', async () => {
      const member = owner.withAuth({ memberRole: 'member' });
      await expect(
        member.entity_schema.createType({ slug: 'blocked-type', name: 'Blocked' })
      ).rejects.toThrow(/admin|owner|access/i);
    });

    it('blocks an unauthenticated caller', async () => {
      const anon = owner.withAuth({ userId: null, memberRole: null });
      await expect(
        anon.entity_schema.createType({ slug: 'anon-type', name: 'Anon' })
      ).rejects.toThrow();
    });
  });
});
