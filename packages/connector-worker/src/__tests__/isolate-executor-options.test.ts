import { describe, expect, it } from 'bun:test';
import type { ExecutorJob } from '../executor/interface.js';
import { IsolateExecutor, IsolateRuntimeUnavailableError } from '../executor/isolate.js';
import { IsolateLaneIneligibleError } from '../isolate/eligibility.js';

const job: ExecutorJob = {
  mode: 'sync',
  feedKey: 'f',
  config: {},
  checkpoint: null,
  entityIds: [],
  credentials: null,
  sessionState: null,
  env: {},
};

describe('IsolateExecutor options', () => {
  it('refuses a gateway-authenticated job without its host HTTP hook before starting the guest', async () => {
    await expect(new IsolateExecutor().execute(
      'module.exports.default = class { sync() {} execute() {} };',
      { ...job, httpAuth: true },
    )).rejects.toThrow('HTTP authentication requires a gateway fetch hook');
  });

  it('accepts the defaults and partial overrides', () => {
    expect(() => new IsolateExecutor()).not.toThrow();
    expect(() => new IsolateExecutor({ timeoutMs: 0, memoryMb: 8, allowedDomains: ['Example.COM'] })).not.toThrow();
    // An empty allowlist means egress is closed (the shared grammar), not misconfigured.
    expect(() => new IsolateExecutor({ allowedDomains: [] })).not.toThrow();
    expect(() => new IsolateExecutor({ timeoutMs: undefined })).not.toThrow();
  });

  it('rejects out-of-range limits', () => {
    expect(() => new IsolateExecutor({ timeoutMs: -1 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ timeoutMs: Number.NaN })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ memoryMb: 4 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ messageBytes: 512 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ fetchBodyBytes: 1 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ logBytes: 1 })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ allowedDomains: ['  '] })).toThrow(RangeError);
    expect(() => new IsolateExecutor({ allowedDomains: ['example.com', ''] })).toThrow(RangeError);
  });

  it('rejects a bundle that still requires a Node builtin before touching isolated-vm', async () => {
    const failure = await new IsolateExecutor()
      .execute('var fs = require("node:fs"); module.exports.default = class {};', job)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateLaneIneligibleError);
    expect((failure as IsolateLaneIneligibleError).builtins).toEqual(['fs']);
  });

  it('fails an eligible run loudly when isolated-vm is unavailable (Bun)', async () => {
    const failure = await new IsolateExecutor()
      .execute('module.exports.default = class { sync() {} execute() {} };', job)
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(IsolateRuntimeUnavailableError);
    expect((failure as Error).message).toMatch(
      /^isolate lane required but isolated-vm is unavailable on this worker \(Bun [^)]+\)/
    );
  });


  it('normalizes allowlist entries into the shared egress grammar', () => {
    // Exact entries are the run's reserved-address exemptions; wildcards are
    // not, and `*.` is the same wildcard as `.` (the SDK grammar), not a
    // prefix to strip. The matcher itself is @lobu/connector-sdk/egress-policy,
    // tested there; this pins only what the executor does to its input.
    const executor = new IsolateExecutor({
      allowedDomains: ['Example.COM', '*.Api.example.com', '.cdn.example.com', '[::1]', '127.0.0.1'],
    });
    const options = (executor as unknown as { options: { allowedDomains: readonly string[] } }).options;
    // A bracketed IPv6 literal loses its brackets, so one entry covers both a
    // bracketed fetch URL host and a bare `connect()` host.
    expect(options.allowedDomains).toEqual(['example.com', '.api.example.com', '.cdn.example.com', '::1', '127.0.0.1']);
    const exact = (executor as unknown as { exactAllowedHosts: readonly string[] }).exactAllowedHosts;
    expect(exact).toEqual(['example.com', '::1', '127.0.0.1']);
  });

  it('is unrestricted by default and closed on an explicit empty list', () => {
    const read = (executor: IsolateExecutor) =>
      (executor as unknown as { options: { allowedDomains: readonly string[] } }).options.allowedDomains;
    expect(read(new IsolateExecutor())).toEqual(['*']);
    expect(read(new IsolateExecutor({ allowedDomains: undefined }))).toEqual(['*']);
    expect(read(new IsolateExecutor({ allowedDomains: [] }))).toEqual([]);
  });
});
