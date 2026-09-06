/**
 * Guest prelude for the connector isolate lane.
 *
 * A bare `isolated-vm` context has ECMAScript plus an inert `console`: no
 * timers, no `URL`, no text codecs, no `fetch`. This prelude installs exactly
 * the web-platform surface the SDK root and the bundled isolate-eligible
 * connectors touch (measured by loading and running them, not by emulating a
 * browser):
 *
 *  - CJS shell (`module`/`exports`) and a `require` that answers a fixed
 *    builtin map (`node:crypto`, `node:buffer`, `node:events`, `node:stream`,
 *    `node:module`, `cloudflare:sockets`) and fails closed on everything else.
 *    `node:stream` is admitted so postgres.js loads; its constructors throw,
 *    because an isolate has no Node streams to give.
 *  - `console.*` to the host `log` capability (the host redacts).
 *  - Timers, `setImmediate` and `queueMicrotask` over the host `sleep`
 *    capability; a callback that throws ends the run through `fatal`, the way
 *    an uncaught exception ended the forked child this replaced.
 *  - `process = { env }` from the job env.
 *  - `TextEncoder`/`TextDecoder` and `atob`/`btoa`: object shells whose
 *    byte-level work the host does with Node's own codecs. A decode with
 *    `{ stream: true }` opens a Node `TextDecoder` on the host that keeps the
 *    partial sequence between chunks until the flushing decode releases it.
 *  - `performance.now()`/`timeOrigin` over `Date`: millisecond resolution is
 *    all just-bash reads it for (command timing), and the isolate has no
 *    monotonic clock of its own to offer.
 *  - `structuredClone`, guest-side: a deep copy of the JSON-shaped values,
 *    dates, regexps, maps, sets, errors and byte arrays a tool call carries,
 *    with cycles preserved. pi-ai clones every tool call's arguments before
 *    validating them, so a lane without it cannot run a single tool.
 *  - `URL` over the host `urlParse`/`urlSet` capabilities: the host runs Node's
 *    own URL, so both lanes agree on every input by construction.
 *    `URLSearchParams` keeps its list guest-side, parses and serializes through
 *    the host, and writes back through `search`.
 *  - `AbortController`/`AbortSignal`.
 *  - `Headers`, `Response` and `fetch` over the host `fetchOpen` / `fetchRead`
 *    capabilities. The host performs the network call and answers with status
 *    and headers as soon as they arrive; the body is a pull `ReadableStream`
 *    the guest drains one host chunk at a time, exactly as a socket's
 *    `readable` is, so an SSE response is consumed as it streams.
 *  - `crypto`: `getRandomValues`/`randomUUID`, plus the `subtle` operations
 *    postgres.js needs to answer an md5 or SCRAM-SHA-256 challenge, all
 *    computed by Node on the host. `require('node:crypto')` additionally
 *    answers with `createHash`/`createHmac`/`randomBytes` over the same host
 *    capabilities, because that specifier is a Node module and not WebCrypto.
 *  - `Buffer`, `EventEmitter`, `ReadableStream`/`WritableStream` and
 *    `connect` (WinterCG Direct Sockets), which the DB connectors need.
 *
 * The guest talks to the host through two `ivm.Reference`s captured at the
 * top of the prelude and removed from the global: `__host_sync(name, ...args)`
 * and `__host_async(name, ...args)`. Every reply is an envelope
 * `{ __lobu: 1, ok, value | error }`; the host never throws across the
 * boundary because an async rejection also surfaces as an unhandled rejection
 * in the host process.
 *
 * `FormData` carries text fields and `Blob` file parts, and serialises itself
 * to a multipart body. It exists at all because the Stainless clients pi's LLM
 * providers are built on test `body instanceof FormData` unguarded on every
 * request, so the guest cannot reach a provider without it; it carries file
 * parts because `@lobu/plugin-media`'s upload driver is one implementation for
 * both lanes and posts a named `Blob` to the gateway's file-upload route.
 * `Blob` itself is the minimum that part needs — bytes, a media type, and the
 * readers the upload path calls — with no `slice`/`stream`.
 *
 * Deliberately absent (no isolate-eligible connector or SDK root path uses
 * them): `Request`, `File`. Add one only with a real caller that needs it.
 *
 * Written as sloppy-mode ES2020 with no template literals so the string can
 * live in this module verbatim. `String.raw` keeps the regex escapes intact.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes as nodeRandomBytes } from 'node:crypto';

/** Names the prelude defines on the guest global. */
export const PRELUDE_GLOBALS = [
  'module',
  'exports',
  'require',
  'console',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
  'process',
  'TextEncoder',
  'TextDecoder',
  'atob',
  'btoa',
  'structuredClone',
  'performance',
  'URL',
  'URLSearchParams',
  'AbortController',
  'AbortSignal',
  'Headers',
  'Blob',
  'FormData',
  'Response',
  'fetch',
  'crypto',
  'Buffer',
  'connect',
  'EventEmitter',
  'ReadableStream',
  'WritableStream',
] as const;

/** What the guest `URL` holds: the components Node's URL reports. */
interface GuestUrlRecord {
  href: string;
  origin: string;
  protocol: string;
  username: string;
  password: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
}

const URL_SETTABLE = new Set(['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']);

function guestUrlRecord(url: URL): GuestUrlRecord {
  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    username: url.username,
    password: url.password,
    host: url.host,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
  };
}

function asBytes(value: unknown, what: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${what}: expected an ArrayBuffer or ArrayBufferView`);
}

/**
 * Node's name for a WebCrypto digest label. `md5` is deliberately accepted even
 * though WebCrypto does not define it: postgres.js asks for it by that name to
 * answer an `AuthenticationMD5Password` challenge, and Node's hash registry
 * has it. A future workerd backend has no md5 and reaches scram-sha-256 servers
 * only.
 */
function nodeHashName(algorithm: unknown, what: string): string {
  const name = String(
    algorithm && typeof algorithm === 'object' ? (algorithm as { name?: unknown }).name : algorithm
  ).toLowerCase().replace('-', '');
  if (name === 'md5' || name === 'sha1' || name === 'sha256' || name === 'sha384' || name === 'sha512') return name;
  throw new TypeError(`${what}: unsupported algorithm '${String(algorithm)}'`);
}

function asPairs(value: unknown): [string, string][] {
  if (!Array.isArray(value)) throw new TypeError('formUrlencodedSerialize: expected a list of [name, value] pairs');
  return value.map((pair) => [String((pair as unknown[])[0]), String((pair as unknown[])[1])]);
}

/**
 * Streaming `TextDecoder`s one guest may hold open at once. A decoder opened
 * with `{ stream: true }` and never flushed (a stream that errored mid-way)
 * stays on the host until the run ends, so the count is bounded here rather
 * than by a hostile guest's loop; an honest guest holds one per open body.
 */
const MAX_OPEN_TEXT_DECODERS = 1024;

/**
 * Host halves of prelude globals that delegate to Node. `IsolateHost` installs
 * a fresh set under every run, so they are part of the guest's standard
 * library rather than a capability a particular executor grants. Pure
 * conversions only: no network, no filesystem. The one piece of state is the
 * registry of streaming `TextDecoder`s, which is why this is a factory and not
 * a table: a decoder's partial sequence belongs to one run.
 */
export function createPreludeHostSync(): Record<string, (...args: unknown[]) => unknown> {
  const decoders = new Map<number, TextDecoder>();
  let nextDecoderId = 1;
  return {
    ...STATELESS_HOST_SYNC,
    /** Open a streaming decoder; the guest holds the id until its flushing decode. */
    textDecoderOpen: (encoding: unknown, fatal: unknown, ignoreBOM: unknown): number => {
      if (decoders.size >= MAX_OPEN_TEXT_DECODERS) {
        throw new RangeError(`textDecoderOpen: more than ${MAX_OPEN_TEXT_DECODERS} streaming decoders are open`);
      }
      const id = nextDecoderId++;
      decoders.set(id, new TextDecoder(String(encoding), { fatal: Boolean(fatal), ignoreBOM: Boolean(ignoreBOM) }));
      return id;
    },
    /**
     * Decode one chunk on an open streaming decoder. A decode without `stream`
     * flushes and releases it, the point at which the spec resets a decoder's
     * state; a fatal error mid-stream keeps it, as the spec does.
     */
    textDecoderDecode: (id: unknown, bytes: unknown, stream: unknown): string => {
      const key = Number(id);
      const decoder = decoders.get(key);
      if (!decoder) throw new TypeError(`textDecoderDecode: no open streaming decoder ${String(id)}`);
      const flush = !stream;
      try {
        return decoder.decode(asBytes(bytes, 'textDecoderDecode'), { stream: !flush });
      } finally {
        if (flush) decoders.delete(key);
      }
    },
  };
}

const STATELESS_HOST_SYNC: Record<string, (...args: unknown[]) => unknown> = {
  urlParse: (input: unknown, base: unknown): GuestUrlRecord =>
    guestUrlRecord(base === undefined || base === null ? new URL(String(input)) : new URL(String(input), String(base))),
  urlSet: (href: unknown, name: unknown, value: unknown): GuestUrlRecord => {
    if (typeof name !== 'string' || !URL_SETTABLE.has(name)) {
      throw new TypeError(`URL has no settable property '${String(name)}'`);
    }
    const url = new URL(String(href));
    (url as unknown as Record<string, string>)[name] = String(value);
    return guestUrlRecord(url);
  },
  utf8Encode: (input: unknown): Uint8Array => new TextEncoder().encode(String(input)),
  /** Canonical name for a `TextDecoder` label; throws Node's RangeError for one it does not support. */
  textEncodingName: (label: unknown): string => new TextDecoder(String(label)).encoding,
  textDecode: (encoding: unknown, bytes: unknown, fatal: unknown, ignoreBOM: unknown): string =>
    new TextDecoder(String(encoding), { fatal: Boolean(fatal), ignoreBOM: Boolean(ignoreBOM) }).decode(
      asBytes(bytes, 'textDecode')
    ),
  base64Encode: (latin1: unknown): string => btoa(String(latin1)),
  base64Decode: (encoded: unknown): string => atob(String(encoded)),
  // The guest has already stripped one leading '?'. A leading '&' is an empty
  // pair the parser skips, so a query that still begins with '?' keeps it.
  formUrlencodedParse: (input: unknown): [string, string][] => Array.from(new URLSearchParams(`&${String(input)}`)),
  formUrlencodedSerialize: (list: unknown): string => new URLSearchParams(asPairs(list)).toString(),
  /**
   * Node's CSPRNG, never a fallback: a silently-zeroed buffer here would be a
   * predictable nonce or UUID in the guest with nothing to signal it.
   */
  randomBytes: (byteLength: unknown): Uint8Array => {
    const len = Math.min(Math.max(0, Number(byteLength) || 0), 65536);
    return new Uint8Array(nodeRandomBytes(len));
  },
  /**
   * WebCrypto primitives behind the guest's `crypto.subtle`. postgres.js's
   * workerd build drives BOTH md5 and SCRAM-SHA-256 authentication entirely
   * through `crypto.subtle`, so without these a DB connector cannot
   * authenticate against any server that is not on cleartext `password` auth.
   * Node does the work; the guest only marshals bytes.
   */
  cryptoDigest: (algorithm: unknown, data: unknown): Uint8Array =>
    new Uint8Array(createHash(nodeHashName(algorithm, 'cryptoDigest')).update(asBytes(data, 'cryptoDigest')).digest()),
  cryptoHmac: (hash: unknown, key: unknown, data: unknown): Uint8Array =>
    new Uint8Array(
      createHmac(nodeHashName(hash, 'cryptoHmac'), asBytes(key, 'cryptoHmac'))
        .update(asBytes(data, 'cryptoHmac'))
        .digest()
    ),
  /**
   * Bounded because this runs SYNCHRONOUSLY on the host event loop: a guest
   * that asked for a billion rounds would wedge the worker. SCRAM negotiates
   * its own count (postgres sends 4096), so the ceiling is never reached by an
   * honest server.
   */
  cryptoPbkdf2: (hash: unknown, password: unknown, salt: unknown, iterations: unknown, byteLength: unknown): Uint8Array => {
    const rounds = Number(iterations);
    const length = Number(byteLength);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100_000) {
      throw new RangeError(`cryptoPbkdf2: iterations must be an integer in 1..100000, got ${String(iterations)}`);
    }
    if (!Number.isInteger(length) || length < 1 || length > 1024) {
      throw new RangeError(`cryptoPbkdf2: byteLength must be an integer in 1..1024, got ${String(byteLength)}`);
    }
    return new Uint8Array(
      pbkdf2Sync(
        asBytes(password, 'cryptoPbkdf2'),
        asBytes(salt, 'cryptoPbkdf2'),
        rounds,
        length,
        nodeHashName(hash, 'cryptoPbkdf2')
      )
    );
  },
};

export const GUEST_PRELUDE = String.raw`
var module = { exports: {} };
var exports = module.exports;
(function (global) {
  var hostSyncRef = global.__host_sync;
  var hostAsyncRef = global.__host_async;
  var envJson = global.__host_env_json;
  delete global.__host_sync;
  delete global.__host_async;
  delete global.__host_env_json;

  // ---------------------------------------------------------------------------
  // Host bridge
  // ---------------------------------------------------------------------------

  var STANDARD_ERRORS = { TypeError: TypeError, RangeError: RangeError, SyntaxError: SyntaxError, ReferenceError: ReferenceError };

  function makeError(desc) {
    var Ctor = STANDARD_ERRORS[desc && desc.name] || Error;
    var err = new Ctor(desc && desc.message ? String(desc.message) : 'host call failed');
    if (Ctor === Error && desc && desc.name) err.name = String(desc.name);
    if (desc && desc.code !== undefined) err.code = desc.code;
    if (desc && typeof desc.httpStatus === 'number') err.status = desc.httpStatus;
    return err;
  }

  function unwrap(envelope) {
    if (!envelope || envelope.__lobu !== 1) throw new Error('InvalidHostEnvelope: host capability returned a malformed reply');
    if (envelope.ok) return envelope.value;
    throw makeError(envelope.error);
  }

  function hostSync(name) {
    var args = Array.prototype.slice.call(arguments);
    return unwrap(hostSyncRef.applySync(undefined, args, { arguments: { copy: true }, result: { copy: true } }));
  }

  function hostAsync(name) {
    var args = Array.prototype.slice.call(arguments);
    return hostAsyncRef
      .apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } })
      .then(unwrap);
  }

  function describeError(error) {
    if (error instanceof Error) {
      var desc = { name: String(error.name || 'Error'), message: String(error.message), stack: typeof error.stack === 'string' ? error.stack : undefined };
      if (typeof error.status === 'number' && error.status >= 100 && error.status < 600) desc.httpStatus = error.status;
      return desc;
    }
    var text;
    try { text = typeof error === 'string' ? error : JSON.stringify(error); } catch (e) { text = String(error); }
    return { name: 'Error', message: text === undefined ? String(error) : text };
  }

  // An exception escaping a timer callback has no catcher in the guest. The
  // forked child this replaced treated the same case as uncaughtException and
  // ended the run with that error; do the same through the host.
  function reportFatal(error) {
    try { hostSync('fatal', describeError(error)); } catch (e) {}
  }

  global.__lobuHost = Object.freeze({ sync: hostSync, async: hostAsync, describeError: describeError });

  // ---------------------------------------------------------------------------
  // require: fail closed
  // ---------------------------------------------------------------------------

  global.require = function require(specifier) {
    if (specifier === 'crypto' || specifier === 'node:crypto') return global.__lobuNodeCrypto;
    if (specifier === 'buffer' || specifier === 'node:buffer') return { Buffer: global.Buffer };
    if (specifier === 'events' || specifier === 'node:events') return { EventEmitter: global.EventEmitter, default: global.EventEmitter };
    // node:stream is ADMITTED, not implemented. postgres.js reads Readable,
    // Writable and Duplex off the module at load time (only its COPY helpers
    // construct them), so throwing here would make the DB connectors
    // unloadable -- but Node streams are not web streams, and handing back a
    // web ReadableStream produced a silently wrong object instead of an error.
    if (specifier === 'stream' || specifier === 'node:stream') return global.__lobuNodeStream;
    if (specifier === 'cloudflare:sockets') return { connect: global.connect };
    if (specifier === 'module' || specifier === 'node:module') return { createRequire: function () { return global.require; } };
    var err = new Error(
      "Module '" + specifier + "' is not available in the connector isolate. Node builtins and runtime-provided packages are not reachable here."
    );
    err.name = 'IsolateLaneIneligible';
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };

  // ---------------------------------------------------------------------------
  // console
  // ---------------------------------------------------------------------------

  function formatArg(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return typeof value.stack === 'string' && value.stack ? value.stack : value.name + ': ' + value.message;
    if (typeof value === 'symbol') return value.toString();
    if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
    if (typeof value === 'bigint') return String(value) + 'n';
    if (value === undefined) return 'undefined';
    try {
      var json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (e) {
      return String(value);
    }
  }

  function emitConsole(level, args) {
    var text = Array.prototype.map.call(args, formatArg).join(' ');
    try { hostSync('log', level, text); } catch (e) {}
  }

  function noop() {}
  var consoleObject = {
    log: function () { emitConsole('log', arguments); },
    info: function () { emitConsole('info', arguments); },
    debug: function () { emitConsole('debug', arguments); },
    warn: function () { emitConsole('warn', arguments); },
    error: function () { emitConsole('error', arguments); },
    trace: function () { emitConsole('error', arguments); },
    dir: function (value) { emitConsole('log', [value]); },
    table: function (value) { emitConsole('log', [value]); },
    assert: function (condition) {
      if (!condition) emitConsole('error', ['Assertion failed'].concat(Array.prototype.slice.call(arguments, 1)));
    },
    group: noop, groupCollapsed: noop, groupEnd: noop, time: noop, timeEnd: noop, timeLog: noop, count: noop, countReset: noop
  };
  global.console = consoleObject;

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  var timerSeq = 0;
  var timers = new Map();

  function normalizeDelay(ms) {
    ms = Number(ms);
    if (!Number.isFinite(ms) || ms < 0) return 0;
    if (ms > 2147483647) return 1;
    return Math.floor(ms);
  }

  function makeTimer(fn, ms, args, interval) {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    var id = ++timerSeq;
    var handle = {
      id: id,
      ref: function () { return this; },
      unref: function () { return this; },
      hasRef: function () { return true; },
      refresh: function () { return this; },
      valueOf: function () { return id; }
    };
    handle[Symbol.toPrimitive] = function () { return id; };
    var entry = { id: id, fn: fn, args: args, ms: normalizeDelay(ms), interval: interval, cancelled: false, handle: handle };
    timers.set(id, entry);
    schedule(entry);
    return handle;
  }

  function schedule(entry) {
    hostAsync('sleep', entry.ms).then(
      function () {
        var live = timers.get(entry.id);
        if (!live || live.cancelled) return;
        if (!live.interval) timers.delete(live.id);
        try {
          live.fn.apply(undefined, live.args);
        } catch (err) {
          reportFatal(err);
          return;
        }
        if (live.interval && !live.cancelled) schedule(live);
      },
      function () {
        timers.delete(entry.id);
      }
    );
  }

  function cancelTimer(handle) {
    if (handle == null) return;
    var id = typeof handle === 'object' ? handle.id : Number(handle);
    var entry = timers.get(id);
    if (!entry) return;
    entry.cancelled = true;
    timers.delete(id);
  }

  global.setTimeout = function setTimeout(fn, ms) { return makeTimer(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
  global.setInterval = function setInterval(fn, ms) { return makeTimer(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
  global.setImmediate = function setImmediate(fn) { return makeTimer(fn, 0, Array.prototype.slice.call(arguments, 1), false); };
  global.clearTimeout = cancelTimer;
  global.clearInterval = cancelTimer;
  global.clearImmediate = cancelTimer;
  global.queueMicrotask = function queueMicrotask(fn) {
    if (typeof fn !== 'function') throw new TypeError('The "callback" argument must be of type function');
    Promise.resolve().then(function () {
      try { fn(); } catch (err) { reportFatal(err); }
    });
  };

  // ---------------------------------------------------------------------------
  // process
  // ---------------------------------------------------------------------------

  var env = {};
  try {
    var parsedEnv = envJson ? JSON.parse(envJson) : null;
    if (parsedEnv && typeof parsedEnv === 'object') {
      for (var envKey in parsedEnv) {
        if (parsedEnv[envKey] !== undefined && parsedEnv[envKey] !== null) env[envKey] = String(parsedEnv[envKey]);
      }
    }
  } catch (e) {}
  global.process = { env: env };

  // ---------------------------------------------------------------------------
  // Text codecs: the host runs Node's TextEncoder/TextDecoder
  // ---------------------------------------------------------------------------

  function utf8Encode(input) {
    return hostSync('utf8Encode', String(input));
  }

  function utf8Decode(bytes) {
    return hostSync('textDecode', 'utf-8', bytes, false, false);
  }

  function toBytes(input, what) {
    if (input === undefined) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new TypeError(what + ': argument must be an ArrayBuffer or ArrayBufferView');
  }

  function TextEncoder() {
    if (!(this instanceof TextEncoder)) throw new TypeError("Class constructor TextEncoder cannot be invoked without 'new'");
  }
  Object.defineProperty(TextEncoder.prototype, 'encoding', { get: function () { return 'utf-8'; }, enumerable: true });
  TextEncoder.prototype.encode = function encode(input) {
    return utf8Encode(input === undefined ? '' : input);
  };
  TextEncoder.prototype.encodeInto = function encodeInto(source, destination) {
    var bytes = utf8Encode(source);
    var written = Math.min(bytes.length, destination.length);
    // Never split a code point: back off to the last complete sequence.
    while (written > 0 && written < bytes.length && (bytes[written] & 0xc0) === 0x80) written--;
    destination.set(bytes.subarray(0, written));
    var read = hostSync('textDecode', 'utf-8', bytes.slice(0, written), false, true).length;
    return { read: read, written: written };
  };

  function TextDecoder(label, options) {
    if (!(this instanceof TextDecoder)) throw new TypeError("Class constructor TextDecoder cannot be invoked without 'new'");
    this._encoding = hostSync('textEncodingName', label === undefined ? 'utf-8' : String(label));
    this._fatal = !!(options && options.fatal);
    this._ignoreBOM = !!(options && options.ignoreBOM);
    // The host decoder holding this decoder's partial sequence while a
    // { stream: true } sequence of decodes is in progress; null between them.
    this._streamId = null;
  }
  Object.defineProperty(TextDecoder.prototype, 'encoding', { get: function () { return this._encoding; }, enumerable: true });
  Object.defineProperty(TextDecoder.prototype, 'fatal', { get: function () { return this._fatal; }, enumerable: true });
  Object.defineProperty(TextDecoder.prototype, 'ignoreBOM', { get: function () { return this._ignoreBOM; }, enumerable: true });
  TextDecoder.prototype.decode = function decode(input, options) {
    var bytes = toBytes(input, 'TextDecoder.decode');
    var stream = !!(options && options.stream);
    if (this._streamId === null) {
      if (!stream) return hostSync('textDecode', this._encoding, bytes, this._fatal, this._ignoreBOM);
      this._streamId = hostSync('textDecoderOpen', this._encoding, this._fatal, this._ignoreBOM);
    }
    var id = this._streamId;
    // The flushing decode releases the host decoder whether or not it throws.
    if (!stream) this._streamId = null;
    return hostSync('textDecoderDecode', id, bytes, stream);
  };

  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;

  // ---------------------------------------------------------------------------
  // base64: the host runs Node's btoa/atob
  // ---------------------------------------------------------------------------

  global.btoa = function btoa(data) {
    if (arguments.length === 0) throw new TypeError('1 argument required, but only 0 present');
    return hostSync('base64Encode', String(data));
  };

  global.atob = function atob(data) {
    if (arguments.length === 0) throw new TypeError('1 argument required, but only 0 present');
    return hostSync('base64Decode', String(data));
  };

  // ---------------------------------------------------------------------------
  // performance: wall-clock milliseconds; the isolate has no monotonic clock
  // ---------------------------------------------------------------------------

  var performanceTimeOrigin = Date.now();
  global.performance = Object.freeze({
    timeOrigin: performanceTimeOrigin,
    now: function now() { return Date.now() - performanceTimeOrigin; },
  });

  // ---------------------------------------------------------------------------
  // structuredClone: guest-side deep copy; nothing here needs the host
  // ---------------------------------------------------------------------------

  function dataCloneError(what) {
    var err = new Error(what + ' could not be cloned.');
    err.name = 'DataCloneError';
    return err;
  }

  // The error types a clone may keep. Everything else becomes a plain Error.
  var NATIVE_ERRORS = {
    Error: Error,
    EvalError: EvalError,
    RangeError: RangeError,
    ReferenceError: ReferenceError,
    SyntaxError: SyntaxError,
    TypeError: TypeError,
    URIError: URIError,
  };

  function structuredCloneValue(value, seen) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      if (typeof value === 'symbol') throw dataCloneError('Symbol()');
      return value;
    }
    if (typeof value === 'function') throw dataCloneError(String(value).slice(0, 40));
    if (seen.has(value)) return seen.get(value);
    var out;
    if (Array.isArray(value)) {
      out = new Array(value.length);
      seen.set(value, out);
      for (var i = 0; i < value.length; i++) out[i] = structuredCloneValue(value[i], seen);
      return out;
    }
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return new RegExp(value.source, value.flags);
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      // The whole buffer is copied and the view keeps its offset, as the
      // platform does -- constructing from the view alone would instead
      // compact it onto a fresh buffer of its own length, losing byteOffset
      // and any bytes outside the window.
      var viewBuffer = value.buffer.slice(0);
      if (value instanceof DataView) return new DataView(viewBuffer, value.byteOffset, value.byteLength);
      return new value.constructor(viewBuffer, value.byteOffset, value.length);
    }
    if (value instanceof Map) {
      out = new Map();
      seen.set(value, out);
      value.forEach(function (v, k) { out.set(structuredCloneValue(k, seen), structuredCloneValue(v, seen)); });
      return out;
    }
    if (value instanceof Set) {
      out = new Set();
      seen.set(value, out);
      value.forEach(function (v) { out.add(structuredCloneValue(v, seen)); });
      return out;
    }
    if (value instanceof Error) {
      // Only the standard NativeError names survive; anything else (a subclass
      // with its own name, AggregateError, DOMException) degrades to Error, as
      // the platform does. Own properties are dropped either way.
      var Ctor = NATIVE_ERRORS[value.name] || Error;
      out = new Ctor(value.message);
      out.name = Ctor.prototype.name;
      if (typeof value.stack === 'string') out.stack = value.stack;
      seen.set(value, out);
      if ('cause' in value) out.cause = structuredCloneValue(value.cause, seen);
      return out;
    }
    if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet) {
      throw dataCloneError(Object.prototype.toString.call(value));
    }
    // Everything else clones as a plain object of its own enumerable string
    // keys, prototype dropped -- what the platform does with a class instance.
    out = {};
    seen.set(value, out);
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) out[keys[k]] = structuredCloneValue(value[keys[k]], seen);
    return out;
  }

  global.structuredClone = function structuredClone(value) {
    if (arguments.length === 0) throw new TypeError('1 argument required, but only 0 present');
    return structuredCloneValue(value, new Map());
  };

  // ---------------------------------------------------------------------------
  // URLSearchParams: the list lives here; the host parses and serializes it
  // ---------------------------------------------------------------------------

  function parseFormUrlencoded(input) {
    return hostSync('formUrlencodedParse', String(input));
  }
  function serializeFormUrlencoded(list) {
    return hostSync('formUrlencodedSerialize', list);
  }

  function URLSearchParams(init) {
    if (!(this instanceof URLSearchParams)) throw new TypeError("Class constructor URLSearchParams cannot be invoked without 'new'");
    this._list = [];
    this._url = null;
    if (init === undefined || init === null) return;
    if (typeof init === 'object') {
      if (init instanceof URLSearchParams) {
        this._list = init._list.map(function (p) { return [p[0], p[1]]; });
      } else if (typeof init[Symbol.iterator] === 'function') {
        for (var pair of init) {
          if (pair === null || typeof pair !== 'object' || typeof pair[Symbol.iterator] !== 'function') throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          var items = Array.from(pair);
          if (items.length !== 2) throw new TypeError('Each query pair must be an iterable [name, value] tuple');
          this._list.push([String(items[0]), String(items[1])]);
        }
      } else {
        var keys = Object.keys(init);
        for (var i = 0; i < keys.length; i++) this._list.push([keys[i], String(init[keys[i]])]);
      }
      return;
    }
    var str = String(init);
    if (str.length > 0 && str[0] === '?') str = str.slice(1);
    this._list = parseFormUrlencoded(str);
  }
  URLSearchParams.prototype._update = function () {
    // The spec's update steps: serialize the list and set the URL's query
    // (empty list = no query). The host's URL setter does the rest.
    if (!this._url) return;
    this._url._record = hostSync('urlSet', this._url._record.href, 'search', serializeFormUrlencoded(this._list));
  };
  Object.defineProperty(URLSearchParams.prototype, 'size', { get: function () { return this._list.length; }, enumerable: true });
  URLSearchParams.prototype.append = function (name, value) {
    if (arguments.length < 2) throw new TypeError('2 arguments required, but only ' + arguments.length + ' present');
    this._list.push([String(name), String(value)]);
    this._update();
  };
  URLSearchParams.prototype.delete = function (name, value) {
    name = String(name);
    var hasValue = arguments.length > 1 && value !== undefined;
    if (hasValue) value = String(value);
    this._list = this._list.filter(function (p) { return !(p[0] === name && (!hasValue || p[1] === value)); });
    this._update();
  };
  URLSearchParams.prototype.get = function (name) {
    name = String(name);
    for (var i = 0; i < this._list.length; i++) if (this._list[i][0] === name) return this._list[i][1];
    return null;
  };
  URLSearchParams.prototype.getAll = function (name) {
    name = String(name);
    return this._list.filter(function (p) { return p[0] === name; }).map(function (p) { return p[1]; });
  };
  URLSearchParams.prototype.has = function (name, value) {
    name = String(name);
    var hasValue = arguments.length > 1 && value !== undefined;
    if (hasValue) value = String(value);
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i][0] === name && (!hasValue || this._list[i][1] === value)) return true;
    }
    return false;
  };
  URLSearchParams.prototype.set = function (name, value) {
    if (arguments.length < 2) throw new TypeError('2 arguments required, but only ' + arguments.length + ' present');
    name = String(name);
    value = String(value);
    var replaced = false;
    var next = [];
    for (var i = 0; i < this._list.length; i++) {
      if (this._list[i][0] === name) {
        if (!replaced) {
          next.push([name, value]);
          replaced = true;
        }
      } else {
        next.push(this._list[i]);
      }
    }
    if (!replaced) next.push([name, value]);
    this._list = next;
    this._update();
  };
  URLSearchParams.prototype.sort = function () {
    // Stable sort by name, comparing UTF-16 code units.
    this._list = this._list
      .map(function (p, i) { return { p: p, i: i }; })
      .sort(function (a, b) { return a.p[0] < b.p[0] ? -1 : a.p[0] > b.p[0] ? 1 : a.i - b.i; })
      .map(function (e) { return e.p; });
    this._update();
  };
  URLSearchParams.prototype.forEach = function (callback, thisArg) {
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    for (var i = 0; i < this._list.length; i++) callback.call(thisArg, this._list[i][1], this._list[i][0], this);
  };
  URLSearchParams.prototype.entries = function () { return this._list.map(function (p) { return [p[0], p[1]]; })[Symbol.iterator](); };
  URLSearchParams.prototype.keys = function () { return this._list.map(function (p) { return p[0]; })[Symbol.iterator](); };
  URLSearchParams.prototype.values = function () { return this._list.map(function (p) { return p[1]; })[Symbol.iterator](); };
  URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
  URLSearchParams.prototype.toString = function () { return serializeFormUrlencoded(this._list); };
  Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, { value: 'URLSearchParams', configurable: true });

  // ---------------------------------------------------------------------------
  // URL: parsed by the host
  // ---------------------------------------------------------------------------

  // The guest holds a plain record of the components. Every parse and every
  // setter is one synchronous host call into Node's own URL, so the guest and
  // Node agree on every input by construction, IDNA hosts and the
  // percent-encode sets included (those have drifted between Node lines).

  var URL_SETTABLE = ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];

  function stripQuestion(search) { return search.length > 0 && search[0] === '?' ? search.slice(1) : search; }

  function URL(input, base) {
    if (!(this instanceof URL)) throw new TypeError("Class constructor URL cannot be invoked without 'new'");
    if (arguments.length === 0) throw new TypeError('The "url" argument must be specified');
    this._record = hostSync('urlParse', String(input), base === undefined ? undefined : String(base));
    this._searchParams = new URLSearchParams(stripQuestion(this._record.search));
    this._searchParams._url = this;
  }
  URL.canParse = function canParse(input, base) {
    try {
      new URL(input, base);
      return true;
    } catch (e) {
      return false;
    }
  };
  URL.parse = function parse(input, base) {
    try {
      return new URL(input, base);
    } catch (e) {
      return null;
    }
  };
  URL_SETTABLE.forEach(function (name) {
    Object.defineProperty(URL.prototype, name, {
      get: function () { return this._record[name]; },
      set: function (value) {
        this._record = hostSync('urlSet', this._record.href, name, String(value));
        // Node re-parses searchParams whenever the URL is re-serialized.
        this._searchParams._list = parseFormUrlencoded(stripQuestion(this._record.search));
      },
      enumerable: true,
      configurable: true
    });
  });
  Object.defineProperty(URL.prototype, 'origin', { get: function () { return this._record.origin; }, enumerable: true, configurable: true });
  Object.defineProperty(URL.prototype, 'searchParams', { get: function () { return this._searchParams; }, enumerable: true, configurable: true });
  URL.prototype.toString = function () { return this._record.href; };
  URL.prototype.toJSON = function () { return this._record.href; };
  Object.defineProperty(URL.prototype, Symbol.toStringTag, { value: 'URL', configurable: true });

  global.URL = URL;
  global.URLSearchParams = URLSearchParams;

  // ---------------------------------------------------------------------------
  // AbortController / AbortSignal
  // ---------------------------------------------------------------------------

  function abortError(message) {
    var err = new Error(message || 'This operation was aborted');
    err.name = 'AbortError';
    err.code = 20;
    return err;
  }
  function timeoutError() {
    var err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    err.code = 23;
    return err;
  }

  function AbortSignal() {
    if (!(this instanceof AbortSignal)) throw new TypeError("Class constructor AbortSignal cannot be invoked without 'new'");
    this._aborted = false;
    this._reason = undefined;
    this._listeners = [];
    this.onabort = null;
  }
  Object.defineProperty(AbortSignal.prototype, 'aborted', { get: function () { return this._aborted; }, enumerable: true });
  Object.defineProperty(AbortSignal.prototype, 'reason', { get: function () { return this._reason; }, enumerable: true });
  AbortSignal.prototype.throwIfAborted = function () {
    if (this._aborted) throw this._reason;
  };
  AbortSignal.prototype.addEventListener = function (type, listener, options) {
    if (type !== 'abort' || (typeof listener !== 'function' && !(listener && typeof listener.handleEvent === 'function'))) return;
    var once = !!(options && typeof options === 'object' && options.once);
    for (var i = 0; i < this._listeners.length; i++) if (this._listeners[i].listener === listener) return;
    this._listeners.push({ listener: listener, once: once });
    if (options && typeof options === 'object' && options.signal && typeof options.signal.addEventListener === 'function') {
      var self = this;
      options.signal.addEventListener('abort', function () { self.removeEventListener('abort', listener); }, { once: true });
    }
  };
  AbortSignal.prototype.removeEventListener = function (type, listener) {
    if (type !== 'abort') return;
    this._listeners = this._listeners.filter(function (l) { return l.listener !== listener; });
  };
  AbortSignal.prototype.dispatchEvent = function (event) {
    if (!event || event.type !== 'abort') return true;
    fireAbort(this, event);
    return true;
  };
  function fireAbort(signal, event) {
    event = event || { type: 'abort' };
    try { event.target = signal; event.currentTarget = signal; } catch (e) {}
    var listeners = signal._listeners.slice();
    signal._listeners = signal._listeners.filter(function (l) { return !l.once; });
    if (typeof signal.onabort === 'function') {
      try { signal.onabort.call(signal, event); } catch (err) { reportFatal(err); }
    }
    for (var i = 0; i < listeners.length; i++) {
      var l = listeners[i].listener;
      try {
        if (typeof l === 'function') l.call(signal, event);
        else l.handleEvent(event);
      } catch (err) {
        reportFatal(err);
      }
    }
  }
  function signalAbort(signal, reason) {
    if (signal._aborted) return;
    signal._aborted = true;
    signal._reason = reason === undefined ? abortError() : reason;
    fireAbort(signal, { type: 'abort' });
    if (signal._dependents) {
      var deps = signal._dependents;
      signal._dependents = null;
      for (var i = 0; i < deps.length; i++) signalAbort(deps[i], signal._reason);
    }
  }
  AbortSignal.abort = function (reason) {
    var signal = new AbortSignal();
    signalAbort(signal, reason === undefined ? abortError() : reason);
    return signal;
  };
  AbortSignal.timeout = function (ms) {
    var signal = new AbortSignal();
    global.setTimeout(function () { signalAbort(signal, timeoutError()); }, ms);
    return signal;
  };
  AbortSignal.any = function (signals) {
    var result = new AbortSignal();
    var list = Array.from(signals);
    for (var i = 0; i < list.length; i++) {
      if (list[i]._aborted) {
        signalAbort(result, list[i]._reason);
        return result;
      }
    }
    for (var j = 0; j < list.length; j++) {
      if (!list[j]._dependents) list[j]._dependents = [];
      list[j]._dependents.push(result);
    }
    return result;
  };
  Object.defineProperty(AbortSignal.prototype, Symbol.toStringTag, { value: 'AbortSignal', configurable: true });

  function AbortController() {
    if (!(this instanceof AbortController)) throw new TypeError("Class constructor AbortController cannot be invoked without 'new'");
    this.signal = new AbortSignal();
  }
  AbortController.prototype.abort = function (reason) {
    signalAbort(this.signal, reason === undefined ? abortError() : reason);
  };
  Object.defineProperty(AbortController.prototype, Symbol.toStringTag, { value: 'AbortController', configurable: true });

  global.AbortSignal = AbortSignal;
  global.AbortController = AbortController;

  // ---------------------------------------------------------------------------
  // Headers
  // ---------------------------------------------------------------------------

  var HEADER_NAME_RE = /^[!#$%&'*+\-.^_` + '`' + String.raw`|~0-9A-Za-z]+$/;
  function normalizeHeaderName(name) {
    name = String(name);
    if (!HEADER_NAME_RE.test(name)) throw new TypeError('Header name must be a valid HTTP token ["' + name + '"]');
    return name.toLowerCase();
  }
  function normalizeHeaderValue(name, value) {
    value = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (/[\0\n\r]/.test(value)) throw new TypeError('Invalid character in header value ["' + name + '"]');
    return value;
  }

  function Headers(init) {
    if (!(this instanceof Headers)) throw new TypeError("Class constructor Headers cannot be invoked without 'new'");
    this._map = new Map();
    if (init === undefined || init === null) return;
    if (init instanceof Headers) {
      var self = this;
      init._map.forEach(function (values, key) { self._map.set(key, values.slice()); });
      return;
    }
    if (typeof init === 'object' && typeof init[Symbol.iterator] === 'function') {
      for (var pair of init) {
        var items = Array.from(pair);
        if (items.length !== 2) throw new TypeError('Headers constructor: expected name/value pair to be length 2, found ' + items.length);
        this.append(items[0], items[1]);
      }
      return;
    }
    if (typeof init === 'object') {
      var keys = Object.keys(init);
      for (var i = 0; i < keys.length; i++) this.append(keys[i], init[keys[i]]);
      return;
    }
    throw new TypeError('Headers constructor: init must be an object or iterable');
  }
  Headers.prototype.append = function (name, value) {
    var key = normalizeHeaderName(name);
    var v = normalizeHeaderValue(key, value);
    var existing = this._map.get(key);
    if (existing) existing.push(v);
    else this._map.set(key, [v]);
  };
  Headers.prototype.set = function (name, value) {
    var key = normalizeHeaderName(name);
    this._map.set(key, [normalizeHeaderValue(key, value)]);
  };
  Headers.prototype.get = function (name) {
    var values = this._map.get(normalizeHeaderName(name));
    if (!values) return null;
    return values.join(', ');
  };
  Headers.prototype.getSetCookie = function () {
    var values = this._map.get('set-cookie');
    return values ? values.slice() : [];
  };
  Headers.prototype.has = function (name) { return this._map.has(normalizeHeaderName(name)); };
  Headers.prototype.delete = function (name) { this._map.delete(normalizeHeaderName(name)); };
  Headers.prototype._sortedEntries = function () {
    var out = [];
    var keys = Array.from(this._map.keys()).sort();
    for (var i = 0; i < keys.length; i++) {
      var values = this._map.get(keys[i]);
      if (keys[i] === 'set-cookie') {
        for (var j = 0; j < values.length; j++) out.push([keys[i], values[j]]);
      } else {
        out.push([keys[i], values.join(', ')]);
      }
    }
    return out;
  };
  Headers.prototype.forEach = function (callback, thisArg) {
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    var entries = this._sortedEntries();
    for (var i = 0; i < entries.length; i++) callback.call(thisArg, entries[i][1], entries[i][0], this);
  };
  Headers.prototype.entries = function () { return this._sortedEntries()[Symbol.iterator](); };
  Headers.prototype.keys = function () { return this._sortedEntries().map(function (e) { return e[0]; })[Symbol.iterator](); };
  Headers.prototype.values = function () { return this._sortedEntries().map(function (e) { return e[1]; })[Symbol.iterator](); };
  Headers.prototype[Symbol.iterator] = Headers.prototype.entries;
  Object.defineProperty(Headers.prototype, Symbol.toStringTag, { value: 'Headers', configurable: true });
  global.Headers = Headers;

  // ---------------------------------------------------------------------------
  // FormData
  // ---------------------------------------------------------------------------

  // Text fields, plus the one binary part shape the lane actually sends.
  //
  // Present at all because the Stainless clients pi's providers use evaluate
  // "body instanceof FormData" UNGUARDED on every request they send
  // (@anthropic-ai/sdk client.mjs, openai client.mjs), so a guest without the
  // constructor cannot reach any LLM at all.
  //
  // File parts exist because @lobu/plugin-media's upload driver is ONE
  // implementation for both lanes: it hands the gateway's file-upload route a
  // named Blob, and that route reads formData.get("file") and rejects anything
  // that is not a file. Carrying it here is what lets the isolate lane run the
  // plugin's own upload_file/generate_image/generate_audio rather than a
  // second, isolate-only copy that hand-rolls a multipart body.
  //
  // Anything that is neither a primitive nor a Blob is still refused rather
  // than stringified into "[object Object]".

  function formDataValue(value) {
    if (value instanceof Blob) return value;
    if (value !== null && typeof value === 'object') {
      throw new TypeError('FormData on the isolate lane holds text fields and Blob parts only');
    }
    return String(value);
  }

  // ---------------------------------------------------------------------------
  // Blob
  // ---------------------------------------------------------------------------

  // The minimum a multipart file part needs: bytes, a media type, and the
  // readers the upload path uses. Parts are concatenated at construction, so a
  // Blob owns exactly one buffer and nothing streams; the upload driver already
  // caps the bytes it passes in (LOBU_MAX_UPLOAD_BYTES), so this never holds
  // more than that cap.
  //
  // Not implemented: slice(), stream(), and the endings/lastModified options.
  // No caller on this lane reaches for them, and the header comment's rule is
  // to add web surface only for a caller that needs it.

  function blobBytes(parts) {
    if (parts === undefined) return new Uint8Array(0);
    if (!Array.isArray(parts) && typeof parts !== 'object') {
      throw new TypeError('Blob constructor: the first argument must be iterable');
    }
    var chunks = [];
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var bytes;
      if (part instanceof Blob) {
        bytes = part._bytes;
      } else if (part instanceof Uint8Array || part instanceof ArrayBuffer || ArrayBuffer.isView(part)) {
        bytes = toBytes(part, 'Blob');
      } else {
        bytes = utf8Encode(String(part));
      }
      chunks.push(bytes);
      total += bytes.length;
    }
    var out = new Uint8Array(total);
    var at = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], at);
      at += chunks[j].length;
    }
    return out;
  }

  function Blob(parts, options) {
    if (!(this instanceof Blob)) throw new TypeError("Class constructor Blob cannot be invoked without 'new'");
    this._bytes = blobBytes(parts);
    var type = options && options.type !== undefined ? String(options.type) : '';
    // A media type with a raw CR/LF would break out of the part header it is
    // written into; the web platform lowercases and drops invalid types.
    this._type = /[\r\n]/.test(type) ? '' : type.toLowerCase();
  }
  Object.defineProperty(Blob.prototype, 'size', { get: function () { return this._bytes.length; }, enumerable: true });
  Object.defineProperty(Blob.prototype, 'type', { get: function () { return this._type; }, enumerable: true });
  Blob.prototype.arrayBuffer = function () {
    var b = this._bytes;
    return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  Blob.prototype.bytes = function () {
    return Promise.resolve(new Uint8Array(this._bytes));
  };
  Blob.prototype.text = function () {
    return Promise.resolve(utf8Decode(this._bytes));
  };
  Object.defineProperty(Blob.prototype, Symbol.toStringTag, { value: 'Blob', configurable: true });
  global.Blob = Blob;

  // WHATWG "escape a form field name": normalise the line breaks, then
  // percent-encode the three characters that would break the header line.
  function escapeFormName(name) {
    return String(name)
      .replace(/\r\n|\r|\n/g, '\r\n')
      .replace(/"/g, '%22')
      .replace(/\r/g, '%0D')
      .replace(/\n/g, '%0A');
  }

  // A Blob part defaults to the web platform's "blob" filename; a string part
  // never carries one.
  function formDataFilename(value, filename) {
    if (!(value instanceof Blob)) return null;
    return filename === undefined ? 'blob' : escapeFormName(filename);
  }

  function FormData(form) {
    if (!(this instanceof FormData)) throw new TypeError("Class constructor FormData cannot be invoked without 'new'");
    if (form !== undefined && form !== null) throw new TypeError('FormData constructor: no HTMLFormElement on the isolate lane');
    this._entries = [];
  }
  // The third argument is the part's filename, and it is what turns a Blob
  // part into a FILE part on the wire. Ignored for a string value, exactly as
  // the web platform ignores it.
  FormData.prototype.append = function (name, value, filename) {
    this._entries.push([String(name), formDataValue(value), formDataFilename(value, filename)]);
  };
  FormData.prototype.set = function (name, value, filename) {
    var key = String(name);
    var v = formDataValue(value);
    var fn = formDataFilename(value, filename);
    var replaced = false;
    var kept = [];
    for (var i = 0; i < this._entries.length; i++) {
      if (this._entries[i][0] !== key) {
        kept.push(this._entries[i]);
      } else if (!replaced) {
        replaced = true;
        kept.push([key, v, fn]);
      }
    }
    if (!replaced) kept.push([key, v, fn]);
    this._entries = kept;
  };
  FormData.prototype.get = function (name) {
    var key = String(name);
    for (var i = 0; i < this._entries.length; i++) if (this._entries[i][0] === key) return this._entries[i][1];
    return null;
  };
  FormData.prototype.getAll = function (name) {
    var key = String(name);
    var out = [];
    for (var i = 0; i < this._entries.length; i++) if (this._entries[i][0] === key) out.push(this._entries[i][1]);
    return out;
  };
  FormData.prototype.has = function (name) {
    var key = String(name);
    for (var i = 0; i < this._entries.length; i++) if (this._entries[i][0] === key) return true;
    return false;
  };
  FormData.prototype.delete = function (name) {
    var key = String(name);
    var kept = [];
    for (var i = 0; i < this._entries.length; i++) if (this._entries[i][0] !== key) kept.push(this._entries[i]);
    this._entries = kept;
  };
  FormData.prototype.forEach = function (callback, thisArg) {
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    for (var i = 0; i < this._entries.length; i++) callback.call(thisArg, this._entries[i][1], this._entries[i][0], this);
  };
  FormData.prototype.entries = function () {
    return this._entries.map(function (e) { return [e[0], e[1]]; })[Symbol.iterator]();
  };
  FormData.prototype.keys = function () {
    return this._entries.map(function (e) { return e[0]; })[Symbol.iterator]();
  };
  FormData.prototype.values = function () {
    return this._entries.map(function (e) { return e[1]; })[Symbol.iterator]();
  };
  FormData.prototype[Symbol.iterator] = FormData.prototype.entries;
  Object.defineProperty(FormData.prototype, Symbol.toStringTag, { value: 'FormData', configurable: true });
  global.FormData = FormData;

  // Serialise to a multipart/form-data body. The boundary is random per body so
  // a field value can never close the envelope early.
  //
  // Assembled as a byte list rather than a string: a file part's bytes are
  // arbitrary binary, and building the body as text would round-trip them
  // through UTF-8 and corrupt every byte that is not valid UTF-8. Text runs
  // are still encoded as text; only the part bodies are spliced in raw.
  function encodeFormData(form) {
    var boundary = '----LobuFormBoundary' + crypto.randomUUID().replace(/-/g, '');
    var chunks = [];
    var total = 0;
    function push(bytes) {
      chunks.push(bytes);
      total += bytes.length;
    }
    for (var i = 0; i < form._entries.length; i++) {
      var name = escapeFormName(form._entries[i][0]);
      var value = form._entries[i][1];
      var filename = form._entries[i][2];
      var header = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"';
      if (value instanceof Blob) {
        header += '; filename="' + filename + '"\r\n';
        header += 'Content-Type: ' + (value.type || 'application/octet-stream') + '\r\n\r\n';
        push(utf8Encode(header));
        push(value._bytes);
        push(utf8Encode('\r\n'));
      } else {
        push(utf8Encode(header + '\r\n\r\n' + value + '\r\n'));
      }
    }
    push(utf8Encode('--' + boundary + '--\r\n'));
    var body = new Uint8Array(total);
    var at = 0;
    for (var j = 0; j < chunks.length; j++) {
      body.set(chunks[j], at);
      at += chunks[j].length;
    }
    return { bytes: body, contentType: 'multipart/form-data; boundary=' + boundary };
  }

  // ---------------------------------------------------------------------------
  // Response / fetch
  // ---------------------------------------------------------------------------

  var STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' };

  // Returns { bytes: Uint8Array | null, contentType: string | null }.
  function extractBody(body) {
    if (body === undefined || body === null) return { bytes: null, contentType: null };
    if (typeof body === 'string') return { bytes: utf8Encode(body), contentType: 'text/plain;charset=UTF-8' };
    if (body instanceof URLSearchParams) return { bytes: utf8Encode(body.toString()), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
    if (body instanceof ArrayBuffer) return { bytes: new Uint8Array(body.slice(0)), contentType: null };
    if (ArrayBuffer.isView(body)) return { bytes: new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)), contentType: null };
    if (body instanceof FormData) return encodeFormData(body);
    throw new TypeError('Unsupported body type on the isolate lane: pass a string, URLSearchParams, FormData, ArrayBuffer or ArrayBufferView');
  }

  // A guest-constructed body: its bytes handed over once, then end of stream.
  function bytesStream(bytes) {
    var sent = false;
    return new ReadableStream({
      pull: function (controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(bytes);
      }
    });
  }

  // Drain a body stream into one Uint8Array for text() / json() / arrayBuffer().
  function readAllBytes(stream) {
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    function step() {
      return reader.read().then(function (result) {
        if (result.done) {
          reader.releaseLock();
          var out = new Uint8Array(total);
          var offset = 0;
          for (var i = 0; i < chunks.length; i++) {
            out.set(chunks[i], offset);
            offset += chunks[i].length;
          }
          return out;
        }
        var chunk = toBytes(result.value, 'Response body');
        chunks.push(chunk);
        total += chunk.length;
        return step();
      });
    }
    return step();
  }

  function Response(body, init) {
    if (!(this instanceof Response)) throw new TypeError("Class constructor Response cannot be invoked without 'new'");
    init = init || {};
    var status = init.status === undefined ? 200 : Number(init.status);
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new RangeError('init["status"] must be in the range of 200 to 599, inclusive.');
    this.status = status;
    this.statusText = init.statusText === undefined ? (STATUS_TEXT[status] || '') : String(init.statusText);
    this.headers = new Headers(init.headers);
    this.url = init.url === undefined ? '' : String(init.url);
    this.redirected = !!init.redirected;
    this.type = 'basic';
    this._bodyUsed = false;
    if (body instanceof ReadableStream) {
      this._bytes = null;
      this._stream = body;
    } else {
      var extracted = extractBody(body);
      this._bytes = extracted.bytes;
      this._stream = null;
      if (extracted.contentType && !this.headers.has('content-type')) this.headers.set('content-type', extracted.contentType);
    }
  }
  Object.defineProperty(Response.prototype, 'ok', { get: function () { return this.status >= 200 && this.status <= 299; }, enumerable: true });
  // A ReadableStream for every non-null body, as on every other runtime: a
  // network response streams from the host, a guest-constructed one yields its
  // bytes once. Null for a body-less response.
  Object.defineProperty(Response.prototype, 'body', {
    get: function () {
      if (this._stream === null && this._bytes !== null) this._stream = bytesStream(this._bytes);
      return this._stream;
    },
    enumerable: true
  });
  Object.defineProperty(Response.prototype, 'bodyUsed', {
    get: function () { return this._bodyUsed || !!(this._stream && this._stream._disturbed); },
    enumerable: true
  });
  Response.prototype._consume = function () {
    if (this.bodyUsed) return Promise.reject(new TypeError('Body is unusable: Body has already been read'));
    this._bodyUsed = true;
    if (this._stream) return readAllBytes(this._stream);
    return Promise.resolve(this._bytes || new Uint8Array(0));
  };
  Response.prototype.arrayBuffer = function () {
    return this._consume().then(function (bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); });
  };
  Response.prototype.bytes = function () {
    return this._consume().then(function (bytes) { return new Uint8Array(bytes); });
  };
  Response.prototype.text = function () {
    return this._consume().then(function (bytes) { return utf8Decode(bytes); });
  };
  Response.prototype.json = function () {
    return this.text().then(function (text) { return JSON.parse(text); });
  };
  Response.prototype.clone = function () {
    if (this.bodyUsed) throw new TypeError('Response.clone: Body has already been consumed.');
    // Cloning a streamed body means teeing it, which nothing on this lane
    // does; a guest-constructed body still has its bytes to copy.
    if (this._bytes === null && this._stream !== null) throw new TypeError('Response.clone: a streamed body cannot be cloned on the isolate lane');
    return new Response(this._bytes ? new Uint8Array(this._bytes) : null, {
      status: this.status, statusText: this.statusText, headers: this.headers, url: this.url, redirected: this.redirected
    });
  };
  Response.error = function () {
    var r = new Response(null, { status: 200 });
    r.status = 0;
    r.statusText = '';
    r.type = 'error';
    return r;
  };
  Response.json = function (data, init) {
    init = init || {};
    var headers = new Headers(init.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new Response(JSON.stringify(data), { status: init.status, statusText: init.statusText, headers: headers });
  };
  Object.defineProperty(Response.prototype, Symbol.toStringTag, { value: 'Response', configurable: true });
  global.Response = Response;

  var fetchSeq = 0;

  // The error a body stream ends with when the host reports one: an abort is
  // the signal's own reason, anything else the host's description.
  function bodyStreamError(desc, signal) {
    if (desc && desc.name === 'AbortError') {
      return signal && signal.aborted && signal.reason !== undefined ? signal.reason : abortError();
    }
    return makeError(desc);
  }

  function fetch(input, init) {
    return new Promise(function (resolve) { resolve(); }).then(function () {
      init = init || {};
      var requestLike = input !== null && typeof input === 'object' && !(input instanceof URL) ? input : null;
      var rawUrl = requestLike ? requestLike.url : input;
      var parsed;
      try {
        parsed = new URL(String(rawUrl));
      } catch (e) {
        var bad = new TypeError('Failed to parse URL from ' + String(rawUrl));
        bad.cause = e;
        throw bad;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new TypeError('fetch failed: only http: and https: URLs are supported on the isolate lane');
      }
      var method = String(init.method || (requestLike && requestLike.method) || 'GET').toUpperCase();
      var headers = new Headers(init.headers !== undefined ? init.headers : (requestLike ? requestLike.headers : undefined));
      var signal = init.signal || (requestLike ? requestLike.signal : null) || null;
      if (signal && signal.aborted) throw signal.reason === undefined ? abortError() : signal.reason;
      var extracted = extractBody(init.body !== undefined ? init.body : (requestLike ? requestLike.body : undefined));
      if (extracted.bytes && (method === 'GET' || method === 'HEAD')) throw new TypeError('Request with GET/HEAD method cannot have body.');
      if (extracted.contentType && !headers.has('content-type')) headers.set('content-type', extracted.contentType);
      var redirect = init.redirect === undefined ? 'follow' : String(init.redirect);
      if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') throw new TypeError('Invalid redirect mode: ' + redirect);
      var id = ++fetchSeq;
      // The abort listener lives as long as the response does, headers AND
      // body: an abort after the headers arrived errors the body stream, as it
      // does on every other runtime.
      var onAbort = null;
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
      if (signal) {
        onAbort = function () { try { hostSync('fetchAbort', id); } catch (e) {} };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      var request = { id: id, url: parsed.href, method: method, headers: headers._sortedEntries(), redirect: redirect };
      return hostAsync('fetchOpen', request, extracted.bytes === null ? undefined : extracted.bytes).then(
        function (reply) {
          var body = null;
          if (!reply.hasBody) {
            finish();
          } else {
            // One host chunk per read, the way a socket's readable pulls: the
            // host holds nothing the guest has not asked for yet.
            body = new ReadableStream({
              pull: function (controller) {
                if (signal && signal.aborted) {
                  finish();
                  controller.error(bodyStreamError({ name: 'AbortError' }, signal));
                  return;
                }
                return hostAsync('fetchRead', id).then(
                  function (res) {
                    if (res.error) {
                      finish();
                      controller.error(bodyStreamError(res.error, signal));
                    } else if (res.done || res.data === null) {
                      finish();
                      controller.close();
                    } else {
                      controller.enqueue(toBytes(res.data, 'fetch body'));
                    }
                  },
                  function (err) {
                    finish();
                    controller.error(err);
                  }
                );
              },
              cancel: function () {
                finish();
                try { hostSync('fetchAbort', id); } catch (e) {}
              }
            });
          }
          return new Response(body, {
            status: reply.status, statusText: reply.statusText, headers: reply.headers, url: reply.url, redirected: reply.redirected
          });
        },
        function (err) {
          finish();
          if (signal && signal.aborted) throw signal.reason === undefined ? abortError() : signal.reason;
          throw err;
        }
      );
    });
  }
  global.fetch = fetch;

  var crypto = {
    getRandomValues: function (array) {
      if (!array || !array.buffer || typeof array.byteLength !== 'number') {
        throw new TypeError('crypto.getRandomValues: expected an ArrayBufferView');
      }
      var bytes = hostSync('randomBytes', array.byteLength);
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
      return array;
    },
    randomUUID: function () {
      var bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      var hex = [];
      for (var i = 0; i < 16; i++) {
        var h = bytes[i].toString(16);
        hex.push(h.length === 1 ? '0' + h : h);
      }
      return (
        hex.slice(0, 4).join('') + '-' +
        hex.slice(4, 6).join('') + '-' +
        hex.slice(6, 8).join('') + '-' +
        hex.slice(8, 10).join('') + '-' +
        hex.slice(10, 16).join('')
      );
    }
  };
  // WebCrypto, delegated to Node through the bridge rather than reimplemented
  // here. postgres.js answers BOTH an md5 challenge and a SCRAM-SHA-256
  // exchange through crypto.subtle, so a DB connector that reaches any server
  // not on cleartext password auth needs this. Only the operations those
  // exchanges use are implemented; anything else throws by name rather than
  // returning a wrong answer.
  function subtleBytes(data, what) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError(what + ': expected an ArrayBuffer or ArrayBufferView');
  }

  function subtleAlgorithm(algorithm) {
    return typeof algorithm === 'string' ? { name: algorithm } : (algorithm || {});
  }

  // WebCrypto hands back an ArrayBuffer; the bridge hands back a view.
  function subtleBuffer(u8) {
    return u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
      ? u8.buffer
      : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  // Every subtle method is async, so a bad argument must reject rather than
  // throw synchronously: postgres.js drives auth from an async handler with no
  // catcher, and a synchronous throw there is swallowed as an unhandled
  // rejection that stalls the connection until its connect_timeout.
  function subtleCall(fn) {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function subtleKeyBytes(key, what) {
    if (!key || !(key.__rawKey instanceof Uint8Array)) {
      throw new TypeError(what + ': expected a key from crypto.subtle.importKey');
    }
    return key.__rawKey;
  }

  crypto.subtle = {
    digest: function (algorithm, data) {
      return subtleCall(function () {
        return subtleBuffer(
          hostSync('cryptoDigest', subtleAlgorithm(algorithm).name, subtleBytes(data, 'crypto.subtle.digest'))
        );
      });
    },
    importKey: function (format, keyData, algorithm, extractable, usages) {
      return subtleCall(function () {
        if (String(format).toLowerCase() !== 'raw') {
          throw new TypeError("crypto.subtle.importKey: only the 'raw' format is supported, not '" + String(format) + "'");
        }
        return {
          type: 'secret',
          extractable: !!extractable,
          algorithm: subtleAlgorithm(algorithm),
          usages: usages ? Array.prototype.slice.call(usages) : [],
          __rawKey: subtleBytes(keyData, 'crypto.subtle.importKey')
        };
      });
    },
    sign: function (algorithm, key, data) {
      return subtleCall(function () {
        var name = String(subtleAlgorithm(algorithm).name).toUpperCase();
        if (name !== 'HMAC') {
          throw new TypeError("crypto.subtle.sign: only HMAC is supported, not '" + name + "'");
        }
        var raw = subtleKeyBytes(key, 'crypto.subtle.sign');
        var hash = subtleAlgorithm(key.algorithm && key.algorithm.hash ? key.algorithm.hash : 'SHA-256').name;
        return subtleBuffer(hostSync('cryptoHmac', hash, raw, subtleBytes(data, 'crypto.subtle.sign')));
      });
    },
    deriveBits: function (algorithm, key, length) {
      return subtleCall(function () {
        var algo = subtleAlgorithm(algorithm);
        if (String(algo.name).toUpperCase() !== 'PBKDF2') {
          throw new TypeError("crypto.subtle.deriveBits: only PBKDF2 is supported, not '" + String(algo.name) + "'");
        }
        var raw = subtleKeyBytes(key, 'crypto.subtle.deriveBits');
        var bits = Number(length);
        if (!isFinite(bits) || bits <= 0 || bits % 8 !== 0) {
          throw new TypeError('crypto.subtle.deriveBits: length must be a positive multiple of 8, got ' + String(length));
        }
        return subtleBuffer(
          hostSync(
            'cryptoPbkdf2',
            subtleAlgorithm(algo.hash ? algo.hash : 'SHA-256').name,
            raw,
            subtleBytes(algo.salt, 'crypto.subtle.deriveBits'),
            algo.iterations,
            bits / 8
          )
        );
      });
    }
  };

  global.crypto = crypto;

  // ---------------------------------------------------------------------------
  // node:crypto
  // ---------------------------------------------------------------------------
  // require('node:crypto') handed back the WebCrypto object, so everything
  // Node exposes under that specifier and WebCrypto does not -- createHash,
  // createHmac, randomBytes -- was simply missing. Eligibility could not catch
  // it: node:crypto IS a provided builtin, so the bundle loads and the call
  // dies at run time as "createHash is not a function". github, jira and
  // linear each mint a webhook secret with randomBytes(32).toString('hex').
  // Node does the work; the guest marshals bytes and encodes the digest.
  function nodeCryptoBytes(data, encoding, what) {
    if (typeof data === 'string') return Buffer.from(data, encoding || 'utf8');
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new TypeError(what + ': data must be a string, ArrayBuffer or ArrayBufferView');
  }

  // Node's Hash/Hmac are streaming; the host capabilities are one-shot. Buffer
  // the chunks and hash once at digest() -- identical output, and a connector
  // cannot tell the difference without timing a partial write.
  function nodeCryptoHash(what, compute) {
    var chunks = [];
    var api = {
      update: function (data, inputEncoding) {
        chunks.push(nodeCryptoBytes(data, inputEncoding, what));
        return api;
      },
      digest: function (encoding) {
        var out = compute(Buffer.concat(chunks));
        return !encoding || encoding === 'buffer' ? out : out.toString(encoding);
      }
    };
    return api;
  }

  var nodeCrypto = {
    createHash: function (algorithm) {
      return nodeCryptoHash('createHash', function (bytes) {
        return hostSync('cryptoDigest', algorithm, bytes);
      });
    },
    createHmac: function (algorithm, key) {
      var keyBytes = nodeCryptoBytes(key, undefined, 'createHmac');
      return nodeCryptoHash('createHmac', function (bytes) {
        return hostSync('cryptoHmac', algorithm, keyBytes, bytes);
      });
    },
    randomBytes: function (size) {
      var n = Number(size);
      if (!isFinite(n) || n < 0 || n % 1 !== 0) {
        throw new TypeError('randomBytes: size must be a non-negative integer, got ' + String(size));
      }
      // Re-wrap so the result is a guest Uint8Array carrying the Buffer
      // methods installed on the prototype -- .toString('hex') is the whole
      // point of the call at every site that makes it.
      var out = new Uint8Array(n);
      if (n > 0) out.set(hostSync('randomBytes', n));
      return out;
    },
    randomUUID: function () { return crypto.randomUUID(); },
    getRandomValues: function (array) { return crypto.getRandomValues(array); },
    webcrypto: crypto,
    subtle: crypto.subtle
  };
  nodeCrypto.default = nodeCrypto;
  global.__lobuNodeCrypto = nodeCrypto;

  // ---------------------------------------------------------------------------
  // Buffer, as Uint8Array
  // ---------------------------------------------------------------------------
  // Buffer.from returns a plain Uint8Array rather than a subclass, so the
  // Buffer-only methods are installed on Uint8Array.prototype — which means
  // they apply to EVERY typed array in the guest, including toString, whose
  // default (comma-joined digits) is replaced by Node's utf8/hex/base64 decode.
  // That is the point: the DB drivers this exists for pass wire buffers through
  // SDK and connector code that cannot tell the two apart, and a subclass would
  // be lost the first time one of them sliced or concatenated. Nothing in the
  // guest depends on the array default, and the isolate global is thrown away
  // with the run.
  var Buffer = function Buffer(arg, enc) {
    return Buffer.from(arg, enc);
  };
  Buffer.isBuffer = function (obj) {
    return obj instanceof Uint8Array;
  };
  Buffer.alloc = function (size, fill, encoding) {
    var u8 = new Uint8Array(size);
    if (fill === undefined || fill === 0) return u8;
    if (typeof fill === 'number') { u8.fill(fill & 255); return u8; }
    // Node repeats a string / byte fill across the buffer; a silent zero fill
    // here would corrupt every padded protocol frame built with alloc(n, 'x').
    var pattern = Buffer.from(fill, encoding);
    if (pattern.length === 0) return u8;
    for (var i = 0; i < size; i++) u8[i] = pattern[i % pattern.length];
    return u8;
  };
  Buffer.allocUnsafe = function (size) {
    return new Uint8Array(size);
  };
  Buffer.byteLength = function (str, encoding) {
    if (str instanceof ArrayBuffer) return str.byteLength;
    if (str && typeof str === 'object' && typeof str.byteLength === 'number') return str.byteLength;
    // Honour the encoding: byteLength('ff', 'hex') is 1, not 2.
    return Buffer.from(String(str), encoding).length;
  };
  Buffer.concat = function (list, length) {
    if (!length) {
      length = 0;
      for (var i = 0; i < list.length; i++) length += list[i].length;
    }
    var res = new Uint8Array(length);
    var offset = 0;
    for (var j = 0; j < list.length; j++) {
      var room = length - offset;
      if (room <= 0) break;
      // Node TRUNCATES to the requested length; res.set() would throw instead.
      var item = list[j].length > room ? list[j].subarray(0, room) : list[j];
      res.set(item, offset);
      offset += item.length;
    }
    return res;
  };
  Buffer.from = function (data, encoding) {
    if (typeof data === 'number') {
      throw new TypeError('The "value" argument must not be of type number. Received type number');
    }
    if (typeof data === 'string') {
      var enc = (encoding || 'utf8').toLowerCase();
      if (enc === 'hex') {
        var clean = data.trim();
        var len = Math.floor(clean.length / 2);
        var u8 = new Uint8Array(len);
        for (var i = 0; i < len; i++) {
          u8[i] = parseInt(clean.substr(i * 2, 2), 16);
        }
        return u8;
      }
      if (enc === 'base64' || enc === 'base64url') {
        var cleanB64 = data.replace(/-/g, '+').replace(/_/g, '/');
        while (cleanB64.length % 4 !== 0) cleanB64 += '=';
        var decoded = global.atob(cleanB64);
        var u8B64 = new Uint8Array(decoded.length);
        for (var b = 0; b < decoded.length; b++) u8B64[b] = decoded.charCodeAt(b);
        return u8B64;
      }
      var res = utf8Encode(data);
      if (res instanceof Uint8Array) return res;
      var unescaped = unescape(encodeURIComponent(data));
      var u8Fallback = new Uint8Array(unescaped.length);
      for (var u = 0; u < unescaped.length; u++) u8Fallback[u] = unescaped.charCodeAt(u);
      return u8Fallback;
    }
    if (data instanceof Uint8Array) {
      // Node COPIES a typed array (only Buffer.from(arrayBuffer) shares
      // memory), so a guest mutating the result must not mutate the source.
      return new Uint8Array(data);
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data);
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (data && data.buffer instanceof ArrayBuffer) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return Buffer.from(String(data));
  };

  Uint8Array.prototype.toString = function (enc, start, end) {
    var outEnc = (enc || 'utf8').toLowerCase();
    var slice = (start !== undefined || end !== undefined) ? this.subarray(start || 0, end !== undefined ? end : this.length) : this;
    if (outEnc === 'base64') {
      var bin = '';
      for (var i = 0; i < slice.length; i++) bin += String.fromCharCode(slice[i]);
      return global.btoa(bin);
    }
    if (outEnc === 'hex') {
      var hex = '';
      for (var j = 0; j < slice.length; j++) {
        var h = slice[j].toString(16);
        hex += (h.length === 1 ? '0' + h : h);
      }
      return hex;
    }
    var decoded = utf8Decode(slice);
    if (typeof decoded === 'string') return decoded;
    var s = '';
    for (var k = 0; k < slice.length; k++) s += String.fromCharCode(slice[k]);
    try {
      return decodeURIComponent(escape(s));
    } catch {
      return s;
    }
  };
  Uint8Array.prototype.write = function (str, offset, length, encoding) {
    var off = offset || 0;
    var encoded = Buffer.from(str, encoding);
    var toWrite = length !== undefined ? Math.min(length, encoded.length) : encoded.length;
    for (var i = 0; i < toWrite && off + i < this.length; i++) {
      this[off + i] = encoded[i];
    }
    return toWrite;
  };
  Uint8Array.prototype.readInt32BE = function (offset) {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getInt32(offset || 0, false);
  };
  Uint8Array.prototype.readUInt32BE = function (offset) {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint32(offset || 0, false);
  };
  Uint8Array.prototype.readInt16BE = function (offset) {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getInt16(offset || 0, false);
  };
  Uint8Array.prototype.readUInt16BE = function (offset) {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getUint16(offset || 0, false);
  };
  Uint8Array.prototype.readUInt8 = function (offset) {
    return this[offset || 0];
  };
  Uint8Array.prototype.readBigInt64BE = function (offset) {
    return new DataView(this.buffer, this.byteOffset, this.byteLength).getBigInt64(offset || 0, false);
  };
  Uint8Array.prototype.writeInt32BE = function (val, offset) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setInt32(offset || 0, val, false);
    return (offset || 0) + 4;
  };
  Uint8Array.prototype.writeUInt32BE = function (val, offset) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint32(offset || 0, val, false);
    return (offset || 0) + 4;
  };
  Uint8Array.prototype.writeUInt16BE = function (val, offset) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setUint16(offset || 0, val, false);
    return (offset || 0) + 2;
  };
  Uint8Array.prototype.writeBigInt64BE = function (val, offset) {
    new DataView(this.buffer, this.byteOffset, this.byteLength).setBigInt64(offset || 0, BigInt(val), false);
    return (offset || 0) + 8;
  };
  // Node's Buffer.prototype.copy. Missing it failed the postgres connector at
  // the first wire read with "prev.copy is not a function" -- postgres.js grows
  // its read buffer with it. Node clamps to the destination's remaining room
  // rather than throwing, and returns the number of bytes written.
  Uint8Array.prototype.copy = function (target, targetStart, sourceStart, sourceEnd) {
    var start = targetStart || 0;
    var from = sourceStart || 0;
    var to = sourceEnd === undefined ? this.length : sourceEnd;
    var slice = this.subarray(from, to);
    var room = target.length - start;
    if (slice.length > room) slice = slice.subarray(0, room < 0 ? 0 : room);
    target.set(slice, start);
    return slice.length;
  };
  global.Buffer = Buffer;

  // ---------------------------------------------------------------------------
  // EventEmitter shim
  // ---------------------------------------------------------------------------
  function EventEmitter() {
    this._events = Object.create(null);
  }
  EventEmitter.prototype.on = function (event, listener) {
    if (!this._events[event]) this._events[event] = [];
    this._events[event].push(listener);
    return this;
  };
  EventEmitter.prototype.once = function (event, listener) {
    var self = this;
    function g() {
      self.off(event, g);
      listener.apply(this, arguments);
    }
    g.listener = listener;
    return this.on(event, g);
  };
  EventEmitter.prototype.off = function (event, listener) {
    var list = this._events[event];
    if (!list) return this;
    this._events[event] = list.filter(function (l) {
      return l !== listener && l.listener !== listener;
    });
    return this;
  };
  EventEmitter.prototype.removeListener = EventEmitter.prototype.off;
  EventEmitter.prototype.removeAllListeners = function (event) {
    if (event) delete this._events[event];
    else this._events = Object.create(null);
    return this;
  };
  EventEmitter.prototype.emit = function (event) {
    var list = this._events[event];
    if (!list || list.length === 0) return false;
    var args = Array.prototype.slice.call(arguments, 1);
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) {
      copy[i].apply(this, args);
    }
    return true;
  };
  global.EventEmitter = EventEmitter;

  // ---------------------------------------------------------------------------
  // Web Streams (ReadableStream, WritableStream)
  // ---------------------------------------------------------------------------
  function ReadableStream(underlyingSource) {
    this._source = underlyingSource || {};
    // Set by the first read; Response.bodyUsed reports it.
    this._disturbed = false;
  }
  ReadableStream.prototype.getReader = function () {
    var self = this;
    var queue = [];
    var waiters = [];
    var isClosed = false;
    var streamError = null;

    function settleWaiters(result) {
      while (waiters.length > 0) waiters.shift()(result);
    }

    var controller = {
      enqueue: function (chunk) {
        // A chunk the source still delivers after a close or a cancel is
        // dropped: every read from that point on already reports done.
        if (isClosed) return;
        if (waiters.length > 0) waiters.shift()({ value: chunk, done: false });
        else queue.push(chunk);
      },
      close: function () {
        isClosed = true;
        settleWaiters({ value: undefined, done: true });
      },
      error: function (err) {
        // Like enqueue: an error the source reports after a close or a cancel
        // is dropped, so a read from then on still reports done. The fetch
        // body reaches this when a cancel kills its in-flight pull, which
        // answers with an AbortError only after the cancel has ended the stream.
        if (isClosed) return;
        streamError = err;
        if (waiters.length > 0) settleWaiters(Promise.reject(err));
      }
    };

    if (this._source && this._source.start) {
      this._source.start(controller);
    }

    return {
      read: function () {
        self._disturbed = true;
        if (streamError) return Promise.reject(streamError);
        if (queue.length > 0) {
          return Promise.resolve({ value: queue.shift(), done: false });
        }
        if (isClosed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        // The waiter is registered BEFORE pull(), because a source that
        // enqueues synchronously would otherwise push into the queue while no
        // waiter was registered and leave this read hanging forever. Reads
        // queue in order: each pull answers the oldest waiter.
        var waiter = new Promise(function (resolve) {
          waiters.push(resolve);
        });
        if (self._source && self._source.pull) {
          self._source.pull(controller);
        }
        return waiter;
      },
      releaseLock: function () {},
      // Cancelling ends the stream: the queue is dropped and every read from
      // here on reports done. Without that a later read would pull the source
      // again -- for a fetch body or a socket, a read on what the cancel just
      // released.
      cancel: function (reason) {
        isClosed = true;
        queue.length = 0;
        settleWaiters({ value: undefined, done: true });
        if (self._source && self._source.cancel) {
          return Promise.resolve(self._source.cancel(reason));
        }
        return Promise.resolve();
      }
    };
  };
  global.ReadableStream = ReadableStream;

  function WritableStream(underlyingSink) {
    this._sink = underlyingSink || {};
  }
  WritableStream.prototype.getWriter = function () {
    var self = this;
    return {
      ready: Promise.resolve(),
      write: function (chunk) {
        if (self._sink && self._sink.write) {
          return Promise.resolve(self._sink.write(chunk));
        }
        return Promise.resolve();
      },
      close: function () {
        if (self._sink && self._sink.close) {
          return Promise.resolve(self._sink.close());
        }
        return Promise.resolve();
      },
      releaseLock: function () {}
    };
  };
  global.WritableStream = WritableStream;

  // ---------------------------------------------------------------------------
  // node:stream -- present so a bundle that reads it at load time can load,
  // and loud so nothing quietly gets a web stream where a Node stream is meant.
  // ---------------------------------------------------------------------------
  function nodeStreamAbsent(name) {
    return function () {
      throw new Error(
        "node:stream." + name + " is not available in the connector isolate. " +
          "Use the web streams (ReadableStream/WritableStream) or a host capability instead."
      );
    };
  }
  var nodeStream = {
    Readable: nodeStreamAbsent('Readable'),
    Writable: nodeStreamAbsent('Writable'),
    Duplex: nodeStreamAbsent('Duplex')
  };
  nodeStream.default = nodeStream;
  global.__lobuNodeStream = nodeStream;

  // ---------------------------------------------------------------------------
  // WinterCG Direct Sockets (connect)
  // ---------------------------------------------------------------------------
  global.connect = function connect(address, options) {
    var host = '';
    // No default port: this is the generic WinterCG entry point, so guessing
    // one would silently dial some other connector's service.
    var port = NaN;
    if (typeof address === 'string') {
      var idx = address.lastIndexOf(':');
      if (idx !== -1) {
        host = address.slice(0, idx);
        port = parseInt(address.slice(idx + 1), 10);
      } else {
        host = address;
      }
    } else if (address && typeof address === 'object') {
      host = address.hostname || '';
      port = address.port;
    }
    if (!(port > 0 && port < 65536)) {
      throw new Error('connect() requires a port; got ' + JSON.stringify(address));
    }

    var socketId = null;
    var closedResolve;
    var closedReject;
    var closedPromise = new Promise(function (resolve, reject) {
      closedResolve = resolve;
      closedReject = reject;
    });

    var openPromise = hostAsync('socketOpen', host, port, options ? JSON.stringify(options) : '{}').then(
      function (id) {
        socketId = id;
        return id;
      },
      function (err) {
        closedReject(err);
        throw err;
      }
    );

    var readable = new ReadableStream({
      pull: function (controller) {
        return openPromise.then(function () {
          return hostAsync('socketRead', socketId).then(function (res) {
            if (res.error) {
              var err = new Error(res.error);
              controller.error(err);
              closedReject(err);
            } else if (res.done || res.data === null) {
              controller.close();
              closedResolve();
            } else {
              var bin = atob(res.data);
              var u8 = new Uint8Array(bin.length);
              for (var i = 0; i < bin.length; i++) {
                u8[i] = bin.charCodeAt(i);
              }
              controller.enqueue(u8);
            }
          });
        });
      },
      cancel: function () {
        if (socketId !== null) {
          hostAsync('socketClose', socketId);
        }
        closedResolve();
      }
    });

    var writable = new WritableStream({
      write: function (chunk) {
        return openPromise.then(function () {
          var u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          var bin = '';
          for (var i = 0; i < u8.length; i++) {
            bin += String.fromCharCode(u8[i]);
          }
          return hostAsync('socketWrite', socketId, btoa(bin));
        });
      },
      close: function () {
        if (socketId !== null) {
          return hostAsync('socketClose', socketId).then(function () {
            closedResolve();
          });
        }
        closedResolve();
      }
    });

    var socketObj = {
      readable: readable,
      writable: writable,
      closed: closedPromise,
      close: function () {
        if (socketId !== null) {
          return hostAsync('socketClose', socketId).then(function () {
            closedResolve();
          });
        }
        closedResolve();
        return Promise.resolve();
      },
      startTls: function (opts) {
        openPromise = openPromise.then(function () {
          return hostAsync('socketStartTls', socketId, opts ? JSON.stringify(opts) : '{}');
        });
        // Cloudflare's Direct-Sockets contract: startTls() CONSUMES this socket
        // and returns a NEW one, so the ORIGINAL socket's closed promise
        // settles once the transport is up. postgres.js's workerd build derives
        // secureConnect from exactly that, and only then releases the
        // startup/auth packet, so a pre-upgrade closed that never settles parks
        // the driver until its connect_timeout -- a write CONNECT_TIMEOUT on a
        // socket that connected fine. Settle the pre-upgrade closed off the
        // host's TLS result, and give the upgraded socket a fresh closed that
        // only settles on a real close. Both facades share one host socket id
        // and the (now startTls-chained) openPromise, so reads and writes still
        // serialize behind the upgrade and land on the encrypted socket. The
        // upgraded facade has no startTls: this socket is spent, and a second
        // upgrade would stack TLS on TLS host-side.
        var priorResolve = closedResolve;
        var priorReject = closedReject;
        closedPromise = new Promise(function (resolve, reject) {
          closedResolve = resolve;
          closedReject = reject;
        });
        openPromise.then(
          // No value: closed fulfils with undefined per the Direct-Sockets
          // contract, not with the host capability's return.
          function () {
            priorResolve();
          },
          priorReject
        );
        return {
          readable: readable,
          writable: writable,
          closed: closedPromise,
          close: socketObj.close
        };
      }
    };

    return socketObj;
  };
})(globalThis);
`;
