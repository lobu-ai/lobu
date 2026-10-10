import { LINKEDIN_IDENTITY } from '@lobu/connectors/linkedin-identity';
import { X_IDENTITY } from '@lobu/connectors/x-identity';
import { describe, expect, it } from 'vitest';
import {
  buildEntityLinkUnion,
  entityLinkMatchSql,
  STANDARD_IDENTITY_NAMESPACES,
} from '../content-search/entity-link';

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
