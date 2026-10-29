/**
 * Unit test for the orphaned-cluster reaper (embedded-postgres-backend).
 *
 * Killed test runs (SIGKILL / timeout / OOM / ENOSPC) skip teardown and leak
 * their `lobu-test-pg-*` data dir to tmp; a session of them once filled 65 GB.
 * The first embedded-PG start in each test process reaps old clusters left by
 * previous killed runs. This pins that logic.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';

/**
 * A PID that is reliably dead across runtimes: spawn a process to completion
 * (spawnSync reaps it), so its PID is freed. More portable than a magic
 * out-of-range number, which `process.kill(pid, 0)` handles inconsistently
 * (node throws ESRCH; bun can report it as alive).
 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid ?? 2147483646;
}
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  reapStaleClustersIn,
  releaseOrphanedPostgresSegments,
  STALE_CLUSTER_MS,
} from '../setup/reap-stale-clusters';

describe('reapStaleClustersIn', () => {
  let root: string;
  const now = Date.now();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'reaper-test-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Writing the pid file must happen BEFORE utimesSync — creating a file inside
  // the dir bumps the dir's mtime, which would otherwise make a "stale" dir look
  // fresh and the reaper would skip it.
  function makeDir(name: string, ageMs: number, pid?: number): string {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    if (pid !== undefined) writeFileSync(join(p, 'postmaster.pid'), `${pid}\n/some/data\n`);
    const t = (now - ageMs) / 1000; // utimes wants seconds
    utimesSync(p, t, t);
    return p;
  }

  it('removes only stale lobu-test-pg-* dirs, keeps fresh and non-matching', () => {
    const stale = makeDir('lobu-test-pg-OLD', STALE_CLUSTER_MS + 60_000);
    const fresh = makeDir('lobu-test-pg-NEW', 5_000); // 5s old — active
    const other = makeDir('some-other-dir', STALE_CLUSTER_MS + 60_000); // not ours

    const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

    expect(removed).toBe(1);
    expect(existsSync(stale)).toBe(false); // reaped
    expect(existsSync(fresh)).toBe(true); // too young — a possibly-active run
    expect(existsSync(other)).toBe(true); // wrong prefix — never touched
  });

  it('keeps an OLD cluster that is still running (live postmaster.pid)', () => {
    // A long watch/CI run can outlive the staleness window — its data dir must
    // never be reaped while the cluster is alive (the review blocker).
    const live = makeDir('lobu-test-pg-LIVE', STALE_CLUSTER_MS + 60_000, process.pid); // our own live PID
    const deadOwner = makeDir('lobu-test-pg-DEAD', STALE_CLUSTER_MS + 60_000, deadPid()); // reaped PID

    const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

    expect(existsSync(live)).toBe(true); // live owner → never reaped, despite age
    expect(existsSync(deadOwner)).toBe(false); // stale pid file, process gone → reaped
    expect(removed).toBe(1);
  });

  it('is a no-op on a missing directory (never throws)', () => {
    expect(reapStaleClustersIn(join(root, 'does-not-exist'), now, STALE_CLUSTER_MS)).toBe(0);
  });

  it('treats a malformed PID line as having no live owner', () => {
    const path = makeDir('lobu-test-pg-MALFORMED', STALE_CLUSTER_MS + 60_000);
    writeFileSync(join(path, 'postmaster.pid'), `${process.pid}junk\n`);
    const t = (now - STALE_CLUSTER_MS - 60_000) / 1000;
    utimesSync(path, t, t);

    expect(reapStaleClustersIn(root, now, STALE_CLUSTER_MS)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  describe('orphaned postmaster (reparented to PID 1)', () => {
    const spawned = new Set<number>();

    function postmasterArgs(dataDir: string): string[] {
      return ['-e', 'setInterval(() => {}, 1000)', '--', '-D', dataDir];
    }

    /**
     * Start a process that outlives its own parent, so the kernel reparents it to
     * PID 1 — the normal result for an embedded-postgres postmaster whose test
     * runner is SIGKILLed. The short-lived Node parent exits after printing the
     * child PID, and spawnSync waits for that exit, so reparenting has happened
     * by the time this returns.
     */
    function orphanPostmaster(dataDir: string): number {
      const parent = `
        const { spawn } = require('node:child_process');
        const child = spawn(
          ${JSON.stringify(process.execPath)},
          ${JSON.stringify(postmasterArgs(dataDir))},
          { argv0: 'postgres', detached: true, stdio: 'ignore' },
        );
        child.unref();
        process.stdout.write(String(child.pid));
      `;
      const r = spawnSync(process.execPath, ['-e', parent], { encoding: 'utf8' });
      const pid = Number.parseInt((r.stdout ?? '').trim(), 10);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      spawned.add(pid);
      return pid;
    }

    /**
     * A stale cluster dir whose `postmaster.pid` names a live orphan.
     *
     * The fake exposes the `postgres` executable name and exact `-D <dir>`
     * arguments that the reaper requires. Its pid file records the requested
     * start time on line three, matching PostgreSQL's format.
     */
    function makeOrphanDir(
      name: string,
      ageMs: number,
      processDataDir: (dir: string) => string = (dir) => dir,
    ) {
      const p = join(root, name);
      const pidFile = join(p, 'postmaster.pid');
      mkdirSync(p, { recursive: true });
      const pid = orphanPostmaster(processDataDir(p));
      const t = (now - ageMs) / 1000;
      writeFileSync(pidFile, `${pid}\n${p}\n${Math.floor(t)}\n`);
      return { path: p, pid };
    }

    function isLive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    }

    /**
     * Still genuinely RUNNING — not merely a PID the kernel still answers for.
     *
     * A signalled direct child of this process becomes a zombie until it is
     * waited on, and `kill(pid, 0)` succeeds for a zombie. Asserting protection
     * with `isLive` alone therefore passes even when the process was killed,
     * which silently hid whether the owned-cluster guard fired at all. `ps`
     * reports state `Z` for a zombie, so exclude it.
     */
    function isRunning(pid: number): boolean {
      const r = spawnSync('ps', ['-o', 'state=', '-p', String(pid)], { encoding: 'utf8' });
      if (r.status !== 0 || typeof r.stdout !== 'string') return false;
      const state = r.stdout.trim();
      return state.length > 0 && !state.startsWith('Z');
    }

    /** Poll briefly because signal delivery and process teardown are asynchronous. */
    function waitGone(pid: number): boolean {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!isLive(pid)) return true;
        spawnSync('sleep', ['0.05']);
      }
      return false;
    }

    afterAll(() => {
      for (const pid of spawned) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already reaped by the code under test — that is the point
        }
      }
    });

    it('stops and removes an old cluster whose owner is gone', () => {
      // A bare liveness probe sees a live postmaster and otherwise preserves an
      // abandoned cluster at any age.
      const { path, pid } = makeOrphanDir('lobu-test-pg-ORPHAN', STALE_CLUSTER_MS + 60_000);
      expect(isRunning(pid)).toBe(true); // precondition: it really is running

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(1);
      expect(existsSync(path)).toBe(false);
      expect(waitGone(pid)).toBe(true); // stopped, not just unlinked
      spawned.delete(pid);
    });

    it('keeps a young orphan (a run that just started and lost its parent)', () => {
      const { path, pid } = makeOrphanDir('lobu-test-pg-YOUNGORPHAN', 5_000);

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(isRunning(pid)).toBe(true); // never signalled
    });

    it('never touches an old cluster whose postmaster still has a live parent', () => {
      // The realistic form of the protection above: a process that passes the
      // postmaster executable/data-dir identity check but whose owning run is
      // still alive. A long watch or CI run can outlive the staleness window,
      // and pulling its database out from under it breaks that run. This is the
      // test that fails if the PPID check is dropped.
      const p = join(root, 'lobu-test-pg-OWNED');
      const pidFile = join(p, 'postmaster.pid');
      mkdirSync(p, { recursive: true });
      // A DIRECT child, so its PPID is this test process, not 1.
      const child = spawn(process.execPath, postmasterArgs(p), {
        argv0: 'postgres',
        stdio: 'ignore',
      });
      const pid = child.pid;
      expect(pid).toBeGreaterThan(0);
      if (pid !== undefined) spawned.add(pid);
      writeFileSync(
        pidFile,
        `${pid}\n${p}\n${Math.floor((now - STALE_CLUSTER_MS - 60_000) / 1000)}\n`,
      );

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(0);
      expect(existsSync(p)).toBe(true);
      expect(isRunning(pid as number)).toBe(true);
      child.kill('SIGKILL');
      if (pid !== undefined) spawned.delete(pid);
    });

    it('never signals a PID whose data-dir argument merely shares the cluster prefix', () => {
      // `postmaster.pid` is a plain file left behind by a crash: the OS can have
      // reassigned that number to an unrelated process. Signalling it would kill
      // somebody else's work, so a different exact `-D` argument must not match.
      const { path, pid } = makeOrphanDir(
        'lobu-test-pg-RECYCLED',
        STALE_CLUSTER_MS + 60_000,
        (dir) => `${dir}-other`,
      );

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(isRunning(pid)).toBe(true);
    });

    it('keeps a live orphan when its recorded start time is invalid', () => {
      const { path, pid } = makeOrphanDir('lobu-test-pg-NOSTART', STALE_CLUSTER_MS + 60_000);
      writeFileSync(join(path, 'postmaster.pid'), `${pid}\n${path}\nnot-a-time\n`);

      const removed = reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(removed).toBe(0);
      expect(existsSync(path)).toBe(true);
      expect(isRunning(pid)).toBe(true);
    });
  });

  describe('shared-memory cleanup failures and listing formats', () => {
    const linuxHeader = 'key shmid owner perms bytes nattch status\n';
    const macHeader = 'T ID KEY MODE OWNER GROUP NATTCH\n';

    function probe(listing: string, ipcsStatus = 0, ipcrmStatus = 0, pid = deadPid(), key = '1275068416') {
      const dir = makeDir('lobu-test-pg-SHM-LISTING', 5_000);
      writeFileSync(join(dir, 'postmaster.pid'), `${pid}\n${dir}\n1\n5432\n/tmp\nlocalhost\n${key} 64\n`);
      const t = (now - STALE_CLUSTER_MS - 60_000) / 1000;
      utimesSync(dir, t, t);
      const realSpawn = childProcess.spawnSync;
      const calls: string[] = [];
      const mock = vi.spyOn(childProcess, 'spawnSync').mockImplementation((command, ...args) => {
        if (command !== 'ipcs' && command !== 'ipcrm') {
          return Reflect.apply(realSpawn, childProcess, [command, ...args]);
        }
        calls.push(command);
        return {
          status: command === 'ipcs' ? ipcsStatus : ipcrmStatus,
          stdout: command === 'ipcs' ? listing : '',
          stderr: '', pid: 0, output: [], signal: null,
        };
      });
      try {
        reapStaleClustersIn(root, now, STALE_CLUSTER_MS);
        return { calls, kept: existsSync(dir) };
      } finally {
        mock.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it.each([
      linuxHeader + '0x4c000000 99 fixture 600 64 0\n',
      macHeader + 'm 99 0x4c000000 --rw------- fixture 64 0\n',
    ])('matches the segment ID column, not another numeric field: %s', (listing) => {
      expect(probe(listing).calls).not.toContain('ipcrm');
    });

    it.each([
      linuxHeader + '0x4c000000 64 fixture 600 64 1\n',
      macHeader + 'm 64 0x4c000000 --rw------- fixture fixture 1\n',
    ])('preserves a segment and directory while backends remain attached: %s', (listing) => {
      expect(probe(listing)).toEqual({ calls: ['ipcs'], kept: true });
    });

    it('keeps the pid file for retry when ipcs fails', () => {
      expect(probe('', 1).kept).toBe(true);
    });

    it('keeps the pid file for retry when ipcrm fails', () => {
      expect(probe(linuxHeader + '0x4c000000 64 fixture 600 64 0\n', 0, 1).kept).toBe(true);
    });

    it('protects a recorded segment when the postmaster PID is malformed', () => {
      expect(probe(linuxHeader + '0x4c000000 64 fixture 600 64 0\n', 0, 0, NaN))
        .toEqual({ calls: [], kept: true });
    });

    it.each(['', 'unrecognized listing'])('keeps the pid file when ipcs output is unknown: %s', (listing) => {
      expect(probe(listing)).toEqual({ calls: ['ipcs'], kept: true });
    });

    it('normalizes a signed key printed as unsigned long by PostgreSQL', () => {
      expect(probe(linuxHeader + '0xcc000001 64 fixture 600 64 0\n', 0, 0, deadPid(), '18446744072837136385'))
        .toEqual({ calls: ['ipcs', 'ipcrm'], kept: false });
    });
  });

  describe('System V shared memory recorded by a dead postmaster', () => {
    // perl's shmget creates a real segment the way PostgreSQL does, so these
    // exercise the actual ipcs/ipcrm path the reaper relies on.
    const created = new Set<number>();
    const canCreate = spawnSync('perl', ['-MIPC::SysV', '-e', '1']).status === 0;

    function createSegment(key: number, bytes = 64): number {
      const signedKey = Number(BigInt.asIntN(32, BigInt(key)));
      const r = spawnSync('perl', ['-MIPC::SysV=IPC_CREAT,IPC_EXCL', '-e',
        `my $id = shmget(${signedKey}, ${bytes}, IPC_CREAT | IPC_EXCL | 0600); defined $id or die "shmget: $!"; print $id`],
        { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`shmget failed: ${r.stderr}`);
      const id = Number(r.stdout);
      created.add(id);
      return id;
    }

    function segmentExists(id: number): boolean {
      const r = spawnSync('perl', ['-MIPC::SysV=IPC_STAT', '-MErrno=EINVAL,EIDRM', '-e',
        `my $buf; exit 0 if defined shmctl(${id}, IPC_STAT, $buf); die "shmctl: $!" unless $! == EINVAL || $! == EIDRM; exit 1`],
        { encoding: 'utf8' });
      if (r.status !== 0 && r.status !== 1) throw new Error(`shmctl failed: ${r.stderr}`);
      return r.status === 0;
    }

    const holders: ChildProcess[] = [];

    afterEach(() => {
      for (const holder of holders) holder.kill('SIGKILL');
      holders.length = 0;
      for (const id of created) spawnSync('ipcrm', ['-m', String(id)]);
      created.clear();
    });

    /** Run a perl script that stays alive after printing one line; resolve with that line. */
    function holdWith(script: string): Promise<string> {
      const holder = spawn('perl', ['-MIPC::SysV=IPC_CREAT,IPC_EXCL,shmat', '-e', `$| = 1; ${script}; sleep 60`]);
      holders.push(holder);
      return new Promise((resolve, reject) => {
        holder.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim()));
        holder.once('exit', (code) => reject(new Error(`holder exited ${code}`)));
      });
    }

    // A synthetic key in the range PostgreSQL derives keys from, unlikely to clash.
    function syntheticKey(): number {
      return 0x4c000000 + Math.floor(Math.random() * 0xffffff);
    }

    function writePidFile(dir: string, pid: number, key: number, id: number): void {
      const recordedKey = BigInt.asUintN(64, BigInt.asIntN(32, BigInt(key)));
      writeFileSync(join(dir, 'postmaster.pid'),
        `${pid}\n${dir}\n${Math.floor(now / 1000)}\n5432\n/tmp\nlocalhost\n${String(recordedKey).padStart(9)} ${String(id).padStart(9)}\nready\n`);
    }

    it.skipIf(!canCreate)('releases the segment of a dead postmaster, even while its dir is still young', () => {
      const key = syntheticKey();
      const id = createSegment(key);
      const dir = makeDir('lobu-test-pg-SHM-DEAD', 5_000);
      writePidFile(dir, deadPid(), key, id);

      reapStaleClustersIn(root, now, STALE_CLUSTER_MS);
      expect(segmentExists(id)).toBe(false); // its slot is free already
      expect(existsSync(dir)).toBe(true); // the dir is too young to delete
      rmSync(dir, { recursive: true, force: true });
    });

    it.skipIf(!canCreate)('releases the segment when an old dead cluster is removed', () => {
      const key = syntheticKey();
      const id = createSegment(key);
      const dir = makeDir('lobu-test-pg-SHM-OLD', 5_000);
      writePidFile(dir, deadPid(), key, id);
      const t = (now - STALE_CLUSTER_MS - 60_000) / 1000;
      utimesSync(dir, t, t);

      reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(existsSync(dir)).toBe(false);
      expect(segmentExists(id)).toBe(false);
    });

    it.skipIf(!canCreate)('never removes a segment whose id is now listed under a different key', () => {
      const key = syntheticKey();
      const id = createSegment(key);
      const dir = makeDir('lobu-test-pg-SHM-REUSED', 5_000);
      writePidFile(dir, deadPid(), key + 1, id); // id reassigned since the pid file was written

      reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(segmentExists(id)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    it.skipIf(!canCreate)('releases a segment whose key has the sign bit set', () => {
      const key = syntheticKey() + 0x80000000;
      const id = createSegment(key);
      const dir = makeDir('lobu-test-pg-SHM-HIGH-KEY', 5_000);
      writePidFile(dir, deadPid(), key, id);

      reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(segmentExists(id)).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    });

    it.skipIf(!canCreate)('never removes the segment of a live postmaster', () => {
      const key = syntheticKey();
      const id = createSegment(key);
      const dir = makeDir('lobu-test-pg-SHM-LIVE', 5_000);
      writePidFile(dir, process.pid, key, id);

      reapStaleClustersIn(root, now, STALE_CLUSTER_MS);

      expect(segmentExists(id)).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });

    // PostgreSQL's System V segment holds only its 56-byte PGShmemHeader.
    describe('segments no cluster dir records any more', () => {
      it.skipIf(!canCreate)('releases an unattached PostgreSQL-sized segment whose creator is dead', () => {
        const id = createSegment(syntheticKey(), 56); // perl has exited: creator dead

        expect(releaseOrphanedPostgresSegments()).toBeGreaterThanOrEqual(1);
        expect(segmentExists(id)).toBe(false);
      });

      it.skipIf(!canCreate)('never removes a segment whose creator is still running', async () => {
        const key = Number(BigInt.asIntN(32, BigInt(syntheticKey())));
        const id = Number(await holdWith(`my $id = shmget(${key}, 56, IPC_CREAT | IPC_EXCL | 0600); defined $id or die; print "$id\\n"`));
        created.add(id);

        releaseOrphanedPostgresSegments();
        expect(segmentExists(id)).toBe(true);
      });

      it.skipIf(!canCreate)('never removes a segment a backend is still attached to', async () => {
        const id = createSegment(syntheticKey(), 56); // creator dead, like a killed postmaster
        await holdWith(`defined shmat(${id}, undef, 0) or die "shmat: $!"; print "attached\\n"`);

        releaseOrphanedPostgresSegments();
        expect(segmentExists(id)).toBe(true);
      });

      it.skipIf(!canCreate)('never removes a segment that is not PostgreSQL-sized', () => {
        const id = createSegment(syntheticKey(), 64);

        releaseOrphanedPostgresSegments();
        expect(segmentExists(id)).toBe(true);
      });
    });
  });
});
