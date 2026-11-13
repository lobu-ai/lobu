import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_RUN_BUDGET_MS,
  RATE_LIMIT_STEP_MS,
  SourceAdmission,
  SourceAdmissionRefusedError,
  type SourceCallerClass,
  type SourceRunSlot,
} from './source-admission';

const CONNECTION = 7;

describe('per-connection source admission', () => {
  let admission: SourceAdmission;
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    admission = new SourceAdmission(4, 3);
  });
  afterEach(() => vi.useRealTimers());

  const request = (callerClass: SourceCallerClass, signal?: AbortSignal, deadlineMs = 20_000) =>
    ({ callerClass, deadlineAt: Date.now() + deadlineMs, signal });
  /** Track which acquisitions have been admitted, in order. */
  function tracked(callerClass: SourceCallerClass, label: string, order: string[], deadlineMs?: number) {
    return admission.acquire(CONNECTION, request(callerClass, undefined, deadlineMs)).then((slot) => {
      order.push(label);
      return slot;
    });
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);
  /** Hold `n` slots, reporting whether each run was rate limited on release. */
  async function hold(n: number, callerClass: SourceCallerClass = 'member'): Promise<SourceRunSlot[]> {
    return Promise.all(Array.from({ length: n }, () => admission.acquire(CONNECTION, request(callerClass))));
  }

  it('leaves visitors one slot short of the limit and dequeues members first', async () => {
    const order: string[] = [];
    const visitors = await hold(3, 'anonymous');
    const queuedVisitor = tracked('anonymous', 'visitor', order);
    await flush();
    expect(order).toEqual([]);
    // The slot visitors cannot take is a member's.
    const member = await admission.acquire(CONNECTION, request('member'));
    const queuedMember = tracked('member', 'member', order);
    await flush();
    // A freed slot goes to the waiting member, though the visitor queued first.
    member.release({ rateLimited: false });
    await flush();
    expect(order).toEqual(['member']);
    visitors[0]!.release({ rateLimited: false });
    await flush();
    expect(order).toEqual(['member', 'visitor']);
    for (const slot of [...visitors.slice(1), await queuedVisitor, await queuedMember]) slot.release({ rateLimited: false });
  });

  it('refuses at once when the queue is full, with a bounded Retry-After', async () => {
    const running = await hold(4);
    const waiting = Array.from({ length: 3 }, () => admission.acquire(CONNECTION, request('member')));
    const refused = await admission.acquire(CONNECTION, request('member')).catch((error) => error);
    expect(refused).toBeInstanceOf(SourceAdmissionRefusedError);
    expect(refused).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: true, outcome: 'refused_queue_full' });
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(30);
    for (const slot of running) slot.release({ rateLimited: false });
    for (const slot of await Promise.all(waiting)) slot.release({ rateLimited: false });
  });

  it('runs a short deadline when a slot is free but never queues it', async () => {
    const short = { callerClass: 'member' as const, deadlineAt: Date.now() + MIN_RUN_BUDGET_MS - 1 };
    const slots = [await admission.acquire(CONNECTION, short), ...(await hold(3))];
    await expect(admission.acquire(CONNECTION, short)).rejects.toMatchObject({ outcome: 'refused_deadline' });
    for (const slot of slots) slot.release({ rateLimited: false });
  });

  it('a waiter leaves when only the run budget is left of its deadline, or when aborted', async () => {
    const running = await hold(4);
    const expiring = admission.acquire(CONNECTION, request('member')).catch((error) => error);
    const controller = new AbortController();
    const aborted = admission.acquire(CONNECTION, request('member', controller.signal)).catch((error) => error);
    controller.abort(new Error('caller left'));
    expect(await aborted).toMatchObject({ message: 'caller left' });
    await vi.advanceTimersByTimeAsync(20_000 - MIN_RUN_BUDGET_MS);
    expect(await expiring).toMatchObject({ outcome: 'refused_deadline' });
    // Both left the queue: three new waiters fit again.
    const order: string[] = [];
    const waiters = ['a', 'b', 'c'].map((label) => tracked('member', label, order));
    for (const slot of running) slot.release({ rateLimited: false });
    await flush();
    expect(order).toEqual(['a', 'b', 'c']);
    for (const slot of await Promise.all(waiters)) slot.release({ rateLimited: false });
  });

  it('halves the limit once per burst of 429s and restores a slot per clean interval', async () => {
    const order: string[] = [];
    const burst = await hold(4);
    // Every run of one burst reports the same 429; the limit halves once, to 2.
    for (const slot of burst) slot.release({ rateLimited: true });
    const running = await hold(2);
    // Waits past one interval, so its deadline is further out than that.
    const third = tracked('member', 'third', order, 2 * RATE_LIMIT_STEP_MS);
    await flush();
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(RATE_LIMIT_STEP_MS);
    // The restore is applied when the connection is next touched.
    running[0]!.release({ rateLimited: false });
    running[1]!.release({ rateLimited: false });
    await flush();
    expect(order).toEqual(['third']);
    const atThree = [await third, ...(await hold(2))];
    const fourth = tracked('member', 'fourth', order);
    await flush();
    expect(order).toEqual(['third']);

    // A run admitted under the lowered limit that is refused again halves it again.
    atThree[0]!.release({ rateLimited: true });
    await flush();
    expect(order).toEqual(['third']);
    for (const slot of atThree.slice(1)) slot.release({ rateLimited: false });
    await flush();
    expect(order).toEqual(['third', 'fourth']);
    (await fourth).release({ rateLimited: false });
  });
});

describe('coalesced source reads', () => {
  const participant = (signal?: AbortSignal) =>
    ({ callerClass: 'anonymous' as const, deadlineAt: Date.now() + 20_000, signal });

  it('runs once for concurrent identical callers and gives each its own copy', async () => {
    const admission = new SourceAdmission();
    let runs = 0;
    let finish!: (value: { rows: Array<{ n: number }> }) => void;
    const start = async () => {
      runs += 1;
      return new Promise<{ rows: Array<{ n: number }> }>((resolve) => { finish = resolve; });
    };
    const first = admission.coalesce('same', CONNECTION, participant(), start);
    const second = admission.coalesce('same', CONNECTION, participant(), start);
    finish({ rows: [{ n: 1 }] });
    const [a, b] = await Promise.all([first, second]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
    expect(a.rows[0]).not.toBe(b.rows[0]);
    // Settled: the next caller starts a fresh read.
    const third = admission.coalesce('same', CONNECTION, participant(), async () => ({ rows: [{ n: 2 }] }));
    expect(await third).toEqual({ rows: [{ n: 2 }] });
  });

  it('a joiner due sooner than the shared run times out alone', async () => {
    const admission = new SourceAdmission();
    let finish!: (value: string) => void;
    const start = async () => new Promise<string>((resolve) => { finish = resolve; });
    const led = admission.coalesce('read', CONNECTION, participant(), start);
    const hurried = { callerClass: 'member' as const, deadlineAt: Date.now() + 20 };
    await expect(admission.coalesce('read', CONNECTION, hurried, start)).rejects.toMatchObject({ exitReason: 'timeout' });
    finish('rows');
    expect(await led).toBe('rows');
  });

  it('aborts the shared run only when every participant has left', async () => {
    const admission = new SourceAdmission();
    let runSignal!: AbortSignal;
    let finish!: (value: string) => void;
    const start = async (signal: AbortSignal) => {
      runSignal = signal;
      return new Promise<string>((resolve) => { finish = resolve; });
    };
    const leader = new AbortController();
    const joiner = new AbortController();
    const led = admission.coalesce('read', CONNECTION, participant(leader.signal), start);
    const joined = admission.coalesce('read', CONNECTION, participant(joiner.signal), start);
    leader.abort(new Error('leader left'));
    await expect(led).rejects.toThrow('leader left');
    expect(runSignal.aborted).toBe(false);
    finish('rows');
    expect(await joined).toBe('rows');

    const alone = new AbortController();
    const abandoned = admission.coalesce('other', CONNECTION, participant(alone.signal), start);
    alone.abort(new Error('nobody left'));
    await expect(abandoned).rejects.toThrow('nobody left');
    expect(runSignal.aborted).toBe(true);
  });
});
