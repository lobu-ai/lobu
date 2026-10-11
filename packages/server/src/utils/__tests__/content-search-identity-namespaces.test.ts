import { LINKEDIN_IDENTITY } from '@lobu/connectors/linkedin-identity';
import { X_IDENTITY } from '@lobu/connectors/x-identity';
import { describe, expect, it } from 'vitest';
import type { DbClient } from '../../db/client';
import {
  buildEntityLinkUnion,
  entityLinkMatchSql,
  STANDARD_IDENTITY_NAMESPACES,
} from '../content-search/entity-link';
import { listContentInternal } from '../content-search/list-path';
import { searchContentBySingleQuery } from '../content-search/search-path';

describe('content-search identity namespace registry bridge', () => {
  it('includes connector-contributed recall namespaces (x_user_id) but not mutable handles', () => {
    // x_user_id is recall-indexed via the X connector module; x_handle is not.
    expect(STANDARD_IDENTITY_NAMESPACES).toContain(X_IDENTITY.USER_ID);
    expect(STANDARD_IDENTITY_NAMESPACES).not.toContain(X_IDENTITY.HANDLE);
  });

  it('includes both LinkedIn author identity namespaces', () => {
    expect(STANDARD_IDENTITY_NAMESPACES).toContain(LINKEDIN_IDENTITY.SLUG);
    expect(STANDARD_IDENTITY_NAMESPACES).toContain(LINKEDIN_IDENTITY.MEMBER_ID);
  });

  it('emits an indexed x_user_id branch for entity-link matching', () => {
    const sql = entityLinkMatchSql('$1', 'f');
    expect(sql).toContain("ei.namespace = 'x_user_id'");
    expect(sql).toContain("e2.metadata ? 'x_user_id'");
    expect(sql).toContain("COALESCE(ei.scope_key, '')");
  });

  it('shares one identity traversal across the direct and namespace branches', () => {
    const sql = entityLinkMatchSql('$1::bigint', 'f');
    expect(sql.match(/FROM entities seed/g)).toHaveLength(1);
    expect(sql).toContain('e2.entity_ids && ARRAY(SELECT id FROM identity_members)');
    expect(sql.match(/ei.entity_id IN \(SELECT id FROM identity_members\)/g))
      .toHaveLength(STANDARD_IDENTITY_NAMESPACES.length);
  });

  it('emits indexed LinkedIn identity branches for entity-link matching', () => {
    const sql = entityLinkMatchSql('$1', 'f');
    expect(sql).toContain("ei.namespace = 'linkedin_slug'");
    expect(sql).toContain("e2.metadata ? 'linkedin_slug'");
    expect(sql).toContain("ei.namespace = 'linkedin_member_id'");
    expect(sql).toContain("e2.metadata ? 'linkedin_member_id'");
  });

  it('builds scoped unions for indexed namespaces and skips mutable unindexed handles', () => {
    const result = buildEntityLinkUnion({
      entityIdLiteral: 42,
      alias: 'f',
      baseParamIndex: 3,
      scopes: [
        { namespace: X_IDENTITY.USER_ID, identifier: '123', scopeKey: 'tenant-a' },
        { namespace: X_IDENTITY.HANDLE, identifier: 'alice', scopeKey: null },
      ],
    });

    expect(result.sql).toContain("metadata ? 'x_user_id'");
    expect(result.sql).toContain("metadata->>'x_user_id' = $3");
    expect(result.sql).not.toContain('x_handle');
    expect(result.sql).toContain("__lobu_identity_scope_keys");
    expect(result.params).toEqual(['123', 'tenant-a']);
  });
});

describe.each(['list', 'text search', 'vector search'] as const)('%s entity filters', (path) => {
  describe.each(['date', 'score'] as const)('%s ordering', (sortBy) => {
    it.each([
      { name: 'direct entity links', entityId: 42, identities: [] },
      {
        name: 'identity-attributed entity links',
        entityId: 42,
        identities: [{
          namespace: X_IDENTITY.USER_ID,
          identifier: 'synthetic-user',
          scope_key: 'test-scope',
        }],
      },
      { name: 'organization-wide reads', entityId: undefined, identities: [] },
    ])('preserves bindings and query shape for $name', async ({ entityId, identities }) => {
      const queries: Array<{ query: string; params: unknown[] }> = [];
      const unsafe = async (query: string, params: unknown[]) => {
        if (query.includes('SELECT identity.namespace')) return identities;
        queries.push({ query, params });
        return query.startsWith('SELECT COUNT(*)') ? [{ total: 1 }] : [];
      };
      const sql = { unsafe } as unknown as DbClient;
      const options = {
        entity_id: entityId,
        organization_id: 'test-org',
        visibility_scope: { organizationId: 'test-org', userId: 'test-user' },
        sort_by: sortBy,
        platform: 'test-connector',
        semantic_type: 'note',
        limit: 5,
      };
      if (path === 'list') {
        await listContentInternal(sql, options, 5, 0);
      } else {
        await searchContentBySingleQuery(sql, 'test-query', {
          ...options,
          ...(path === 'vector search' ? { query_embedding: [1, 0, 0] } : {}),
        });
      }

      expect(queries).toHaveLength(path === 'list' ? 2 : 1);
      const entitySlot = path === 'list' ? 1 : 2;
      for (const { query, params } of queries) {
        expect(params[entitySlot - 1]).toBe(entityId ?? null);
        const guard = `($${entitySlot}::bigint IS NULL OR f.id IN`;
        if (entityId != null) {
          expect(query).not.toContain(guard);
          expect(query).toContain(`AND ($${entitySlot}::bigint IS NOT NULL)`);
          expect(query).toContain('f.id IN (WITH entity_link_ids AS MATERIALIZED');
          for (const identity of identities) {
            const slot = params.indexOf(identity.identifier) + 1;
            expect(slot).toBeGreaterThan(0);
            expect(query).toContain(`metadata->>'${identity.namespace}' = $${slot}`);
            expect(params[slot]).toBe(identity.scope_key);
          }
        } else {
          expect(query).toContain(guard);
        }
        const slots = [...new Set(
          [...query.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
        )];
        expect(slots.sort((a, b) => a - b)).toEqual(params.map((_, index) => index + 1));
      }
    });
  });
});
