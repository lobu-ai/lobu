import { describe, expect, test } from 'bun:test';
import { StreamRedactor, redactOutput } from '../executor/redact.js';

describe('redactOutput', () => {
  test('redacts HTTP Authorization header', () => {
    const input = 'GET /api\nAuthorization: Bearer abc123def456\nContent-Type: application/json';
    const out = redactOutput(input);
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts standalone Bearer tokens', () => {
    const input = 'curl -H "x: Bearer eyJhbGc.payload-here.sig9_=="';
    const out = redactOutput(input);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('payload-here.sig9_');
  });

  test('redacts JWTs anywhere they appear', () => {
    const input =
      'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c more';
    const out = redactOutput(input);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts CH_API_KEY env-style assignments', () => {
    const input = 'env: CH_API_KEY=abcdef-12345 done';
    const out = redactOutput(input);
    expect(out).not.toContain('abcdef-12345');
    expect(out).toContain('CH_API_KEY=[REDACTED]');
  });

  test('redacts api_key / access_token / secret JSON-style assignments', () => {
    const variants = [
      '"api_key": "longsecretvalue1234"',
      '"apiKey":"longsecretvalue1234"',
      "access_token = 'longsecretvalue1234'",
      'access-token: longsecretvalue1234',
      'secret="longsecretvalue1234"',
    ];
    for (const v of variants) {
      const out = redactOutput(v);
      expect(out).not.toContain('longsecretvalue1234');
      expect(out).toContain('[REDACTED]');
    }
  });

  test('preserves non-secret content', () => {
    const input = 'Connector started, fetched 12 events, no errors.';
    expect(redactOutput(input)).toBe(input);
  });

  test('handles empty input', () => {
    expect(redactOutput('')).toBe('');
  });

  test('redacts Cookie / Set-Cookie headers as a whole', () => {
    expect(redactOutput('Cookie: session=abc.def; user=alice')).toContain('Cookie: [REDACTED]');
    expect(redactOutput('Set-Cookie: jwt=eyJxxx; HttpOnly')).toContain('Set-Cookie: [REDACTED]');
  });

  test('redacts Google OAuth ya29.* access tokens', () => {
    const out = redactOutput('access_token=ya29.a0AfH6SMblahblahblah_more.morestuff');
    expect(out).not.toContain('ya29.a0AfH6SMblahblahblah');
    expect(out).toContain('[REDACTED]');
  });

  test('redacts password in URI userinfo while preserving scheme/host', () => {
    const out = redactOutput('postgres://app_user:s3cretP@db.internal/mydb');
    expect(out).toContain('postgres://app_user:[REDACTED]@db.internal/mydb');
    expect(out).not.toContain('s3cretP');
  });

  test('redacts AWS_*_KEY/TOKEN/SECRET env-style assignments', () => {
    expect(redactOutput('AWS_SECRET_ACCESS_KEY=AKIAlongvaluehere1234')).toContain('[REDACTED]');
    expect(redactOutput('AWS_SESSION_TOKEN: longsessiontokenvalue')).toContain('[REDACTED]');
  });

  test('redacts refresh_token / id_token / password / client_secret', () => {
    const variants = [
      'refresh_token=longvaluehere1234',
      'id_token: "longvaluehere1234"',
      "password = 'longvaluehere1234'",
      'client_secret="longvaluehere1234"',
    ];
    for (const v of variants) {
      const out = redactOutput(v);
      expect(out).not.toContain('longvaluehere1234');
      expect(out).toContain('[REDACTED]');
    }
  });

  test('redacts explicit assignments regardless of length, quoting or key style', () => {
    const cases = [
      ['password=secret7', 'secret7'],
      ['authorization=Bearer syntheticsecret123 status=500', 'syntheticsecret123'],
      ['auth=Basic dTpw status=500', 'dTpw'],
      ['db.password=syntheticsecret123 status=500', 'syntheticsecret123'],
      ['config.api_key=syntheticsecret123 status=500', 'syntheticsecret123'],
      ['token=synthetic-opaque-token', 'synthetic-opaque-token'],
      ['api_key: z', 'z'],
      ['AWS_SESSION_TOKEN=z', 'z'],
      ['clientSecret="has spaces and ! punctuation"', 'has spaces and ! punctuation'],
      ['password=short!@#$%^*()', 'short!@#$%^*()'],
      [JSON.stringify({ message: JSON.stringify({ password: 'embedded secret' }) }), 'embedded secret'],
      [JSON.stringify(JSON.stringify({ token: 'twice escaped secret' })), 'twice escaped secret'],
      [JSON.stringify({ password: 'has a "quote" and tail' }), 'tail'],
    ];
    for (const [input, secret] of cases) {
      const output = redactOutput(input);
      expect(output).not.toContain(secret);
      expect(output).toContain('[REDACTED]');
    }
  });

  test('redacts authentication schemes across dotted keys and assignment formats', () => {
    for (const key of ['authorization', 'auth', 'nested.authorization', 'db.password', 'config.api_key']) {
      for (const separator of ['=', ': ']) {
        for (const scheme of ['Bearer', 'Basic']) {
          for (const credential of ['x', 'synthetic-secret-value']) {
            for (const value of [`${scheme} ${credential}`, JSON.stringify(`${scheme} ${credential}`)]) {
              const output = redactOutput(`${key}${separator}${value} status=500`);
              expect(output).not.toContain(credential);
              expect(output).toContain('[REDACTED]');
            }
          }
        }
      }
    }
  });

  test('keeps embedded JSON readable through repeated escaping layers', () => {
    let input = JSON.stringify({ password: 'space, \"quote\" and \\ tail', status: 500 });
    for (let depth = 0; depth < 4; depth++) {
      let output = redactOutput(input);
      for (let i = 0; i < depth; i++) output = JSON.parse(output);
      expect(JSON.parse(output)).toEqual({ password: '[REDACTED]', status: 500 });
      expect(redactOutput(redactOutput(input))).toBe(redactOutput(input));
      input = JSON.stringify(input);
    }
  });

  test('redacts complete object and array credential assignments', () => {
    for (const value of [
      { user: 'example', pass: 'synthetic-nested-secret', nested: { value: 'brace } and "quote"' } },
      ['synthetic-nested-secret', { value: 'bracket ] and \\ tail' }],
    ]) {
      let input = JSON.stringify({ credentials: value, status: 500 });
      for (let depth = 0; depth < 4; depth++) {
        const output = redactOutput(`embedded ${input} diagnostic=kept`);
        expect(output).not.toContain('synthetic-nested-secret');
        expect(output).toContain('status');
        expect(output).toContain('diagnostic=kept');
        expect(redactOutput(output)).toBe(output);
        let parsed = redactOutput(input);
        for (let i = 0; i < depth; i++) parsed = JSON.parse(parsed);
        expect(JSON.parse(parsed)).toEqual({ credentials: '[REDACTED]', status: 500 });
        input = JSON.stringify(input);
      }
    }
  });

  test('bounds work on long non-URI tokens and malformed assignments', () => {
    const start = performance.now();
    for (const input of ['a'.repeat(200_000), 'a-'.repeat(100_000), 'password' + ' '.repeat(200_000)]) {
      expect(redactOutput(input)).toBe(input);
    }
    expect(redactOutput('credentials:{' + '\\'.repeat(200_000))).toBe('credentials:"[REDACTED]"');
    expect(performance.now() - start).toBeLessThan(1500);
  });

  test('preserves nearby diagnostic fields and prose without assignments', () => {
    const input = 'no apikey set; tokenizer=ok password_policy=strict key=id status=500';
    expect(redactOutput(input)).toBe(input);
    expect(redactOutput('password=secret7 status=500')).toBe('password=[REDACTED] status=500');
    expect(redactOutput('password=[REDACTED] status=500')).toBe('password=[REDACTED] status=500');
  });
});

describe('StreamRedactor', () => {
  function collect(): { emit: (s: string) => void; out: () => string } {
    let buf = '';
    return { emit: (s) => (buf += s), out: () => buf };
  }

  test('redacts secret split across two chunks', () => {
    const r = new StreamRedactor();
    const c = collect();
    r.process('GET /api\nAuthorization: Bear', c.emit);
    r.process('er abc123secret456\nfoo\n', c.emit);
    r.flush(c.emit);
    expect(c.out()).not.toContain('abc123secret456');
    expect(c.out()).toContain('Authorization: [REDACTED]');
  });

  test('emits complete lines as soon as a newline arrives', () => {
    const r = new StreamRedactor();
    const c = collect();
    r.process('hello world\n', c.emit);
    expect(c.out()).toBe('hello world\n');
  });

  test('flush releases trailing partial line through redactor', () => {
    const r = new StreamRedactor();
    const c = collect();
    r.process('line1\nAuthorization: Bearer secret_long_token', c.emit);
    expect(c.out()).toBe('line1\n');
    r.flush(c.emit);
    expect(c.out()).not.toContain('secret_long_token');
    expect(c.out()).toContain('Authorization: [REDACTED]');
  });

  test('emits prefix when buffer would exceed cap with no newline', () => {
    const r = new StreamRedactor();
    const c = collect();
    // 8200 chars, no newline — exceeds 8192 cap.
    r.process('x'.repeat(8200), c.emit);
    expect(c.out().length).toBeGreaterThan(0);
  });

  test('redacts a secret embedded near the cap-boundary even with no newline', () => {
    const r = new StreamRedactor();
    const c = collect();
    // A long no-newline payload with a secret somewhere inside. Cap is
    // 8192; the redactor must redact the entire combined buffer before
    // emitting, otherwise a slice near the cap could split the match.
    const payload = 'x'.repeat(8000) + 'Authorization: Bearer abc123secret456 ' + 'y'.repeat(500);
    r.process(payload, c.emit);
    expect(c.out()).not.toContain('abc123secret456');
    expect(c.out()).toContain('Authorization: [REDACTED]');
  });
});
