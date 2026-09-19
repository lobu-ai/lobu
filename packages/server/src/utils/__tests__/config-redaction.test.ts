import { isSecretKey, redactUriCredentials } from '@lobu/core';
import { describe, expect, it } from 'vitest';
import {
  REDACTED_SENTINEL,
  redactConfigState,
} from '../config-redaction';
import {
  connectorSecretKeysFromSchemas,
  redactConnectionConfig,
  restoreRedactedConfig,
} from '../connection-config-redaction';

describe('redactConfigState', () => {
  it('preserves Date audit fields as ISO strings', () => {
    const at = new Date('2026-09-19T08:00:00.000Z');
    expect(redactConfigState('automation', { schedule_auto_paused_at: at, next_run_at: at })).toEqual({
      schedule_auto_paused_at: '2026-09-19T08:00:00.000Z',
      next_run_at: '2026-09-19T08:00:00.000Z',
    });
  });
  it('redacts denylisted keys at any depth, any case style', () => {
    const out = redactConfigState('connection', {
      name: 'slack-main',
      config: {
        botToken: 'xoxb-real-secret',
        signing_secret: 'shhh',
        nested: { apiKey: 'sk-123', refreshTokens: ['a', 'b'] },
        channel: 'C123',
      },
    });
    const config = out?.config as Record<string, unknown>;
    expect(config.botToken).toBe(REDACTED_SENTINEL);
    expect(config.signing_secret).toBe(REDACTED_SENTINEL);
    expect((config.nested as Record<string, unknown>).apiKey).toBe(REDACTED_SENTINEL);
    expect((config.nested as Record<string, unknown>).refreshTokens).toBe(REDACTED_SENTINEL);
    expect(config.channel).toBe('C123');
    expect(out?.name).toBe('slack-main');
  });

  it('does not redact non-secret keys that merely contain substrings', () => {
    const out = redactConfigState('agent', {
      tokenizer: 'cl100k',
      keyboard: 'qwerty',
      secretsPolicy: 'strict', // "secrets_policy" — suffix is "policy", not "secret"
    });
    expect(out?.tokenizer).toBe('cl100k');
    expect(out?.keyboard).toBe('qwerty');
    expect(out?.secretsPolicy).toBe('strict');
  });

  it('replaces auth-profile credentials wholesale', () => {
    const out = redactConfigState('auth-profile', {
      kind: 'oauth',
      credentials: { some_connector_defined_field: 'value' },
    });
    expect(out?.credentials).toBe(REDACTED_SENTINEL);
    expect(out?.kind).toBe('oauth');
  });

  it('forces provider-key state to null', () => {
    expect(redactConfigState('provider-key', { providerId: 'anthropic' })).toBeNull();
  });

  it('passes through null state (deletes)', () => {
    expect(redactConfigState('agent', null)).toBeNull();
  });

  it('preserves arrays and leaves null secret values untouched', () => {
    const out = redactConfigState('automation', {
      sources: [{ feed: 'gmail' }],
      api_key: null,
    });
    expect(out?.sources).toEqual([{ feed: 'gmail' }]);
    expect(out?.api_key).toBeNull();
  });

  it('redacts inference-provider apiKey', () => {
    const out = redactConfigState('inference-provider', {
      baseUrl: 'https://api.z.ai',
      apiKey: 'zk-live',
    });
    expect(out?.apiKey).toBe(REDACTED_SENTINEL);
    expect(out?.baseUrl).toBe('https://api.z.ai');
  });

  it('passes workspace identity state through the denylist deep-walk', () => {
    const org = redactConfigState('organization', {
      id: 'org_abc',
      name: 'Acme',
      slug: 'acme',
      visibility: 'private',
      metadata: { api_key: 'must-not-persist' },
    });
    expect(org).toEqual({
      id: 'org_abc',
      name: 'Acme',
      slug: 'acme',
      visibility: 'private',
      metadata: { api_key: REDACTED_SENTINEL },
    });

    const member = redactConfigState('member', {
      id: 'member_abc',
      user_id: 'user_abc',
      role: 'owner',
      email: 'owner@acme.test',
    });
    expect(member).toEqual({
      id: 'member_abc',
      user_id: 'user_abc',
      role: 'owner',
      email: 'owner@acme.test',
    });

    const invitation = redactConfigState('invitation', {
      id: 'inv_abc',
      email: 'invitee@acme.test',
      role: 'member',
      status: 'pending',
    });
    expect(invitation).toEqual({
      id: 'inv_abc',
      email: 'invitee@acme.test',
      role: 'member',
      status: 'pending',
    });
  });
});

/**
 * The denylist is SUFFIX-anchored (`(^|_)(token|secret|…)s?$`), which by
 * construction misses URL/DSN-shaped credential keys — `DATABASE_URL` ends in
 * `_url`, not in any denylisted term. That gap is exactly the bug this branch
 * started from: a `postgres://user:pass@host/db` sitting in
 * `connections.config.DATABASE_URL` and served straight back by
 * `connections.list()`. These cases pin the fix so it cannot silently regress.
 */
describe('isSecretKey > URL/DSN-shaped credential keys', () => {
  it.each(['DATABASE_URL', 'database_url', 'databaseUrl', 'dsn', 'connection_string', 'connectionString', 'db_url'])(
    'classifies %s as secret',
    (key) => {
      expect(isSecretKey(key)).toBe(true);
    }
  );

  it.each([
    'authorization',
    'Authorization',
    'cookie',
    'session_id',
    'sessionId',
    'bearer',
    'X-Api-Key',
    'Proxy-Authorization',
    'Set-Cookie',
    'client-secret',
    ' password ',
  ])(
    'classifies %s as secret',
    (key) => {
      expect(isSecretKey(key)).toBe(true);
    }
  );

  // The suffix anchoring is load-bearing — these must stay readable.
  it.each(['tokenizer', 'keyboard', 'secretsPolicy', 'url', 'base_url', 'webhook_url', 'authorization_mode'])(
    'does NOT classify %s as secret',
    (key) => {
      expect(isSecretKey(key)).toBe(false);
    }
  );
});

/**
 * URI redaction runs on every string in untrusted config. An unbounded scheme
 * quantifier (`[a-z0-9+.-]*`) is a polynomial-ReDoS on long non-matching
 * input (e.g. runs of 'a' with no `://`). The scheme quantifier is bounded
 * `{0,63}` so work stays linear — this pins that against regression.
 */
describe('redactUriCredentials > ReDoS-safe on adversarial non-matching input', () => {
  it('stays near-linear as non-matching input doubles', () => {
    const sizes = [10_000, 20_000, 40_000] as const;
    const times: number[] = [];
    for (const n of sizes) {
      const input = 'a'.repeat(n);
      const start = performance.now();
      expect(redactUriCredentials(input)).toBe(input);
      times.push(performance.now() - start);
    }
    // Quadratic growth would put 40k ~4× the 20k cost (or worse). Allow up to
    // 8× headroom for timer noise / GC, which still fails a true quadratic.
    expect(times[2]).toBeLessThan(Math.max(times[1] * 8, 50));
    // Absolute ceiling: even the largest sample should finish quickly.
    expect(times[2]).toBeLessThan(200);
  });

  it('still redacts a real credential-bearing URI', () => {
    expect(redactUriCredentials('postgres://u:pw@host/db')).toBe(
      `postgres://${REDACTED_SENTINEL}@host/db`,
    );
  });
});

/**
 * The write-side inverse. A client that reads a redacted config and PATCHes it
 * back must not persist the placeholder over the live credential — the sentinel
 * means "unchanged".
 */
describe('restoreRedactedConfig', () => {
  it('restores a bare sentinel from the stored value', () => {
    const out = restoreRedactedConfig(
      { password: REDACTED_SENTINEL, host: 'db.internal' },
      { password: 'real-secret', host: 'old.host' }
    ) as Record<string, unknown>;
    expect(out.password).toBe('real-secret');
    // A non-secret edit still lands.
    expect(out.host).toBe('db.internal');
  });

  it('restores the URI form, which is not equal to the bare sentinel', () => {
    // redactUriCredentials emits `postgres://__LOBU_REDACTED__@host/db`; a
    // naive `=== REDACTED_SENTINEL` check misses this and clobbers the DSN.
    const stored = 'postgres://u:pw@db.internal:5432/app';
    const out = restoreRedactedConfig(
      { DATABASE_URL: `postgres://${REDACTED_SENTINEL}@db.internal:5432/app` },
      { DATABASE_URL: stored }
    ) as Record<string, unknown>;
    expect(out.DATABASE_URL).toBe(stored);
  });

  it('restores at any nesting depth and through arrays', () => {
    const out = restoreRedactedConfig(
      {
        nested: { database: { password: REDACTED_SENTINEL } },
        headers: [{ Authorization: REDACTED_SENTINEL }, { 'X-Trace': 'keep' }],
      },
      {
        nested: { database: { password: 'deep-secret' } },
        headers: [{ Authorization: 'Bearer real' }, { 'X-Trace': 'old' }],
      }
    ) as Record<string, any>;
    expect(out.nested.database.password).toBe('deep-secret');
    expect(out.headers[0].Authorization).toBe('Bearer real');
    expect(out.headers[1]['X-Trace']).toBe('keep');
  });

  it('lets a genuinely new secret through (rotation still works)', () => {
    const out = restoreRedactedConfig(
      { password: 'rotated' },
      { password: 'old-secret' }
    ) as Record<string, unknown>;
    expect(out.password).toBe('rotated');
  });

  it('drops a sentinel that has nothing to restore from', () => {
    // Writing the literal placeholder is never the caller's intent, so a
    // sentinel on a key with no stored counterpart is omitted, not persisted.
    const out = restoreRedactedConfig(
      { brand_new: REDACTED_SENTINEL, kept: 'value' },
      {}
    ) as Record<string, unknown>;
    expect('brand_new' in out).toBe(false);
    expect(out.kept).toBe('value');
  });

  it('is a no-op when nothing is redacted', () => {
    const incoming = { host: 'db.internal', port: 5432, tags: ['a', 'b'] };
    expect(restoreRedactedConfig(incoming, { host: 'old' })).toEqual(incoming);
  });
});

describe('redactConnectionConfig', () => {
  it('redacts array-valued config recursively', () => {
    expect(
      redactConnectionConfig([
        { password: 'array-secret' },
        { nested: { apiKey: 'nested-array-secret' }, visible: 'value' },
      ])
    ).toEqual([
      { password: REDACTED_SENTINEL },
      { nested: { apiKey: REDACTED_SENTINEL }, visible: 'value' },
    ]);
  });

  it('redacts schema-declared secrets whose names do not match the denylist', () => {
    const declaredKeys = connectorSecretKeysFromSchemas({
      optionsSchema: {
        properties: {
          opaqueOption: { type: 'string', format: 'password' },
          visibleOption: { type: 'string' },
        },
      },
      authSchema: {
        methods: [
          {
            fields: [
              { key: 'authMaterial', secret: true },
              { key: 'visibleValue', secret: false },
            ],
          },
        ],
      },
    });

    expect(
      redactConnectionConfig(
        {
          opaqueOption: 'option-secret',
          authMaterial: 'auth-secret',
          visibleOption: 'visible',
          visibleValue: 'also-visible',
        },
        declaredKeys
      )
    ).toEqual({
      opaqueOption: REDACTED_SENTINEL,
      authMaterial: REDACTED_SENTINEL,
      visibleOption: 'visible',
      visibleValue: 'also-visible',
    });
  });
});

/**
 * Key names are not sufficient on their own: a connection string can sit under
 * a perfectly innocuous key (`primary`, `endpoint`). The value-shaped pass
 * strips the `user:password@` userinfo while leaving scheme + host readable.
 */
describe('redactConfigState > URI credential values', () => {
  it('redacts credentials embedded in a connection string under a non-secret key', () => {
    const out = redactConfigState('connection', {
      config: {
        primary: 'postgres://admin:hunter2@db.internal:5432/app',
        endpoint: 'https://api.example.com/v1',
      },
    });
    const config = out?.config as Record<string, unknown>;
    expect(config.primary).toBe(`postgres://${REDACTED_SENTINEL}@db.internal:5432/app`);
    expect(config.primary).not.toContain('hunter2');
    // A URL with no userinfo is untouched.
    expect(config.endpoint).toBe('https://api.example.com/v1');
  });
});
