import { describe, expect, it } from 'bun:test';
import {
  assertIsolateEligible,
  findIsolateIneligibleBuiltins,
  IsolateLaneIneligibleError,
} from '../isolate/eligibility.js';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { createPreludeHostSync, GUEST_PRELUDE, PRELUDE_GLOBALS } from '../isolate/prelude.js';

describe('guest prelude text', () => {
  it('installs every advertised global', () => {
    for (const name of PRELUDE_GLOBALS) {
      const installed = new RegExp(`(^|\\n)\\s*(global\\.${name}\\s*=|var ${name}\\s*=)`).test(GUEST_PRELUDE);
      expect(installed, `${name} is listed in PRELUDE_GLOBALS but never installed`).toBe(true);
    }
  });

  it('captures and removes the host handles so connector code cannot reach them', () => {
    // The two ivm.References are captured once and removed from the global so
    // connector code cannot reach the raw host dispatchers.
    expect(GUEST_PRELUDE).toMatch(/delete global\.__host_sync/);
    expect(GUEST_PRELUDE).toMatch(/delete global\.__host_async/);
    expect(GUEST_PRELUDE).toMatch(/delete global\.__host_env_json/);
  });

  it('parses as JavaScript', () => {
    // Construction alone parses the body; nothing runs.
    expect(() => new Function(GUEST_PRELUDE)).not.toThrow();
  });

  it('provides working crypto and Buffer shims in guest environment', () => {
    const mockGlobal: any = {
      __host_sync: {
        applySync: (_receiver: any, args: any[]) => {
          const name = args[0];
          if (name === 'randomBytes') {
            const len = args[1];
            const out = new Uint8Array(len);
            for (let i = 0; i < len; i++) out[i] = (i * 17 + 3) & 0xff;
            return { __lobu: 1, ok: true, value: out };
          }
          if (name === 'base64Decode') {
            return { __lobu: 1, ok: true, value: Buffer.from(String(args[1]), 'base64').toString('binary') };
          }
          if (name === 'base64Encode') {
            return { __lobu: 1, ok: true, value: Buffer.from(String(args[1]), 'binary').toString('base64') };
          }
          return { __lobu: 1, ok: true, value: null };
        },
      },
      __host_async: {
        applyAsync: () => Promise.resolve({ __lobu: 1, ok: true, value: null }),
      },
      __host_env_json: '{}',
      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
      TextEncoder,
      TextDecoder,
    };
    new Function('globalThis', GUEST_PRELUDE)(mockGlobal);

    // crypto.getRandomValues
    const bytes = new Uint8Array(16);
    mockGlobal.crypto.getRandomValues(bytes);
    expect(bytes[0]).toBe(3);
    expect(bytes[1]).toBe(20);

    // crypto.randomUUID
    const uuid = mockGlobal.crypto.randomUUID();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Buffer.from base64 / base64url decode (used by google_gmail.ts)
    const base64Sample = mockGlobal.btoa('hello world');
    const decoded = mockGlobal.Buffer.from(base64Sample, 'base64').toString('utf8');
    expect(decoded).toBe('hello world');

    // base64url with - and _
    const base64url = 'aGVsbG8td29ybGRfc3Ry'; // "hello-world_str"
    const decodedUrl = mockGlobal.Buffer.from(base64url, 'base64url').toString('utf8');
    expect(decodedUrl).toBe('hello-world_str');
  });
});

/**
 * A guest whose `__host_sync` dispatches into the REAL host halves, so these
 * assertions cover both sides of the bridge rather than a stub's idea of them.
 */
function instantiateGuest(): any {
  const hostSync = createPreludeHostSync();
  const guest: any = {
    __host_sync: {
      applySync: (_receiver: unknown, args: any[]) => {
        const [name, ...rest] = args;
        const fn = hostSync[String(name)];
        if (!fn) return { __lobu: 1, ok: true, value: null };
        try {
          return { __lobu: 1, ok: true, value: fn(...rest) };
        } catch (error) {
          const err = error as Error;
          return { __lobu: 1, ok: false, error: { name: err.name, message: err.message } };
        }
      },
    },
    __host_async: { applyAsync: () => Promise.resolve({ __lobu: 1, ok: true, value: null }) },
    __host_env_json: '{}',
    atob: (x: string) => Buffer.from(x, 'base64').toString('binary'),
    btoa: (x: string) => Buffer.from(x, 'binary').toString('base64'),
    TextEncoder,
    TextDecoder,
  };
  new Function('globalThis', GUEST_PRELUDE)(guest);
  return guest;
}

/**
 * Enumerated as OPERATIONS, not as one connector: a database driver on this
 * lane answers its authentication challenge entirely through `crypto.subtle`,
 * and a guest that is merely missing one of these does not fail loudly. The
 * rejection is swallowed inside the driver's async auth handler and the
 * connection stalls until its own connect timeout, which reads as a network
 * fault rather than a missing shim. Every case below pins the guest's answer
 * to Node's for the same input.
 */
describe('guest crypto.subtle', () => {
  const enc = new TextEncoder();

  it('digests SHA-256 and md5 exactly as Node does', async () => {
    const guest = instantiateGuest();
    for (const [label, nodeName] of [
      ['SHA-256', 'sha256'],
      ['SHA-1', 'sha1'],
      // Not a WebCrypto algorithm. A driver answering an md5 password
      // challenge asks for it by this name, and the host has it.
      ['md5', 'md5'],
    ] as const) {
      const digest = Buffer.from(await guest.crypto.subtle.digest(label, enc.encode('lobu')));
      expect(digest.toString('hex')).toBe(createHash(nodeName).update('lobu').digest('hex'));
    }
  });

  it('signs HMAC-SHA-256 over a raw imported key', async () => {
    const guest = instantiateGuest();
    const key = await guest.crypto.subtle.importKey(
      'raw',
      enc.encode('salted password'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const mac = Buffer.from(await guest.crypto.subtle.sign('HMAC', key, enc.encode('Client Key')));
    expect(mac.toString('hex')).toBe(
      createHmac('sha256', 'salted password').update('Client Key').digest('hex')
    );
  });

  it('derives PBKDF2-SHA-256 bits, the SCRAM salted password', async () => {
    const guest = instantiateGuest();
    const key = await guest.crypto.subtle.importKey('raw', enc.encode('pw'), 'PBKDF2', false, ['deriveBits']);
    const bits = Buffer.from(
      await guest.crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('salt'), iterations: 4096 },
        key,
        32 * 8
      )
    );
    expect(bits.toString('hex')).toBe(pbkdf2Sync('pw', 'salt', 4096, 32, 'sha256').toString('hex'));
  });

  it('rejects rather than throws synchronously, so a guest await sees the failure', async () => {
    const guest = instantiateGuest();
    // A synchronous throw here is swallowed by an async auth handler and the
    // caller hangs; the rejection is what surfaces the fault.
    await expect(guest.crypto.subtle.digest('SHA-3', enc.encode('x'))).rejects.toThrow(/unsupported algorithm/);
    await expect(guest.crypto.subtle.importKey('jwk', enc.encode('k'), 'PBKDF2', false, [])).rejects.toThrow(/raw/);
    await expect(guest.crypto.subtle.sign('RSASSA-PKCS1-v1_5', {}, enc.encode('x'))).rejects.toThrow(/only HMAC/);
  });

  it('bounds PBKDF2 rounds, which run synchronously on the host event loop', async () => {
    const guest = instantiateGuest();
    const key = await guest.crypto.subtle.importKey('raw', enc.encode('pw'), 'PBKDF2', false, ['deriveBits']);
    await expect(
      guest.crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('salt'), iterations: 1_000_000_000 },
        key,
        256
      )
    ).rejects.toThrow(/iterations/);
  });
});

describe('findIsolateIneligibleBuiltins', () => {
  it('names surviving Node builtins, node: prefix stripped, deduplicated and sorted', () => {
    const code = [
      'var fs = require("node:fs");',
      "var c = require('os');",
      'var again = __require("fs");',
      'var ky = require("ky");',
      'var path = require( "node:path" );',
    ].join('\n');
    expect(findIsolateIneligibleBuiltins(code)).toEqual(['fs', 'os', 'path']);
  });

  it('ignores non-builtin requires and property accesses that merely end in require', () => {
    expect(findIsolateIneligibleBuiltins('var x = require("ky"); obj.require("fs"); myrequire("os");')).toEqual([]);
  });

  it('assertIsolateEligible throws a typed error naming the builtins', () => {
    expect(() => assertIsolateEligible('module.exports = 1;')).not.toThrow();
    let caught: unknown;
    try {
      assertIsolateEligible('require("node:net"); require("tls");', 'fixture');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IsolateLaneIneligibleError);
    const err = caught as IsolateLaneIneligibleError;
    expect(err.builtins).toEqual(['net', 'tls']);
    expect(err.message).toContain('net');
    expect(err.message).toContain('tls');
    expect(err.message).toContain('the isolate does not provide');
  });
});

/**
 * `node:crypto` is a PROVIDED builtin, so a bundle that imports it passes
 * eligibility and loads — which is exactly why the module the guest hands back
 * has to be Node's, not WebCrypto's. It used to be WebCrypto's, so
 * `createHash('sha256')` died at the call site as "is not a function" with the
 * bundle already running. github, jira and linear each mint a webhook secret
 * with `randomBytes(32).toString('hex')`, and every scraping connector hashes
 * content for change detection.
 */
describe('guest node:crypto', () => {
  it('createHash matches Node for every digest encoding', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('node:crypto');
    for (const algorithm of ['sha256', 'sha1', 'md5'] as const) {
      for (const encoding of ['hex', 'base64'] as const) {
        expect(nodeCrypto.createHash(algorithm).update('lobu').digest(encoding)).toBe(
          createHash(algorithm).update('lobu').digest(encoding)
        );
      }
    }
  });

  it('createHash accumulates chained updates the way a stream would', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('crypto');
    const hash = nodeCrypto.createHash('sha256');
    expect(hash.update('lo')).toBe(hash);
    hash.update('bu');
    expect(hash.digest('hex')).toBe(createHash('sha256').update('lobu').digest('hex'));
  });

  it('createHmac matches Node, keyed by string or bytes', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('node:crypto');
    expect(nodeCrypto.createHmac('sha256', 'k').update('lobu').digest('hex')).toBe(
      createHmac('sha256', 'k').update('lobu').digest('hex')
    );
    const key = new Uint8Array([1, 2, 3]);
    expect(nodeCrypto.createHmac('sha256', key).update('lobu').digest('hex')).toBe(
      createHmac('sha256', Buffer.from(key)).update('lobu').digest('hex')
    );
  });

  it('randomBytes returns hex-encodable bytes of the requested length', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('node:crypto');
    const bytes = nodeCrypto.randomBytes(32);
    expect(bytes.length).toBe(32);
    // The call site every bundled connector makes.
    expect(nodeCrypto.randomBytes(32).toString('hex')).toMatch(/^[0-9a-f]{64}$/);
    expect(nodeCrypto.randomBytes(0).length).toBe(0);
    expect(() => nodeCrypto.randomBytes(-1)).toThrow(TypeError);
  });

  it('still carries the WebCrypto surface for callers that want it', () => {
    const guest = instantiateGuest();
    const nodeCrypto = guest.require('node:crypto');
    expect(typeof nodeCrypto.randomUUID()).toBe('string');
    expect(nodeCrypto.subtle).toBe(guest.crypto.subtle);
    expect(nodeCrypto.webcrypto).toBe(guest.crypto);
  });
});

describe('guest Buffer shim — Node semantics connector code relies on', () => {
  it('Buffer.from(Uint8Array) copies rather than aliasing the source', () => {
    const guest = instantiateGuest();
    const source = new Uint8Array([1, 2, 3]);
    const copy = guest.Buffer.from(source);
    copy[0] = 9;
    expect(source[0]).toBe(1);
    expect(Array.from(copy)).toEqual([9, 2, 3]);
  });

  it('Buffer.byteLength honours the encoding and accepts byte sources', () => {
    const guest = instantiateGuest();
    expect(guest.Buffer.byteLength('aGk=', 'base64')).toBe(2);
    expect(guest.Buffer.byteLength('h\u00e9llo')).toBe(6);
    expect(guest.Buffer.byteLength(new Uint8Array(4))).toBe(4);
    expect(guest.Buffer.byteLength(new ArrayBuffer(5))).toBe(5);
  });

  it('Buffer.alloc repeats a string fill instead of zeroing', () => {
    const guest = instantiateGuest();
    expect(Array.from(guest.Buffer.alloc(5, 'ab'))).toEqual([97, 98, 97, 98, 97]);
    expect(Array.from(guest.Buffer.alloc(3, 7))).toEqual([7, 7, 7]);
    expect(Array.from(guest.Buffer.alloc(2))).toEqual([0, 0]);
    expect(Array.from(guest.Buffer.alloc(3, new Uint8Array([5, 6])))).toEqual([5, 6, 5]);
  });
});

/**
 * `TextDecoder.decode(chunk, { stream: true })` is how every SSE consumer
 * (pi-ai's Anthropic provider, the Stainless SDKs) reassembles a body that
 * arrives in chunks. The guest shell has no decoder state of its own: the
 * sequence of streaming decodes runs on one Node `TextDecoder` the host holds
 * open until the flushing decode, so these pin that both halves agree with
 * Node on a multi-byte sequence split across chunks.
 */
describe('guest TextDecoder streaming', () => {
  // 'café €' = 63 61 66 | c3 a9 | 20 | e2 82 ac
  const bytes = new TextEncoder().encode('café €');

  it('holds a split multi-byte sequence across chunks and flushes on the final decode', () => {
    const guest = instantiateGuest();
    const decoder = new guest.TextDecoder();
    expect(decoder.decode(bytes.subarray(0, 4), { stream: true })).toBe('caf');
    expect(decoder.decode(bytes.subarray(4, 8), { stream: true })).toBe('é ');
    expect(decoder.decode(bytes.subarray(8))).toBe('€');
    // Reusable and stateless again after the flush, as the spec resets it.
    expect(decoder.decode(bytes)).toBe('café €');
  });

  it('matches Node chunk for chunk over every split point', () => {
    const guest = instantiateGuest();
    for (let split = 0; split <= bytes.length; split++) {
      const guestDecoder = new guest.TextDecoder();
      const nodeDecoder = new TextDecoder();
      const guestOut =
        guestDecoder.decode(bytes.subarray(0, split), { stream: true }) + guestDecoder.decode(bytes.subarray(split));
      const nodeOut = nodeDecoder.decode(bytes.subarray(0, split), { stream: true }) + nodeDecoder.decode(bytes.subarray(split));
      expect(guestOut, `split at ${split}`).toBe(nodeOut);
      expect(guestOut).toBe('café €');
    }
  });

  it('without the stream flag a chunk boundary inside a sequence is a replacement character, as on Node', () => {
    const guest = instantiateGuest();
    const decoder = new guest.TextDecoder();
    expect(decoder.decode(bytes.subarray(0, 4))).toBe(new TextDecoder().decode(bytes.subarray(0, 4)));
    expect(decoder.decode(bytes.subarray(0, 4))).toBe('caf\uFFFD');
  });

  it('a fatal decoder throws at the flush for a sequence that never completed, and only then', () => {
    const guest = instantiateGuest();
    const decoder = new guest.TextDecoder('utf-8', { fatal: true });
    expect(decoder.decode(bytes.subarray(0, 4), { stream: true })).toBe('caf');
    expect(() => decoder.decode()).toThrow(TypeError);
    // The failed flush released the host decoder: the next decode starts clean.
    expect(decoder.decode(bytes)).toBe('café €');
  });

  it('a flush with no input ends the stream, the way an SSE reader finishes', () => {
    const guest = instantiateGuest();
    const decoder = new guest.TextDecoder();
    expect(decoder.decode(bytes.subarray(0, 4), { stream: true })).toBe('caf');
    expect(decoder.decode()).toBe('\uFFFD');
    expect(decoder.decode(bytes.subarray(4, 6))).toBe('\uFFFD ');
  });

  it('bounds the streaming decoders one guest may leave open', () => {
    const guest = instantiateGuest();
    for (let i = 0; i < 1024; i++) new guest.TextDecoder().decode(bytes.subarray(0, 1), { stream: true });
    expect(() => new guest.TextDecoder().decode(bytes.subarray(0, 1), { stream: true })).toThrow(RangeError);
    // Each host is its own registry: a fresh guest is not affected.
    expect(new (instantiateGuest().TextDecoder)().decode(bytes, { stream: true })).toBe('café €');
  });
});

/**
 * `Response.body` is a `ReadableStream` over the host's `fetchRead`, and a
 * socket's `readable` is one over `socketRead`, so what a reader does after
 * the consumer stops reading decides whether the guest reads from something
 * the host already released. Both sources are pull-only, which these model
 * directly rather than through a fetch.
 */
describe('guest ReadableStream reader', () => {
  /**
   * A source that hands out one chunk per pull and records the cancel. It
   * answers on a later microtask, as `fetchRead` and `socketRead` do across
   * the host boundary, so several reads really are waiting at once.
   */
  function pullSource(chunks: string[]): { source: Record<string, unknown>; pulls: () => number; cancelled: () => boolean } {
    let pulls = 0;
    let cancelled = false;
    return {
      source: {
        pull: (controller: { enqueue: (chunk: string) => void; close: () => void }) => {
          pulls += 1;
          const index = pulls;
          return Promise.resolve().then(() => {
            if (index > chunks.length) controller.close();
            else controller.enqueue(chunks[index - 1]);
          });
        },
        cancel: () => {
          cancelled = true;
        },
      },
      pulls: () => pulls,
      cancelled: () => cancelled,
    };
  }

  it('answers concurrent reads in order, one pull each', async () => {
    const guest = instantiateGuest();
    const probe = pullSource(['a', 'b', 'c']);
    const reader = new guest.ReadableStream(probe.source).getReader();
    const results = await Promise.all([reader.read(), reader.read(), reader.read()]);
    expect(results.map((r: { value: string }) => r.value)).toEqual(['a', 'b', 'c']);
    expect(probe.pulls()).toBe(3);
    expect((await reader.read()).done).toBe(true);
  });

  it('cancelling ends the stream: the source is cancelled once and no later read pulls it again', async () => {
    const guest = instantiateGuest();
    const probe = pullSource(['a', 'b', 'c']);
    const reader = new guest.ReadableStream(probe.source).getReader();
    expect((await reader.read()).value).toBe('a');
    await reader.cancel();
    expect(probe.cancelled()).toBe(true);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(await reader.read()).toEqual({ value: undefined, done: true });
    expect(probe.pulls()).toBe(1);
  });

  it('cancelling settles a read already waiting and drops a chunk the source still owed', async () => {
    const guest = instantiateGuest();
    let release: ((value: string) => void) | null = null;
    const reader = new guest.ReadableStream({
      pull: (controller: { enqueue: (chunk: string) => void }) => {
        release = (value: string) => controller.enqueue(value);
      },
    }).getReader();
    const pending = reader.read();
    await reader.cancel();
    expect(await pending).toEqual({ value: undefined, done: true });
    release?.('late');
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  });

  it('an error the source reports after a cancel is dropped: a later read still reports done', async () => {
    const guest = instantiateGuest();
    let fail: ((error: Error) => void) | null = null;
    const reader = new guest.ReadableStream({
      pull: (controller: { error: (error: Error) => void }) => {
        fail = (error: Error) => controller.error(error);
      },
    }).getReader();
    const pending = reader.read();
    await reader.cancel();
    expect(await pending).toEqual({ value: undefined, done: true });
    // The in-flight pull answers after the cancel, as a fetchRead killed by
    // fetchAbort does with its AbortError.
    fail?.(new Error('aborted after cancel'));
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  });

  it('marks the stream disturbed on the first read, which is what Response.bodyUsed reports', async () => {
    const guest = instantiateGuest();
    const stream = new guest.ReadableStream(pullSource(['a']).source);
    expect(stream._disturbed).toBe(false);
    await stream.getReader().read();
    expect(stream._disturbed).toBe(true);
  });
});

/**
 * `Response.clone()` tees a streamed body on every other runtime; here it
 * throws for one, since nothing bundled clones a network response and a tee
 * nobody reads is surface for its own sake. A guest-constructed body still
 * clones, so the narrowing is pinned exactly where it applies.
 */
describe('guest Response.clone', () => {
  it('clones a guest-constructed body and refuses a streamed one', async () => {
    const guest = instantiateGuest();
    const built = new guest.Response('payload', { status: 201, headers: { 'x-a': '1' } });
    const copy = built.clone();
    expect(copy.status).toBe(201);
    expect(copy.headers.get('x-a')).toBe('1');
    expect(await copy.text()).toBe('payload');
    expect(await built.text()).toBe('payload');

    const streamed = new guest.Response(new guest.ReadableStream({ pull: (c: { close: () => void }) => c.close() }));
    expect(streamed.body).not.toBeNull();
    expect(() => streamed.clone()).toThrow(TypeError);
    expect(() => streamed.clone()).toThrow(/streamed body cannot be cloned/);
    // Refusing to clone did not consume the body.
    expect(streamed.bodyUsed).toBe(false);
    expect(await streamed.text()).toBe('');
    expect(() => streamed.clone()).toThrow(/already been consumed/);
  });
});

/**
 * The Stainless HTTP clients every pi LLM provider is built on branch on
 * `body instanceof FormData` with no `globalThis.FormData &&` guard, on the
 * request path each provider call takes. A guest without the constructor
 * therefore cannot reach any provider at all, which is why the lane carries
 * one. It holds text fields only: `Blob` and `File` are not on this lane, so a
 * non-primitive part is refused instead of stringified into "[object Object]".
 */
describe('guest FormData', () => {
  function instantiateFetchGuest(): { guest: any; opened: Array<{ request: any; body: Uint8Array | undefined }> } {
    const hostSync = createPreludeHostSync();
    const opened: Array<{ request: any; body: Uint8Array | undefined }> = [];
    const guest: any = {
      __host_sync: {
        applySync: (_receiver: unknown, args: any[]) => {
          const [name, ...rest] = args;
          const fn = hostSync[String(name)];
          if (!fn) return { __lobu: 1, ok: true, value: null };
          try {
            return { __lobu: 1, ok: true, value: fn(...rest) };
          } catch (error) {
            const err = error as Error;
            return { __lobu: 1, ok: false, error: { name: err.name, message: err.message } };
          }
        },
      },
      __host_async: {
        apply: (_receiver: unknown, args: any[]) => {
          const [name, ...rest] = args;
          if (name === 'fetchOpen') {
            opened.push({ request: rest[0], body: rest[1] as Uint8Array | undefined });
            return Promise.resolve({
              __lobu: 1,
              ok: true,
              value: { status: 204, statusText: 'No Content', url: rest[0].url, redirected: false, headers: [], hasBody: false },
            });
          }
          return Promise.resolve({ __lobu: 1, ok: true, value: null });
        },
      },
      __host_env_json: '{}',
      atob: (x: string) => Buffer.from(x, 'base64').toString('binary'),
      btoa: (x: string) => Buffer.from(x, 'binary').toString('base64'),
      TextEncoder,
      TextDecoder,
    };
    new Function('globalThis', GUEST_PRELUDE)(guest);
    return { guest, opened };
  }

  it('answers the unguarded `body instanceof FormData` branch the provider SDKs take', () => {
    const { guest } = instantiateFetchGuest();
    expect(typeof guest.FormData).toBe('function');
    expect(new guest.FormData() instanceof guest.FormData).toBe(true);
    // The SDKs reach the check with a plain JSON object on the messages path.
    expect({ model: 'claude' } instanceof guest.FormData).toBe(false);
    expect(Object.prototype.toString.call(new guest.FormData())).toBe('[object FormData]');
  });

  it('keeps a performance clock that starts at zero and moves with wall time', () => {
    const { guest } = instantiateFetchGuest();
    const perf = guest.performance as { now: () => number; timeOrigin: number };
    expect(typeof perf.timeOrigin).toBe('number');
    const first = perf.now();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1_000);
    expect(perf.now()).toBeGreaterThanOrEqual(first);
    expect(Object.isFrozen(guest.performance)).toBe(true);
  });

  it('deep-copies a tool call the way structuredClone does, cycles and byte arrays included', () => {
    const { guest } = instantiateFetchGuest();
    const clone = guest.structuredClone as typeof structuredClone;
    const shared = { n: 1 };
    const source: Record<string, unknown> = {
      code: 'entities.count()',
      when: new Date(1_700_000_000_000),
      tags: new Set(['a', 'b']),
      by: new Map([['k', shared]]),
      again: shared,
      bytes: new Uint8Array([1, 2, 3]),
      pattern: /x+/gi,
      nested: { list: [1, { deep: true }], nothing: null, absent: undefined },
    };
    source.self = source;
    const copy = clone(source) as typeof source & { self: unknown };

    expect(copy).not.toBe(source);
    expect(copy.self).toBe(copy);
    expect(copy.code).toBe('entities.count()');
    expect((copy.when as Date).getTime()).toBe(1_700_000_000_000);
    expect(copy.when).not.toBe(source.when);
    expect(Array.from(copy.tags as Set<string>)).toEqual(['a', 'b']);
    expect((copy.by as Map<string, { n: number }>).get('k')).toBe(copy.again);
    expect(copy.again).not.toBe(shared);
    expect(Array.from(copy.bytes as Uint8Array)).toEqual([1, 2, 3]);
    expect((copy.pattern as RegExp).flags).toBe('gi');
    expect(copy.nested).toEqual({ list: [1, { deep: true }], nothing: null, absent: undefined });
    // Mutating the copy leaves the source alone, which is what pi relies on.
    (copy.nested as { list: unknown[] }).list.push(2);
    expect((copy.nested as { list: unknown[] }).list).toHaveLength(3);
    expect((source.nested as { list: unknown[] }).list).toHaveLength(2);

    expect(() => clone(() => 1)).toThrow('could not be cloned');
    expect(() => clone(Symbol('s'))).toThrow('could not be cloned');
    const err = clone(new RangeError('bad')) as RangeError;
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RangeError');
    expect(err.message).toBe('bad');
    // A non-standard error name degrades to plain Error, and own properties go
    // with it -- the platform keeps only the standard NativeError types.
    class Custom extends Error {
      code = 7;
      constructor(message: string) {
        super(message);
        this.name = 'Custom';
      }
    }
    const degraded = clone(new Custom('nope')) as Error & { code?: number };
    expect(degraded.name).toBe('Error');
    expect(degraded.message).toBe('nope');
    expect(degraded.code).toBeUndefined();
  });

  it('copies a byte view whole, keeping its offset over the full buffer', () => {
    const { guest } = instantiateFetchGuest();
    const clone = guest.structuredClone as typeof structuredClone;
    const buffer = new ArrayBuffer(8);
    new Uint8Array(buffer).set([0, 1, 2, 3, 4, 5, 6, 7]);

    const view = clone(new Uint8Array(buffer, 2, 4));
    expect(Array.from(view)).toEqual([2, 3, 4, 5]);
    expect(view.byteOffset).toBe(2);
    expect(view.buffer.byteLength).toBe(8);
    expect(view.buffer).not.toBe(buffer);

    const dataView = clone(new DataView(buffer, 2, 4));
    expect(dataView.byteOffset).toBe(2);
    expect(dataView.byteLength).toBe(4);
    expect(dataView.buffer.byteLength).toBe(8);
    expect(dataView.getUint8(0)).toBe(2);
  });

  it('keeps every appended value and replaces in place on set', () => {
    const { guest } = instantiateFetchGuest();
    const form = new guest.FormData();
    form.append('a', '1');
    form.append('b', '2');
    form.append('a', '3');
    expect(form.getAll('a')).toEqual(['1', '3']);
    expect(form.get('a')).toBe('1');
    expect(form.get('missing')).toBe(null);
    expect(form.has('b')).toBe(true);
    form.set('a', '9');
    expect(Array.from(form)).toEqual([
      ['a', '9'],
      ['b', '2'],
    ]);
    form.delete('a');
    expect(Array.from(form.keys())).toEqual(['b']);
    expect(Array.from(form.values())).toEqual(['2']);
  });

  it('stringifies primitives and refuses the parts this lane cannot carry', () => {
    const { guest } = instantiateFetchGuest();
    const form = new guest.FormData();
    form.append('n', 42);
    form.append('t', true);
    expect(form.getAll('n')).toEqual(['42']);
    expect(form.getAll('t')).toEqual(['true']);
    // A Blob is carried; anything else that is not a primitive is not.
    expect(() => form.append('f', { name: 'x' })).toThrow(
      'FormData on the isolate lane holds text fields and Blob parts only'
    );
    expect(form.has('f')).toBe(false);
  });

  it('sends a multipart body with a random boundary the field values cannot close', async () => {
    const { guest, opened } = instantiateFetchGuest();
    const form = new guest.FormData();
    form.append('plain', 'hello');
    // A value that spells out a terminator, and a name with the three
    // characters the header line cannot carry raw.
    form.append('sneaky\r\n"x"', '--boundary--');
    await guest.fetch('https://api.example.test/upload', { method: 'POST', body: form });

    expect(opened.length).toBe(1);
    const contentType = opened[0].request.headers.find((h: string[]) => h[0] === 'content-type')?.[1] as string;
    const boundary = /^multipart\/form-data; boundary=(----LobuFormBoundary[0-9a-f]{32})$/.exec(contentType)?.[1];
    expect(boundary).toBeDefined();
    const text = Buffer.from(opened[0].body as Uint8Array).toString('utf8');
    expect(text).toBe(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="plain"\r\n\r\n' +
        'hello\r\n' +
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="sneaky%0D%0A%22x%22"\r\n\r\n' +
        '--boundary--\r\n' +
        `--${boundary}--\r\n`
    );
  });

  it('gives every body its own boundary', async () => {
    const { guest, opened } = instantiateFetchGuest();
    for (let i = 0; i < 2; i++) {
      const form = new guest.FormData();
      form.append('i', String(i));
      await guest.fetch('https://api.example.test/upload', { method: 'POST', body: form });
    }
    const boundaries = opened.map(
      (o) => (o.request.headers.find((h: string[]) => h[0] === 'content-type')?.[1] as string)
    );
    expect(boundaries[0]).not.toBe(boundaries[1]);
  });

  /**
   * The file-part surface `@lobu/plugin-media`'s upload driver needs. It posts
   * a named Blob to the gateway's `/internal/files/upload` route, which reads
   * `formData.get("file")` and rejects anything that is not a file — so the
   * part has to carry a `filename` and a `Content-Type`, and its bytes have to
   * survive verbatim.
   */
  it('carries a Blob part with its own bytes, type and size', async () => {
    const { guest } = instantiateFetchGuest();
    const blob = new guest.Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/PNG' });
    expect(blob.size).toBe(4);
    // The web platform lowercases the media type.
    expect(blob.type).toBe('image/png');
    expect(Object.prototype.toString.call(blob)).toBe('[object Blob]');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(Array.from(await blob.bytes())).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // Parts concatenate, strings encode as UTF-8, and a Blob part is spliced in.
    const joined = new guest.Blob(['a', new Uint8Array([0xc3, 0xa9]), blob]);
    expect(joined.size).toBe(7);
    expect(joined.type).toBe('');
    expect(await new guest.Blob(['héllo']).text()).toBe('héllo');
    expect(new guest.Blob().size).toBe(0);
    // A media type that could break out of the part header is dropped.
    expect(new guest.Blob([], { type: 'text/plain\r\nX-Evil: 1' }).type).toBe('');
  });

  it('sends a file part whose arbitrary bytes survive the multipart body verbatim', async () => {
    const { guest, opened } = instantiateFetchGuest();
    // Every byte 0..255: anything that round-tripped this body through UTF-8
    // would corrupt most of them.
    const raw = new Uint8Array(256);
    for (let i = 0; i < 256; i++) raw[i] = i;
    const form = new guest.FormData();
    form.append('file', new guest.Blob([raw], { type: 'application/octet-stream' }), 'report.bin');
    form.append('filename', 'report.bin');
    await guest.fetch('https://gateway.test/internal/files/upload', { method: 'POST', body: form });

    const contentType = opened[0].request.headers.find((h: string[]) => h[0] === 'content-type')?.[1] as string;
    const boundary = /boundary=(----LobuFormBoundary[0-9a-f]{32})$/.exec(contentType)?.[1] as string;
    const body = Buffer.from(opened[0].body as Uint8Array);

    const header = Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="report.bin"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n',
      'utf8'
    );
    const trailer = Buffer.from(
      `\r\n--${boundary}\r\n` +
        'Content-Disposition: form-data; name="filename"\r\n\r\n' +
        'report.bin\r\n' +
        `--${boundary}--\r\n`,
      'utf8'
    );
    expect(body.subarray(0, header.length)).toEqual(header);
    // The payload is byte-for-byte what went in, not a UTF-8 round trip.
    expect(body.subarray(header.length, header.length + 256)).toEqual(Buffer.from(raw));
    expect(body.subarray(header.length + 256)).toEqual(trailer);
    expect(body.length).toBe(header.length + 256 + trailer.length);
  });

  it('defaults a nameless Blob part to "blob" and octet-stream, and escapes a filename', async () => {
    const { guest, opened } = instantiateFetchGuest();
    const form = new guest.FormData();
    form.append('a', new guest.Blob([new Uint8Array([1])]));
    form.append('b', new guest.Blob([new Uint8Array([2])]), 'a"b\r\nc.txt');
    await guest.fetch('https://gateway.test/internal/files/upload', { method: 'POST', body: form });
    const text = Buffer.from(opened[0].body as Uint8Array).toString('latin1');
    expect(text).toContain('name="a"; filename="blob"\r\nContent-Type: application/octet-stream\r\n');
    expect(text).toContain('name="b"; filename="a%22b%0D%0Ac.txt"');
  });

  it('does not overwrite a content-type the caller already set', async () => {
    const { guest, opened } = instantiateFetchGuest();
    const form = new guest.FormData();
    form.append('a', '1');
    await guest.fetch('https://api.example.test/upload', {
      method: 'POST',
      body: form,
      headers: { 'content-type': 'multipart/form-data; boundary=caller' },
    });
    expect(opened[0].request.headers.find((h: string[]) => h[0] === 'content-type')?.[1]).toBe(
      'multipart/form-data; boundary=caller'
    );
  });
});
