/**
 * Reproducer for the stale-compiled-connector-bundle outage (prod 2026-07-15,
 * run 634620): `connector_versions.compiled_code` is keyed only by
 * (connector_key, version) — nothing recorded WHICH compile configuration
 * (EXTERNAL_RUNTIME_DEPS / pipeline) produced the artifact. When `pino` was
 * removed from the externals list (#444) and the runtime image stopped
 * shipping it, artifacts compiled in the pino-external era kept executing
 * verbatim and crashed with ERR_MODULE_NOT_FOUND
 * ("Connector requires 'pino' but it's not installed in the runtime image").
 *
 * Contract under test: resolveConnectorCode must never hand out an artifact
 * whose compile-config fingerprint doesn't match the current pipeline — it
 * must recompile from the stored source (and persist the fresh artifact so
 * every replica sees it) or fall back to the bundled on-disk source.
 */
import {
  COMPILE_CONFIG_HASH,
  computeCompileConfigHash,
  EXTERNAL_RUNTIME_DEPS,
} from '@lobu/connector-worker/compile';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// A bundle from the "pino is external" era: pino left as a bare import that
// the current runtime image no longer ships.
const STALE_BUNDLE = [
  'import pino from "pino";',
  'export default class StaleEraConnector {',
  '  async sync() { return {}; }',
  '  async execute() { return {}; }',
  '}',
  '',
].join('\n');

// The connector's stored TypeScript source (connector_versions.source_code).
// Under the CURRENT compile config, pino-like pure-JS deps are bundled, so a
// recompile of this source yields a self-contained artifact.
const STORED_SOURCE = `
export default class StaleProbeConnector {
  definition = { key: 'zz.staleprobe', name: 'Stale Probe', version: '1.0.0' };
  marker(): string { return 'RECOMPILED_FROM_SOURCE_MARKER'; }
  async sync(ctx) { await ctx.commit([], null); return { status: 'complete' }; }
  async execute() { return {}; }
}
`;

type LoggedQuery = { text: string; params: unknown[] };

const queries: LoggedQuery[] = [];
let storedSourceCode: string | null = STORED_SOURCE;

function fakeSql(strings: TemplateStringsArray, ...params: unknown[]): Promise<unknown[]> {
  const text = strings.join('?').replace(/\s+/g, ' ').trim();
  queries.push({ text, params });
  if (/SELECT source_code.* FROM connector_versions/i.test(text)) {
    return Promise.resolve(
      storedSourceCode === null
        ? []
        : [{ id: 1, source_code: storedSourceCode, compiled_code: STALE_BUNDLE, source_complete: null, version: '1.0.0' }]
    );
  }
  if (text.startsWith("UPDATE connector_versions")) return Promise.resolve([{ id: 1 }]);
  return Promise.resolve([]);
}

beforeEach(() => {
  queries.length = 0;
  storedSourceCode = STORED_SOURCE;
  vi.resetModules();
  // Spread the real module: vi.doMock is not hoisted or file-scoped, so a
  // hand-listed shape leaks into later files in the same vitest worker and
  // surfaces there as `No "<export>" export is defined on the mock`.
  vi.doMock('../../db/client', async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    getDb: () => fakeSql,
  }));
});

// vitest.config.ts runs this package with `isolate: false` and a single fork,
// so the module registry is shared by every file in the shard. Without
// retracting the mock here, whatever this file imported last stays cached with
// a `getDb()` that returns `fakeSql` — and the next file to import it gets a
// sql object with no `.begin`, failing far from the cause.
afterEach(() => {
  vi.doUnmock('../../db/client');
  // The logger mock is set inside a single test, but `isolate: false` shares
  // the registry across files — retract it here for the same reason.
  vi.doUnmock('../logger');
  vi.resetModules();
});

describe('resolveConnectorCode compile-config staleness', () => {
  test('artifact compiled under a different externals config is NOT executed verbatim — recompiled from stored source and persisted', async () => {
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    // Same stored row prod hands the resolver today: a compiled artifact from
    // the old-externals era (legacy rows have compile_config_hash NULL).
    // 'zz.staleprobe' has no bundled source on disk, so the ONLY valid escape
    // hatch is recompiling connector_versions.source_code.
    const code = await resolveConnectorCode('zz.staleprobe', {
      id: 1,
      organization_id: null,
      version: '1.0.0',
      compiled_code: STALE_BUNDLE,
      compile_config_hash: null,
    });

    // The stale artifact imports pino as a bare specifier — executing it is the
    // prod outage. The resolver must return a recompile of the stored source.
    expect(code).not.toContain('from "pino"');
    expect(code).toContain('RECOMPILED_FROM_SOURCE_MARKER');

    // The fresh artifact must be persisted with the current fingerprint
    // (Postgres-mediated self-heal — every replica converges).
    const update = queries.find((q) => /UPDATE connector_versions/i.test(q.text));
    expect(update).toBeDefined();
    expect(update!.params).toContain(COMPILE_CONFIG_HASH);
  });

  test('artifact with the current compile-config fingerprint is returned verbatim, no recompile', async () => {
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    const code = await resolveConnectorCode('zz.staleprobe', {
      id: 1,
      organization_id: null,
      version: '1.0.0',
      compiled_code: STALE_BUNDLE,
      compile_config_hash: COMPILE_CONFIG_HASH,
    });

    expect(code).toBe(STALE_BUNDLE);
    expect(queries).toHaveLength(0);
  });

  test('normalizing a PRE-COMPILED upload is idempotent — no duplicate __createRequire shim (sdk-e2e regression)', async () => {
    // A `compiled: true` upload (lobu apply, device reconcile) stores the
    // artifact itself in source_code with a NULL fingerprint, so first
    // resolution recompiles THAT artifact. Re-compiling an artifact that already
    // carries a CJS shim banner is how "Identifier '__createRequire' has already
    // been declared" reached sdk-e2e.
    //
    // The isolate lane emits NO banner — its prelude defines `require` in the
    // guest — so a recompiled artifact must carry ZERO declarations, not the one
    // the process lane's banner used to add. Asserting the exact count keeps the
    // original guard's strength: a banner reappearing here is the first step
    // back toward the duplicate declaration, and it fails immediately.
    const { compileConnectorSource } = await import('../connector-compiler');
    const precompiled = await compileConnectorSource(STORED_SOURCE);
    storedSourceCode = precompiled.compiledCode;

    const { resolveConnectorCode } = await import('../ensure-connector-installed');
    const code = await resolveConnectorCode('zz.staleprobe', {
      id: 1,
      organization_id: null,
      version: '1.0.0',
      compiled_code: precompiled.compiledCode,
      compile_config_hash: null,
    });

    const shimDeclarations = code.match(/createRequire as __createRequire/g) ?? [];
    expect(shimDeclarations).toHaveLength(0);
    expect(code).toContain('RECOMPILED_FROM_SOURCE_MARKER');
  });

  test('stale artifact with no stored source and no bundled file fails loudly instead of executing', async () => {
    const { resolveConnectorCode } = await import('../ensure-connector-installed');
    storedSourceCode = null;

    await expect(
      resolveConnectorCode('zz.staleprobe', {
        id: 1,
        organization_id: null,
        version: '1.0.0',
        compiled_code: STALE_BUNDLE,
        compile_config_hash: 'fingerprint-of-a-previous-pipeline',
      })
    ).rejects.toThrow(/predates the current compile configuration/);
  });

  test('changing the externals list changes the fingerprint (the invalidation trigger)', () => {
    // The pino-era config would have carried a different fingerprint, so its
    // artifacts can never be mistaken for current ones.
    const pinoEra = computeCompileConfigHash([...EXTERNAL_RUNTIME_DEPS, 'pino']);
    expect(pinoEra).not.toBe(COMPILE_CONFIG_HASH);
  });
});

describe('install-time compile-config provenance', () => {
  // A pre-compiled artifact from an OLDER client (e.g. a CLI whose externals
  // list still had pino): the server pipeline never compiled it, so it must
  // NOT be attested with the current fingerprint — otherwise it would reach
  // the resolver fast path and ship its stale bare imports to workers.
  const PRE_COMPILED_UPLOAD = [
    'import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);',
    'export default class OldCliConnector {',
    "  definition = { key: 'zz.oldcli', name: 'Old CLI Probe', version: '1.0.0' };",
    '  async sync() { return { events: [], checkpoint: null }; }',
    '  async execute() { return {}; }',
    '}',
    '',
  ].join('\n');

  const TS_SOURCE = `
export default class FreshInstallConnector {
  definition = { key: 'zz.freshinstall', name: 'Fresh Install Probe', version: '1.0.0' };
  async sync(ctx) { await ctx.commit([], null); return { status: 'complete' }; }
  async execute() { return {}; }
}
`;

  test('compiled:true uploads are stored WITHOUT the current fingerprint (normalized on first resolution)', async () => {
    const { resolveConnectorInstallSource } = await import('../connector-definition-install');

    const resolved = await resolveConnectorInstallSource({
      sourceCode: PRE_COMPILED_UPLOAD,
      compiled: true,
    });

    expect(resolved.compiledCode).toBe(PRE_COMPILED_UPLOAD);
    expect(resolved.compileConfigHash).toBeNull();
  });

  test('pipeline-compiled installs are stamped with the current fingerprint', async () => {
    const { resolveConnectorInstallSource } = await import('../connector-definition-install');

    const resolved = await resolveConnectorInstallSource({ sourceCode: TS_SOURCE });

    expect(resolved.compileConfigHash).toBe(COMPILE_CONFIG_HASH);
  });
});

/**
 * The Cloud containment property itself, observed rather than inferred.
 *
 * Every other test in this branch checks an ADMISSION decision — whether a run
 * is allowed to start. None of them check the thing the feature actually
 * promises: that when a run does start under LOBU_CLOUD_MODE, the bytes handed
 * to the runtime came from the image and not from `connector_versions`.
 *
 * These plant a distinguishable payload in the stored row, stamped with the
 * CURRENT fingerprint so nothing else in resolveConnectorCode would reject it,
 * and use a key the image really ships. The self-host case is the control: it
 * proves the planted bytes would otherwise execute verbatim, so the Cloud case
 * is testing containment and not a tautology.
 */
describe('Cloud executes image bytes, never the stored row', () => {
  // Valid ESM that a compile would accept, carrying a payload no bundled
  // connector contains.
  const PLANTED_MARKER = 'PLANTED_DB_BYTES_MUST_NEVER_EXECUTE';
  const PLANTED_BUNDLE = [
    'export default class PlantedConnector {',
    `  marker() { return ${JSON.stringify(PLANTED_MARKER)}; }`,
    '  async sync() { return {}; }',
    '  async execute() { return {}; }',
    '}',
    '',
  ].join('\n');

  // `github` is a real bundled connector — findBundledConnectorFile resolves
  // it and the resolver compiles the on-image file.
  const sharedRow = {
    id: 1,
    organization_id: null,
    version: '1.3.0',
    compiled_code: PLANTED_BUNDLE,
    compile_config_hash: COMPILE_CONFIG_HASH,
  };

  const originalCloudMode = process.env.LOBU_CLOUD_MODE;
  afterEach(() => {
    if (originalCloudMode === undefined) delete process.env.LOBU_CLOUD_MODE;
    else process.env.LOBU_CLOUD_MODE = originalCloudMode;
  });

  test('CONTROL — self-host hands the stored bytes straight to the runtime', async () => {
    delete process.env.LOBU_CLOUD_MODE;
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    const code = await resolveConnectorCode('github', sharedRow);

    // A fresh fingerprint means the self-host path returns the row verbatim.
    // This is what Cloud has to prevent.
    expect(code).toBe(PLANTED_BUNDLE);
    expect(code).toContain(PLANTED_MARKER);
  });

  test('Cloud compiles the image file and the planted bytes never appear', async () => {
    process.env.LOBU_CLOUD_MODE = 'true';
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    const code = await resolveConnectorCode('github', sharedRow);

    expect(code).not.toContain(PLANTED_MARKER);
    expect(code).not.toBe(PLANTED_BUNDLE);
    // Positively the real connector, not merely "not the payload".
    expect(code).toContain('github');
    expect(code.length).toBeGreaterThan(PLANTED_BUNDLE.length);
  });

  /**
   * INVERTED from "Cloud refuses outright when the row is organization-scoped".
   *
   * Refusing here is what turned an admitted run into a failed CLAIMED run:
   * readers select `ORDER BY organization_id NULLS LAST`, so an org-scoped
   * copy of an image-shipped key wins the selection, and the whole default
   * catalog went dark for any workspace old enough to have one. Compiling the
   * image file honours the identical invariant the refusal did — the planted
   * bytes still never execute, asserted below — while keeping it online.
   */
  test('Cloud compiles the image for an org-scoped row, and its bytes never execute', async () => {
    process.env.LOBU_CLOUD_MODE = 'true';
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    const code = await resolveConnectorCode('github', {
      ...sharedRow,
      organization_id: 'org_planted',
    });

    expect(code).not.toContain(PLANTED_MARKER);
    expect(code).not.toBe(PLANTED_BUNDLE);
    expect(code).toContain('github');
  });

  /**
   * The substitution above is invisible from the run: the org's bytes are
   * discarded and the image runs instead. An org that deliberately overrode a
   * catalog key would otherwise see a connector that "works" while executing
   * code it did not install, so the resolver is the one place that can say so.
   * The line's volume is also how the shadow-row cleanup gets measured.
   */
  test('Cloud logs the substitution, and stays quiet for a shared row', async () => {
    process.env.LOBU_CLOUD_MODE = 'true';
    const warn = vi.fn();
    vi.doMock('../logger', () => ({
      default: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    await resolveConnectorCode('github', { ...sharedRow, organization_id: 'org_planted' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      connector_key: 'github',
      organization_id: 'org_planted',
    });

    // A shared row is the ordinary Cloud shape — every connector would log.
    warn.mockClear();
    await resolveConnectorCode('github', sharedRow);
    expect(warn).not.toHaveBeenCalled();
  });

  test('Cloud admits an org-scoped row for a key the image does not ship on isolate lane', async () => {
    process.env.LOBU_CLOUD_MODE = 'true';
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    const code = await resolveConnectorCode('zz.staleprobe', {
      ...sharedRow,
      organization_id: 'org_planted',
      version: '1.0.0',
    });
    expect(code).toBe(PLANTED_BUNDLE);
  });

  test('Cloud admits stored code for isolate lane when image ships no source', async () => {
    process.env.LOBU_CLOUD_MODE = 'true';
    const { resolveConnectorCode } = await import('../ensure-connector-installed');

    const code = await resolveConnectorCode('zz.staleprobe', { ...sharedRow, version: '1.0.0' });
    expect(code).toBe(PLANTED_BUNDLE);
  });
});
