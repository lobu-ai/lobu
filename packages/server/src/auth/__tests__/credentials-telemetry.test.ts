import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../../db/client';
import logger from '../../utils/logger';
import { CredentialService } from '../credentials';

const endpointSecret = 'synthetic-endpoint-secret';
const responseSecret = 'synthetic-response-secret';
const params = {
  tokenUrl: `https://provider.example/token?client_secret=${endpointSecret}`,
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-client-secret',
  refreshToken: 'synthetic-refresh-token',
};
const service = new CredentialService({} as DbClient);

afterEach(() => vi.restoreAllMocks());

function captureLogs() {
  return {
    error: vi.spyOn(logger, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(logger, 'warn').mockImplementation(() => {}),
    console: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

function expectNoCredentials(logs: ReturnType<typeof captureLogs>) {
  const output = JSON.stringify([logs.error.mock.calls, logs.warn.mock.calls, logs.console.mock.calls]);
  for (const secret of [endpointSecret, responseSecret, params.clientSecret, params.refreshToken]) {
    expect(output).not.toContain(secret);
  }
}

describe('OAuth refresh failure telemetry', () => {
  it.each([400, 401, 403, 429])('keeps HTTP %i refresh rejections out of error telemetry', async (status) => {
    const logs = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: responseSecret }), { status },
    ));
    expect(await service.refreshTokenGeneric(params)).toBeNull();
    expect(logs.error).not.toHaveBeenCalled();
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status, token_origin: 'https://provider.example' }),
      '[Credentials] Generic token refresh failed',
    );
    expectNoCredentials(logs);
  });

  it('reports a provider outage without response text or endpoint credentials', async () => {
    const logs = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(responseSecret, { status: 503 }));
    expect(await service.refreshTokenGeneric(params)).toBeNull();
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 503, token_origin: 'https://provider.example' }),
      '[Credentials] Generic token refresh failed',
    );
    expectNoCredentials(logs);
  });

  it.each([400, 429, 503])('classifies HTTP %i without reading an unused error body', async (status) => {
    const logs = captureLogs();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(responseSecret));
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }));
    expect(await service.refreshTokenGeneric(params)).toBeNull();
    const reported = status < 500 ? logs.warn : logs.error;
    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ status, token_origin: 'https://provider.example' }),
      '[Credentials] Generic token refresh failed',
    );
    if (status < 500) expect(logs.error).not.toHaveBeenCalled();
    expectNoCredentials(logs);
  });

  it('cancels a rejected refresh body without waiting for it to finish', async () => {
    const logs = captureLogs();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 401 }));
    expect(await service.refreshTokenGeneric(params)).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(logs.warn).toHaveBeenCalledOnce();
    expect(logs.error).not.toHaveBeenCalled();
  });

  it('reports malformed success JSON without logging its contents', async () => {
    const logs = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(responseSecret, { status: 200 }));
    expect(await service.refreshTokenGeneric(params)).toBeNull();
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, token_origin: 'https://provider.example' }),
      '[Credentials] Generic token refresh returned invalid JSON',
    );
    expectNoCredentials(logs);
  });

  it('reports a success response missing an access token without its body', async () => {
    const logs = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ unexpected: responseSecret }), { status: 200 },
    ));
    expect(await service.refreshTokenGeneric(params)).toBeNull();
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({ token_origin: 'https://provider.example' }),
      '[Credentials] Generic token refresh returned no access_token',
    );
    expectNoCredentials(logs);
  });

  it('scrubs credential-bearing transport errors before structured logging', async () => {
    const logs = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`Fetch failed for ${params.tokenUrl}`));
    expect(await service.refreshTokenGeneric(params)).toBeNull();
    expect(logs.error).toHaveBeenCalledWith(
      expect.objectContaining({ token_origin: 'https://provider.example', err: expect.any(Object) }),
      '[Credentials] Generic token refresh error',
    );
    expectNoCredentials(logs);
  });

  it('returns valid refreshed tokens without emitting failure telemetry', async () => {
    const logs = captureLogs();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ access_token: 'synthetic-access', expires_in: 3600 }), { status: 200 },
    ));
    expect(await service.refreshTokenGeneric(params)).toMatchObject({ accessToken: 'synthetic-access' });
    expect(logs.error).not.toHaveBeenCalled();
    expect(logs.warn).not.toHaveBeenCalled();
  });
});
