/**
 * Executor selection: all connectors execute inside a hardened V8 isolate (IsolateExecutor).
 */

import { isolatedVmUnavailableReason, loadIsolatedVm } from '../isolate/load.js';
import type { SyncExecutor } from './interface.js';
import { IsolateExecutor, type IsolateExecutorOptions, IsolateRuntimeUnavailableError } from './isolate.js';

export interface ExecutorSelection {
  /** Wall-clock budget for the run; `0` disables it. Unset keeps default (600s). */
  timeoutMs?: number;
  /** V8 heap limit in MB. Unset keeps the default (512). */
  memoryMb?: number;
  /** Hosts the connector may reach, in the shared egress grammar. Unset is
   *  unrestricted; an EMPTY list denies everything. */
  allowedDomains?: readonly string[];
  /** Console sink override (tests). */
  logSink?: IsolateExecutorOptions['logSink'];
  /**
   * Cap on one string crossing the isolate bridge. Unset keeps the default.
   *
   * An agent turn raises this: its envelope carries the session journal and
   * base64'd attachments in ONE string, so the connector default is too small
   * for a lane the gateway already bounds at admission.
   */
  messageBytes?: number;
}

/**
 * Build the executor for a job. There is exactly one: connector code runs in a
 * hardened V8 isolate, which IS the security boundary for organization-supplied
 * code. Nothing about the job selects it, so a host that cannot load
 * `isolated-vm` (Bun, Node 25, or a failed native build) rejects with
 * `IsolateRuntimeUnavailableError` rather than falling back to anything.
 */
export async function selectExecutor(selection: ExecutorSelection = {}): Promise<SyncExecutor> {
  const ivm = await loadIsolatedVm();
  if (!ivm) throw new IsolateRuntimeUnavailableError(isolatedVmUnavailableReason());
  const options: Partial<IsolateExecutorOptions> = {};
  if (selection.timeoutMs !== undefined) options.timeoutMs = selection.timeoutMs;
  if (selection.memoryMb !== undefined) options.memoryMb = selection.memoryMb;
  if (selection.allowedDomains !== undefined) options.allowedDomains = selection.allowedDomains;
  if (selection.logSink !== undefined) options.logSink = selection.logSink;
  if (selection.messageBytes !== undefined) options.messageBytes = selection.messageBytes;
  return new IsolateExecutor(options);
}
