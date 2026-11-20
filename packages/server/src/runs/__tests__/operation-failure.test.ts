import { describe, expect, it, vi } from 'vitest';
import { dependencyUnavailableError } from '../../connectors/dependency-unavailable';
import { describeOperationFailure, operationFailureMessage, recordOperationFailure } from '../operation-failure';

const failure = {
  connectorKey: 'linkedin',
  operationKey: 'send_connection_request',
  errorMessage: 'LinkedIn connect failed: LinkedIn profile header was not found; the page shows "Message · Follow"',
};

function capture(fn: () => void) {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    fn();
    return write.mock.calls.map(([line]) => String(line)).join('');
  } finally { write.mockRestore(); }
}

describe('operation failure grouping', () => {
  it('groups one cause across page text and separates operations', () => {
    const report = describeOperationFailure(failure);
    expect(report.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(report.kind).toBe('system');
    expect(report.grouping).toContain('operation linkedin.send_connection_request|OperationFailed');
    expect(describeOperationFailure({ ...failure, errorMessage: failure.errorMessage.replace('Message · Follow', 'Get in touch') }).fingerprint)
      .toBe(report.fingerprint);
    expect(describeOperationFailure({ ...failure, operationKey: 'follow' }).fingerprint).not.toBe(report.fingerprint);
    expect(describeOperationFailure({ ...failure, errorMessage: 'LinkedIn shows no follow control for this member' }).fingerprint)
      .not.toBe(report.fingerprint);
  });

  it('reads the dependency marker as structure, not prose', () => {
    const report = describeOperationFailure({
      ...failure,
      errorMessage: dependencyUnavailableError('browser_setup_required', 'Choose a paired Chrome browser for this connection before running it.'),
    });
    expect(report.kind).toBe('dependency');
    expect(report.code).toBe('browser_setup_required');
    expect(report.message).not.toContain('[lobu:');
  });
});

describe('operation failure recording', () => {
  it('logs the fingerprint the caller is given, without the failure text', () => {
    const output = capture(() => recordOperationFailure({ ...failure, runId: 41, organizationId: 'org-1' }));
    const [record] = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(record).toMatchObject({
      level: 'error',
      source: 'operation_failure',
      run_id: 41,
      organization_id: 'org-1',
      connector_key: 'linkedin',
      operation_key: 'send_connection_request',
      error_fingerprint: describeOperationFailure(failure).fingerprint,
      error_kind: 'system',
    });
    expect(output).not.toContain('profile header');
    expect(output).not.toContain('Message · Follow');
  });

  it('records only the run the agent called, not its child steps', () => {
    expect(capture(() => recordOperationFailure({ ...failure, runId: 42, organizationId: 'org-1', parentRunId: 41 }))).toBe('');
  });

  it('gives a device run that failed without a message the text its caller sees', () => {
    expect(operationFailureMessage(42, null)).toBe('Run 42 failed');
    expect(operationFailureMessage(42, undefined)).toBe('Run 42 failed');
    expect(operationFailureMessage(42, 'boom')).toBe('boom');
  });
});
