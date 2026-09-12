/**
 * Automation-promotion provenance keys must survive metadata round-trips.
 *
 * `promote-keyed-entities.ts` stamps `automation_id` / `stable_key` / `run_id`
 * / `automation_output` onto promoted entity metadata outside schema validation.
 * Under an `additionalProperties: false` entity-type schema
 * that meant a promoted entity's metadata could never be written back through
 * `entities.update`: reading the metadata, editing one domain field, and
 * saving rejected with an unknown platform property. Validation now exempts
 * exactly those platform keys; everything else stays schema-enforced.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('entity metadata validation > automation provenance keys', () => {
  let owner: TestApiClient;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Provenance Keys Org' });
    const user = await createTestUser({ email: 'provenance-keys@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({
      slug: 'strict-task',
      name: 'Strict Task',
      metadata_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          status: { type: 'string', enum: ['backlog', 'active', 'done'] },
          effort: { type: 'number' },
          source: { type: 'string' },
        },
        required: ['action'],
      },
    } as never);
  });

  it('accepts promotion provenance on update under additionalProperties: false', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Promoted task round-trip',
      metadata: { action: 'Ship the fix', status: 'backlog' },
    })) as { entity: { id: number } };

    // The exact write a client makes after reading a promoted entity's
    // metadata (provenance keys included) and editing one domain field.
    await owner.entities.update({
      entity_id: created.entity.id,
      metadata: {
        action: 'Ship the fix',
        status: 'done',
        source: 'automation_promotion',
        automation_id: 5,
        stable_key: 'ship-the-fix',
        run_id: 4288453,
        automation_output: 'tasks',
      },
    });

    const got = (await owner.entities.get({ entity_id: created.entity.id })) as {
      entity?: { metadata?: Record<string, unknown> };
    };
    expect(got.entity?.metadata?.status).toBe('done');
    expect(got.entity?.metadata?.run_id).toBe(4288453);
    expect(got.entity?.metadata?.automation_output).toBe('tasks');
  });

  it('still rejects genuinely unknown metadata keys', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Strictness control',
      metadata: { action: 'Stay strict', status: 'backlog' },
    })) as { entity: { id: number } };

    const err = await owner.entities
      .update({
        entity_id: created.entity.id,
        metadata: { action: 'Stay strict', bogus_field: true },
      })
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err?.message).toContain("unknown property 'bogus_field'");
  });

  it('validates a partial patch against the merged entity metadata', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Partial edit',
      metadata: { action: 'Preserve the required action', status: 'backlog' },
    })) as { entity: { id: number } };

    await owner.entities.update({
      entity_id: created.entity.id,
      metadata: { status: 'active' },
    });
    const got = (await owner.entities.get({ entity_id: created.entity.id })) as {
      entity: { metadata: Record<string, unknown> };
    };
    expect(got.entity.metadata).toMatchObject({
      action: 'Preserve the required action',
      status: 'active',
    });
    await expect(
      owner.entities.update({
        entity_id: created.entity.id,
        metadata: { status: 'not-a-state' },
      })
    ).rejects.toThrow();
  });

  it('initializes metadata when a stored row has null metadata', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Initialize null metadata',
      metadata: { action: 'Initial content' },
    })) as { entity: { id: number } };
    await getTestDb()`UPDATE entities SET metadata = NULL WHERE id = ${created.entity.id}`;
    await owner.entities.update({
      entity_id: created.entity.id,
      metadata: { action: 'Initialized content' },
    });
    const got = (await owner.entities.get({ entity_id: created.entity.id })) as {
      entity: { metadata: Record<string, unknown> };
    };
    expect(got.entity.metadata.action).toBe('Initialized content');
  });

  it('edits a legacy promoted row when the strict schema has no source field', async () => {
    await owner.entity_schema.createType({
      slug: 'strict-no-source',
      name: 'Strict without source',
      metadata_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { action: { type: 'string' }, status: { type: 'string' } },
        required: ['action'],
      },
    } as never);
    const created = (await owner.entities.create({
      type: 'strict-no-source',
      name: 'Legacy promotion',
      metadata: { action: 'Keep required content', status: 'backlog' },
    })) as { entity: { id: number } };
    const sql = getTestDb();
    // Reproduce the historical promotion shape, which bypassed schema validation.
    await sql`
      UPDATE entities
      SET metadata = metadata || ${sql.json({
        source: 'automation_promotion',
        automation_id: 7,
        automation_output: 'items',
        run_id: 9,
        stable_key: 'synthetic-legacy',
      })}
      WHERE id = ${created.entity.id}
    `;
    await expect(owner.entities.update({
      entity_id: created.entity.id,
      metadata: { status: 'done' },
    })).rejects.toThrow("unknown property 'source'");
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      SELECT organization_id, id, 'automation_key', 'synthetic-legacy'
      FROM entities
      WHERE id = ${created.entity.id}
    `;
    await owner.entities.update({
      entity_id: created.entity.id,
      metadata: { status: 'done' },
    });
    const got = (await owner.entities.get({ entity_id: created.entity.id })) as {
      entity: { metadata: Record<string, unknown> };
    };
    expect(got.entity.metadata).toMatchObject({
      action: 'Keep required content', status: 'done', source: 'automation_promotion',
    });
    await expect(owner.entities.update({
      entity_id: created.entity.id,
      metadata: { source: 'https://example.invalid/domain-value' },
    })).rejects.toThrow("unknown property 'source'");
    await expect(owner.entities.create({
      type: 'strict-no-source',
      name: 'Spoofed provenance metadata',
      metadata: {
        action: 'Stay strict',
        source: 'automation_promotion',
        automation_id: 7,
        automation_output: 'items',
        run_id: 9,
        stable_key: 'not-an-identity',
      },
    })).rejects.toThrow("unknown property 'source'");
  });

  it.each([
    ['property', {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string' },
        source: { enum: ['verified'] },
      },
      required: ['action'],
    }],
    ['pattern', {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string' } },
      patternProperties: { '^source$': { enum: ['verified'] } },
      required: ['action'],
    }],
    ['composition', {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: { action: { type: 'string' } },
          required: ['action'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            source: { enum: ['verified'] },
          },
          required: ['action', 'source'],
        },
      ],
    }],
  ])('validates a domain source declared by %s', async (kind, metadataSchema) => {
    await owner.entity_schema.createType({
      slug: `strict-domain-source-${kind}`,
      name: 'Strict domain source',
      metadata_schema: metadataSchema,
    } as never);
    const created = (await owner.entities.create({
      type: `strict-domain-source-${kind}`,
      name: `Declared source validation ${kind}`,
      metadata: { action: 'Stay strict', source: 'verified' },
    })) as { entity: { id: number } };
    const sql = getTestDb();
    await sql`
      UPDATE entities
      SET metadata = metadata || ${sql.json({
        source: 'automation_promotion',
        automation_id: 7,
        automation_output: 'items',
        run_id: 9,
        stable_key: 'declared-source',
      })}
      WHERE id = ${created.entity.id}
    `;
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      SELECT organization_id, id, 'automation_key', ${`declared-source-${kind}`}
      FROM entities
      WHERE id = ${created.entity.id}
    `;
    await expect(owner.entities.update({
      entity_id: created.entity.id,
      metadata: { action: 'Still strict' },
    })).rejects.toThrow();
  });

  /**
   * The entity form can send the whole object (owletto#845). A cleared
   * optional field arrives as `status: null` alongside its surviving siblings —
   * and the schema types `status` as a string enum, which the raw patch fails.
   */
  it('preserves an optional null clear and non-null schema coercions', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Clear optional status',
      metadata: { action: 'Keep this', status: 'backlog' },
    })) as { entity: { id: number } };

    await owner.entities.update({
      entity_id: created.entity.id,
      metadata: { action: 'Keep this', status: null, effort: '5' },
    });

    const got = (await owner.entities.get({ entity_id: created.entity.id })) as {
      entity?: { metadata?: Record<string, unknown> };
    };
    expect(got.entity?.metadata).toMatchObject({
      action: 'Keep this',
      status: null,
      effort: 5,
    });
  });

  /**
   * Filtering the clear sentinels out of the VALIDATED copy must not shrink the
   * patch out of the size guard's view: the merge still persists every null, so
   * a null-only patch above `maxNodes` has to be refused rather than written.
   */
  it('rejects an oversized null-only metadata patch', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Bounded null patch',
      metadata: { action: 'Stay bounded' },
    })) as { entity: { id: number } };

    const oversized: Record<string, null> = {};
    for (let i = 0; i < 10_001; i++) {
      oversized[`k${i}`] = null;
    }

    await expect(
      owner.entities.update({
        entity_id: created.entity.id,
        metadata: oversized,
      })
    ).rejects.toThrow(/exceeds size\/nesting limits/);

    const got = (await owner.entities.get({ entity_id: created.entity.id })) as {
      entity?: { metadata?: Record<string, unknown> };
    };
    expect(got.entity?.metadata).toEqual({ action: 'Stay bounded' });
  });

  /**
   * The complement, so the fix cannot degenerate into "ignore every null".
   * `{ action: null }` alone is the hard case: it filters down to `{}`, which
   * only reaches the schema because `validateEntityMetadata` no longer treats
   * an explicit empty object as trivially valid.
   */
  it('rejects an explicit null clear for a required schema field', async () => {
    const created = (await owner.entities.create({
      type: 'strict-task',
      name: 'Keep required action',
      metadata: { action: 'Cannot clear this', status: 'backlog' },
    })) as { entity: { id: number } };

    await expect(
      owner.entities.update({
        entity_id: created.entity.id,
        metadata: { action: null },
      })
    ).rejects.toThrow(/required field: action/);
  });
});
