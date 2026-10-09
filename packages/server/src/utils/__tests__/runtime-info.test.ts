import { describe, expect, it } from 'vitest';
import {
  getRuntimeInfo,
  resolveRuntimeEnvironment,
  resolveDiagnosticRuntime,
} from '../runtime-info';

describe('resolveRuntimeEnvironment', () => {
  it('prefers ENVIRONMENT over NODE_ENV', () => {
    expect(resolveRuntimeEnvironment({ ENVIRONMENT: 'production', NODE_ENV: 'development' })).toBe(
      'production'
    );
  });

  it('falls back to NODE_ENV when ENVIRONMENT is missing', () => {
    expect(resolveRuntimeEnvironment({ NODE_ENV: 'production' })).toBe('production');
  });
});

describe('resolveDiagnosticRuntime', () => {
  it('ignores the baked-in NODE_ENV=production when ENVIRONMENT is missing', () => {
    // Docker images always set NODE_ENV=production; only an explicit
    // ENVIRONMENT in the supplied snapshot may tag diagnostics as production.
    // An unrelated host value must not leak into an explicit test/runtime snapshot.
    const previousEnvironment = process.env.ENVIRONMENT;
    process.env.ENVIRONMENT = 'production';
    try {
      expect(resolveDiagnosticRuntime({ NODE_ENV: 'production' })).toEqual({
        environment: 'development',
        isDevelopment: true,
        devTaggedAsProduction: false,
      });
    } finally {
      if (previousEnvironment === undefined) {
        delete process.env.ENVIRONMENT;
      } else {
        process.env.ENVIRONMENT = previousEnvironment;
      }
    }
  });

  it('tags production only when ENVIRONMENT declares it', () => {
    expect(
      resolveDiagnosticRuntime({ ENVIRONMENT: 'production', NODE_ENV: 'production' })
    ).toEqual({
      environment: 'production',
      isDevelopment: false,
      devTaggedAsProduction: false,
    });
  });

  it('downgrades only a development runtime carrying a production tag', () => {
    expect(
      resolveDiagnosticRuntime({ ENVIRONMENT: 'production', NODE_ENV: 'development' })
    ).toEqual({
      environment: 'development',
      isDevelopment: true,
      devTaggedAsProduction: true,
    });
  });
});

describe('getRuntimeInfo', () => {
  it('returns revision and build metadata from env', () => {
    expect(
      getRuntimeInfo({
        NODE_ENV: 'production',
        APP_GIT_SHA: 'abc123',
        APP_BUILD_TIME: '2026-04-12T23:00:00Z',
      })
    ).toMatchObject({
      environment: 'production',
      revision: 'abc123',
      build_time: '2026-04-12T23:00:00Z',
    });
  });
});
