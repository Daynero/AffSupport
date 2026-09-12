import { describe, expect, it } from 'vitest';
import { createLeaseBook } from '../scripts/lib/release/leases.mjs';
import { createResourceAdmission } from '../scripts/lib/release/resources.mjs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLeaseServer } from '../scripts/lib/release/lease-server.mjs';
import { requestLease } from '../scripts/release-admit.mjs';
import { execute } from '../scripts/lib/release/execute.mjs';
import { closeSync, existsSync, openSync, writeFileSync } from 'node:fs';
import { runGate } from '../scripts/lib/gate.mjs';

describe('nested resource lease', () => {
  it('serializes independent runs and lets one child inherit its parent lease', () => {
    const leases = createLeaseBook();
    const outer = leases.request({ runId: 'one' });
    expect(leases.request({ runId: 'two' })).toMatchObject({ ok: false });
    expect(
      leases.request({ runId: 'one', parentLeaseId: outer.leaseId, childId: 'build' })
    ).toMatchObject({ ok: true, inherited: true });
    expect(
      leases.request({ runId: 'one', parentLeaseId: outer.leaseId, childId: 'test' })
    ).toMatchObject({ ok: false });
    expect(leases.release({ leaseId: outer.leaseId, childId: 'build' })).toBe(true);
    expect(leases.release({ leaseId: outer.leaseId })).toBe(true);
  });
  it('does not admit heavy work until a complete stable machine window exists', () => {
    const profile = {
      sampleIntervalMs: 5000,
      stableWindowMs: 30000,
      maxCpuPercent: 50,
      ramReserveBytes: 1,
      diskReserveBytes: 1,
      maxSwapGrowthBytes: 1
    };
    const admission = createResourceAdmission(profile, createLeaseBook());
    for (let index = 0; index < 7; index++)
      admission.sample({
        observedAt: new Date(index * 5000).toISOString(),
        cpuPercent: 10,
        availableBytes: 10,
        pressure: 'normal',
        swapGrowthBytes: 0,
        diskFreeBytes: 10,
        thermal: 'nominal',
        bootId: 'x'
      });
    expect(admission.request({ runId: 'one' })).toMatchObject({ ok: true });
  });
});

describe('lease IPC', () => {
  it('rejects forged or stale requests, serializes siblings, and fails closed after worker death', async () => {
    const root = await mkdtemp(join(tmpdir(), 'soty-lease-'));
    const child = { pid: 12, startedAt: 34 };
    const server = await startLeaseServer({
      socketPath: join(root, 'admit.sock'),
      capability: 'cap',
      generation: 4,
      children: new Map([['worker', child]])
    });
    const base = {
      version: 1,
      runId: 'run',
      generation: 4,
      childIdentity: 'worker',
      ...child,
      stepId: 'build'
    };
    await expect(
      requestLease(
        server.socketPath,
        { ...base, requestId: 'forged', operation: 'request' },
        'wrong'
      )
    ).resolves.toMatchObject({ code: 'LEASE_CAPABILITY_INVALID' });
    await expect(
      requestLease(
        server.socketPath,
        { ...base, requestId: 'stale', generation: 3, operation: 'request' },
        'cap'
      )
    ).resolves.toMatchObject({ code: 'LEASE_GENERATION_STALE' });
    const outer = await requestLease(
      server.socketPath,
      { ...base, requestId: 'outer', operation: 'request' },
      'cap'
    );
    expect(outer).toMatchObject({ kind: 'granted', generation: 4 });
    const nested = await requestLease(
      server.socketPath,
      { ...base, requestId: 'nested', parentLeaseId: outer.leaseId, operation: 'request' },
      'cap'
    );
    expect(nested).toMatchObject({ kind: 'granted' });
    await expect(
      requestLease(
        server.socketPath,
        { ...base, requestId: 'sibling', parentLeaseId: outer.leaseId, operation: 'request' },
        'cap'
      )
    ).resolves.toMatchObject({ kind: 'waiting' });
    await expect(
      requestLease(
        server.socketPath,
        { ...base, requestId: 'child-release', leaseId: outer.leaseId, operation: 'release' },
        'cap'
      )
    ).resolves.toMatchObject({ kind: 'released' });
    await server.close();
    await expect(
      requestLease(
        join(root, 'admit.sock'),
        { ...base, requestId: 'dead', operation: 'request' },
        'cap'
      )
    ).rejects.toThrow('LEASE_SOCKET_UNAVAILABLE');
  });
});

it('does not spawn a managed child if admission has not granted a lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'soty-admit-spawn-'));
  const output = join(root, 'should-not-exist');
  const result = await execute(
    [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(output)}, 'bad')`],
    {
      cwd: process.cwd(),
      admission: { request: async () => ({ ok: false, reason: 'RESOURCE_WAIT' }) }
    }
  );
  expect(result).toMatchObject({ ok: false, code: 'RESOURCE_WAIT', identity: null });
  expect(existsSync(output)).toBe(false);
});

describe('verification gates under release admission', () => {
  /** Points SOTY_RELEASE_CAPABILITY_FD at a real descriptor, as the worker does. */
  function capabilityDescriptor(root: string, capability: string) {
    const file = join(root, 'capability');
    writeFileSync(file, capability);
    return openSync(file, 'r');
  }

  it('waits for the host-wide slot before running a gate and frees it afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'soty-gate-admit-'));
    const child = { pid: process.pid, startedAt: 1 };
    const server = await startLeaseServer({
      socketPath: join(root, 'admit.sock'),
      capability: 'cap',
      generation: 1,
      children: new Map([['verify', child]])
    });
    const fd = capabilityDescriptor(root, 'cap');
    const marker = join(root, 'gate-ran');
    const previous = { ...process.env };
    Object.assign(process.env, {
      SOTY_RELEASE_ADMIT_SOCKET: server.socketPath,
      SOTY_RELEASE_CAPABILITY_FD: String(fd),
      SOTY_RELEASE_RUN_ID: 'run',
      SOTY_RELEASE_GENERATION: '1',
      SOTY_RELEASE_CHILD_IDENTITY: 'verify',
      SOTY_RELEASE_CHILD_STARTED_AT: '1'
    });
    try {
      // Somebody else already holds the one heavy slot.
      const holder = await requestLease(
        server.socketPath,
        {
          version: 1,
          requestId: 'holder',
          operation: 'request',
          runId: 'other',
          generation: 1,
          childIdentity: 'verify',
          ...child,
          stepId: 'other'
        },
        'cap'
      );
      expect(holder).toMatchObject({ kind: 'granted' });

      const running = runGate({
        id: 'typecheck',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        timeoutMs: 30_000
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(existsSync(marker)).toBe(false);

      await requestLease(
        server.socketPath,
        {
          version: 1,
          requestId: 'holder-release',
          operation: 'release',
          leaseId: holder.leaseId,
          runId: 'other',
          generation: 1,
          childIdentity: 'verify',
          ...child,
          stepId: 'other'
        },
        'cap'
      );
      expect(await running).toMatchObject({ id: 'typecheck', ok: true });
      expect(existsSync(marker)).toBe(true);

      // The gate released what it took: the next caller is admitted at once.
      await expect(
        requestLease(
          server.socketPath,
          {
            version: 1,
            requestId: 'after',
            operation: 'request',
            runId: 'next',
            generation: 1,
            childIdentity: 'verify',
            ...child,
            stepId: 'next'
          },
          'cap'
        )
      ).resolves.toMatchObject({ kind: 'granted' });
    } finally {
      closeSync(fd);
      for (const key of Object.keys(process.env))
        if (key.startsWith('SOTY_RELEASE_')) delete process.env[key];
      Object.assign(process.env, previous);
      await server.close();
    }
    // The waiting gate polls on the server's own nextCheckAt cadence (5 s).
  }, 20_000);

  it('fails a gate closed when admission is configured but incomplete', async () => {
    const previous = process.env.SOTY_RELEASE_ADMIT_SOCKET;
    process.env.SOTY_RELEASE_ADMIT_SOCKET = '/nonexistent.sock';
    try {
      const result = await runGate({
        id: 'typecheck',
        command: process.execPath,
        args: ['-e', ''],
        timeoutMs: 5_000
      });
      expect(result.ok).toBe(false);
      expect(result.subject).toContain('RELEASE_ADMISSION_INCOMPLETE');
    } finally {
      if (previous === undefined) delete process.env.SOTY_RELEASE_ADMIT_SOCKET;
      else process.env.SOTY_RELEASE_ADMIT_SOCKET = previous;
    }
  });
});
