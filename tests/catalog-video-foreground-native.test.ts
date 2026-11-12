import { expect, it, vi } from 'vitest';
import { CatalogVideoForegroundController } from '../apps/agent/src/team-bridge/catalog-video-foreground';
import { runCatalogVariantRecovery } from '../apps/agent/src/team-bridge/catalog-variant-recovery';
const id = (n: number) => '47000000-0000-4000-8000-' + String(n).padStart(12, '0');
const binding = {
  protocolVersion: 1,
  teamId: id(1),
  sourceMaterialId: id(2),
  requestKey: 'product-catalog:' + id(3)
};
function fixture() {
  let saved: unknown = null;
  const run = vi.fn(async () => {});
  const redeem = vi.fn(async (body: Record<string, unknown>) => ({
    ...body,
    executorId: body.enrollmentId,
    executionNativeInstanceId: body.executionNativeInstanceId,
    actorId: id(4),
    teamId: binding.teamId,
    sourceMaterialId: binding.sourceMaterialId,
    requestKey: binding.requestKey,
    expectedVersion: null,
    ticket: 't'.repeat(43)
  }));
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: {
      read: async () => saved,
      write: async value => {
        saved = structuredClone(value);
      }
    },
    redeem,
    run
  });
  return { controller, run, redeem, saved: () => saved };
}
it('prepares stable original intent proof and never exposes its private secret', async () => {
  const f = fixture();
  const receipt = await f.controller.prepare(binding);
  expect(await f.controller.prepare({ ...binding })).toEqual(receipt);
  expect(receipt).not.toHaveProperty('secret');
  expect(receipt.proofDigest).toMatch(/^[a-f0-9]{64}$/u);
  await expect(f.controller.prepare({ ...binding, sourceMaterialId: id(6) })).rejects.toThrow(
    'REQUEST_REUSE_CONFLICT'
  );
  expect(f.redeem).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it('concurrent attach redeems and starts only the original accepted set once', async () => {
  const f = fixture(),
    receipt = await f.controller.prepare(binding);
  const attach = {
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  };
  await Promise.all([f.controller.attach(attach), f.controller.attach(attach)]);
  expect(f.redeem).toHaveBeenCalledTimes(1);
  expect(f.run).toHaveBeenCalledTimes(1);
  await expect(f.controller.attach({ ...attach, setId: id(8) })).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  await f.controller.shutdown();
});
it('rejects a redeemed actor mismatch before any native execution', async () => {
  const f = fixture(),
    receipt = await f.controller.prepare(binding);
  f.redeem.mockImplementationOnce(async body => ({
    ...body,
    executorId: body.enrollmentId,
    executionNativeInstanceId: body.executionNativeInstanceId,
    actorId: id(9),
    teamId: binding.teamId,
    sourceMaterialId: binding.sourceMaterialId,
    requestKey: binding.requestKey,
    expectedVersion: null,
    ticket: 't'.repeat(43)
  }));
  await expect(
    f.controller.attach({
      protocolVersion: 1,
      teamId: binding.teamId,
      setId: id(7),
      enrollmentId: receipt.enrollmentId,
      nativeInstanceId: receipt.nativeInstanceId
    })
  ).rejects.toThrow('INVALID_RESPONSE');
  expect(f.run).not.toHaveBeenCalled();
});
it('exact foreground set never invokes a global background claim', async () => {
  const call = vi.fn(async (action: string) => {
    if (action !== 'variant_load') throw new Error('unexpected');
    return {
      setId: id(7),
      revision: 0,
      children: [
        { index: 0, requestId: id(8), operationId: id(9), state: 'registered', outputId: id(10) }
      ]
    };
  });
  await runCatalogVariantRecovery({
    initialSetId: id(7),
    nativeInstanceId: id(5),
    call,
    signal: new AbortController().signal,
    process: { process: vi.fn(), cancel: vi.fn() }
  });
  expect(call.mock.calls.every(([action]) => action !== 'variant_claim')).toBe(true);
});
it('drains foreground work on actor retirement with original closure cause', async () => {
  let actor: string | null = id(4);
  let finished = false;
  const f = fixture();
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => actor,
    allowed: () => true,
    vault: { read: async () => null, write: async () => {} },
    redeem: f.redeem,
    run: async (_set, _ticket, _enrollment, signal) => {
      await new Promise<void>(resolve => {
        signal.addEventListener(
          'abort',
          () => {
            expect(signal.reason.message).toBe('PERMISSION_DENIED');
            finished = true;
            resolve();
          },
          { once: true }
        );
      });
    }
  });
  const receipt = await controller.prepare(binding);
  await controller.attach({
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  });
  actor = null;
  await controller.prepareActorChange(null);
  expect(finished).toBe(true);
  expect(controller.busy()).toBe(false);
});
it('lost redeem ACK retains same proof and exact set for retry', async () => {
  const f = fixture(),
    receipt = await f.controller.prepare(binding);
  f.redeem.mockRejectedValueOnce(new Error('PROCESS_RESULT_UNCERTAIN'));
  const attach = {
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  };
  await expect(f.controller.attach(attach)).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  await expect(f.controller.attach({ ...attach, setId: id(8) })).rejects.toThrow(
    'PERMISSION_DENIED'
  );
  await f.controller.attach(attach);
  expect(f.redeem.mock.calls[0]?.[0]).toEqual(f.redeem.mock.calls[1]?.[0]);
  expect(f.run).toHaveBeenCalledTimes(1);
  await f.controller.shutdown();
});
it('damaged encrypted payload never silently creates another authority', async () => {
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: {
      read: async () => [
        {
          binding,
          actorId: id(4),
          secret: 's'.repeat(43),
          receipt: {
            protocolVersion: 1,
            enrollmentId: id(6),
            nativeInstanceId: id(5),
            proofDigest: '0'.repeat(64)
          },
          state: 'prepared'
        }
      ],
      write: vi.fn()
    },
    redeem: vi.fn(),
    run: vi.fn()
  });
  await expect(controller.load()).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  await expect(controller.prepare(binding)).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
});
it('preserves strict foreground executor evidence in launch progress', async () => {
  const { parseCatalogVideoRowProgress } =
    await import('../packages/shared/src/team/catalog-video-progress');
  const row = {
    setId: id(7),
    requestedCount: 5,
    registeredCount: 3,
    state: 'preparing',
    executor: { mode: 'paired_session', enrollmentId: id(6), nativeInstanceId: id(5) }
  };
  expect(parseCatalogVideoRowProgress(row)?.executor).toEqual(row.executor);
  expect(
    parseCatalogVideoRowProgress({ ...row, executor: { ...row.executor, enrollmentId: 'invalid' } })
  ).toBeNull();
});
it('reuses original proof after restart and requests only fenced execution boot recovery', async () => {
  const original = fixture();
  const receipt = await original.controller.prepare(binding);
  const redeem = vi.fn(async (body: Record<string, unknown>) => ({
    ...body,
    executorId: body.enrollmentId,
    actorId: id(4),
    teamId: binding.teamId,
    sourceMaterialId: binding.sourceMaterialId,
    requestKey: binding.requestKey,
    expectedVersion: null,
    ticket: 't'.repeat(43)
  }));
  const run = vi.fn(async () => {});
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(12),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: { read: async () => original.saved(), write: async () => {} },
    redeem,
    run
  });
  await controller.load();
  expect(await controller.prepare(binding)).toEqual(receipt);
  await controller.attach({
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  });
  expect(redeem.mock.calls[0]?.[0]).toMatchObject({
    nativeInstanceId: id(5),
    executionNativeInstanceId: id(12)
  });
  expect(run).toHaveBeenCalledWith(
    id(7),
    't'.repeat(43),
    receipt.enrollmentId,
    expect.any(AbortSignal),
    id(12)
  );
  await controller.shutdown();
});
it('refuses restart takeover when authoritative original child remains unknown', async () => {
  const original = fixture();
  const receipt = await original.controller.prepare(binding);
  const run = vi.fn();
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(12),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: { read: async () => original.saved(), write: async () => {} },
    redeem: async () => {
      throw new Error('PROCESS_RESULT_UNCERTAIN');
    },
    run
  });
  await controller.load();
  await expect(
    controller.attach({
      protocolVersion: 1,
      teamId: binding.teamId,
      setId: id(7),
      enrollmentId: receipt.enrollmentId,
      nativeInstanceId: receipt.nativeInstanceId
    })
  ).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  expect(run).not.toHaveBeenCalled();
  expect(await controller.prepare(binding)).toEqual(receipt);
});
it('continues an accepted intent after browser closes without attach or global claim', async () => {
  const run = vi.fn(async () => {});
  let bind: (value: Record<string, unknown>) => void = () => {};
  const pending = new Promise<Record<string, unknown>>(resolve => {
    bind = resolve;
  });
  let request: Record<string, unknown> = {};
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: { read: async () => null, write: async () => {} },
    awaitBinding: async body => {
      request = body;
      return pending;
    },
    redeem: vi.fn(),
    run
  });
  const receipt = await controller.prepare(binding);
  expect(run).not.toHaveBeenCalled();
  bind({
    state: 'bound',
    protocolVersion: 1,
    setId: id(7),
    executorId: receipt.enrollmentId,
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: id(5),
    executionNativeInstanceId: id(5),
    actorId: id(4),
    teamId: binding.teamId,
    sourceMaterialId: binding.sourceMaterialId,
    requestKey: binding.requestKey,
    expectedVersion: null,
    ticket: 't'.repeat(43)
  });
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(request).not.toHaveProperty('setId');
  expect(request).toHaveProperty('proofSecret');
  await controller.shutdown();
});
it('aborts metadata waiting and rejects a late bound grant after logout', async () => {
  let actor: string | null = id(4);
  let finish: (value: Record<string, unknown>) => void = () => {};
  let observed = false;
  const run = vi.fn();
  const pending = new Promise<Record<string, unknown>>(resolve => {
    finish = resolve;
  });
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => actor,
    allowed: () => true,
    vault: { read: async () => null, write: async () => {} },
    awaitBinding: async (_body, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          observed = true;
          finish({ state: 'bound', setId: id(7) });
        },
        { once: true }
      );
      return pending;
    },
    redeem: vi.fn(),
    run
  });
  await controller.prepare(binding);
  actor = null;
  await controller.prepareActorChange(null);
  expect(observed).toBe(true);
  expect(run).not.toHaveBeenCalled();
});
it('backs off transient await failure and never starts before the original set binds', async () => {
  try {
    const awaitBinding = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP_503'))
      .mockResolvedValue({ state: 'pending' });
    const run = vi.fn();
    const controller = new CatalogVideoForegroundController({
      nativeInstanceId: id(5),
      currentActorId: () => id(4),
      allowed: () => true,
      vault: { read: async () => null, write: async () => {} },
      awaitBinding: async (body, signal) => {
        const value = await awaitBinding(body, signal);
        return { ...value, enrollmentId: body.enrollmentId };
      },
      redeem: vi.fn(),
      run
    });
    await controller.prepare(binding);
    await Promise.resolve();
    expect(awaitBinding).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(awaitBinding).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(awaitBinding).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
    await controller.shutdown();
  } finally {
    // Real timers exercise the native timers/promises abort seam.
  }
});
it.each(['ready', 'unused'] as const)(
  'admits a 129th intent by evicting only proven %s authority',
  async terminal => {
    const { createHash } = await import('node:crypto');
    const secret = 's'.repeat(43);
    const rows = Array.from({ length: 128 }, (_, index) => ({
      binding: { ...binding, requestKey: id(index + 100) },
      actorId: id(4),
      secret,
      receipt: {
        protocolVersion: 1,
        enrollmentId: id(index + 300),
        nativeInstanceId: id(5),
        proofDigest: createHash('sha256')
          .update('soty:catalog-video-foreground-proof:v1:' + secret)
          .digest('hex')
      },
      state: index === 0 ? terminal : 'unknown',
      createdAt: 1,
      readyAt: index === 0 ? 2 : undefined
    }));
    let saved: unknown = null;
    const controller = new CatalogVideoForegroundController({
      nativeInstanceId: id(5),
      currentActorId: () => id(4),
      allowed: () => true,
      vault: {
        read: async () => rows,
        write: async value => {
          saved = value;
        }
      },
      redeem: vi.fn(),
      run: vi.fn()
    });
    await controller.load();
    await expect(controller.prepare(binding)).resolves.toHaveProperty('proofDigest');
    expect(saved).toHaveLength(128);
    await expect(controller.prepare({ ...binding, requestKey: id(999) })).rejects.toThrow(
      'PROCESS_RESULT_UNCERTAIN'
    );
  }
);
it('does not schedule CPU when actor retirement races ticket persistence', async () => {
  let actor: string | null = id(4),
    writes = 0;
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  const reached = new Promise<void>(resolve => {
    entered = resolve;
  });
  const f = fixture();
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => actor,
    allowed: () => true,
    vault: {
      read: async () => null,
      write: async () => {
        writes++;
        if (writes === 3) {
          entered();
          await blocked;
        }
      }
    },
    redeem: f.redeem,
    run: f.run
  });
  const receipt = await controller.prepare(binding);
  const attach = controller.attach({
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  });
  await reached;
  actor = null;
  await controller.prepareActorChange(null);
  release();
  await expect(attach).rejects.toThrow('PERMISSION_DENIED');
  expect(f.run).not.toHaveBeenCalled();
});
it('retires only a server-proven unused enrollment and never redeems or renders it', async () => {
  const f = fixture();
  let saved: unknown = null;
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: {
      read: async () => null,
      write: async value => {
        saved = structuredClone(value);
      }
    },
    awaitBinding: async body => ({ state: 'unused', enrollmentId: body.enrollmentId }),
    redeem: f.redeem,
    run: f.run
  });
  const receipt = await controller.prepare(binding);
  await vi.waitFor(() => expect((saved as Array<{ state: string }>)[0]?.state).toBe('unused'));
  await expect(
    controller.attach({
      protocolVersion: 1,
      teamId: binding.teamId,
      setId: id(7),
      enrollmentId: receipt.enrollmentId,
      nativeInstanceId: receipt.nativeInstanceId
    })
  ).rejects.toThrow('WRONG_STATE');
  expect(f.run).not.toHaveBeenCalled();
  expect(f.redeem).not.toHaveBeenCalled();
  await controller.shutdown();
});
it('refreshes a lost handover ACK only through exact-proof metadata before a new boot CAS', async () => {
  const original = fixture();
  const receipt = await original.controller.prepare(binding);
  const run = vi.fn(async () => {});
  const grant = (body: Record<string, unknown>, effective: string) => ({
    ...body,
    state: 'bound',
    executorId: body.enrollmentId,
    actorId: id(4),
    teamId: binding.teamId,
    sourceMaterialId: binding.sourceMaterialId,
    requestKey: binding.requestKey,
    expectedVersion: null,
    ticket: 't'.repeat(43),
    executionNativeInstanceId: effective
  });
  const redeem = vi
    .fn(async (body: Record<string, unknown>) => grant(body, id(12)))
    .mockRejectedValueOnce(new Error('REQUEST_REUSE_CONFLICT'))
    .mockImplementationOnce(async body => grant(body, id(11)));
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(12),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: { read: async () => original.saved(), write: async () => {} },
    redeem,
    run
  });
  await controller.load();
  await controller.attach({
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  });
  expect(redeem.mock.calls[0]?.[0]).toMatchObject({
    expectedExecutionNativeInstanceId: id(5),
    executionNativeInstanceId: id(12)
  });
  expect(redeem.mock.calls[1]?.[0].executionNativeInstanceId).toBeUndefined();
  expect(redeem.mock.calls[2]?.[0]).toMatchObject({
    expectedExecutionNativeInstanceId: id(11),
    executionNativeInstanceId: id(12)
  });
  expect(run).toHaveBeenCalledTimes(1);
  await controller.shutdown();
});
it('decodes actual Edge envelopes and preserves handover conflict codes', async () => {
  const { callCatalogVideoForegroundHttp } =
    await import('../apps/agent/src/team-bridge/catalog-video-foreground-http');
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, value: { state: 'pending', enrollmentId: id(6) } }), {
        headers: { 'content-type': 'application/json' }
      })
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: false, error: { code: 'REQUEST_REUSE_CONFLICT', retryable: false } }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    );
  await expect(
    callCatalogVideoForegroundHttp(
      'http://127.0.0.1:54321',
      'await',
      {},
      undefined,
      undefined,
      fetchImpl
    )
  ).resolves.toEqual({ state: 'pending', enrollmentId: id(6) });
  await expect(
    callCatalogVideoForegroundHttp(
      'http://127.0.0.1:54321',
      'await',
      {},
      undefined,
      undefined,
      fetchImpl
    )
  ).rejects.toThrow('REQUEST_REUSE_CONFLICT');
});
it('accepts a complete 400-output Edge snapshot while rejecting oversized responses', async () => {
  const { callCatalogVideoForegroundHttp, CATALOG_FOREGROUND_RESPONSE_BYTES } =
    await import('../apps/agent/src/team-bridge/catalog-video-foreground-http');
  const snapshot = {
    setId: id(7),
    revision: 401,
    children: Array.from({ length: 400 }, (_, index) => ({
      index,
      requestId: id(index + 1000),
      operationId: id(index + 2000),
      state: 'registered',
      outputId: id(index + 3000)
    }))
  };
  const serialized = JSON.stringify({ ok: true, value: snapshot });
  expect(Buffer.byteLength(serialized)).toBeGreaterThan(65536);
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(serialized, { headers: { 'content-type': 'application/json' } })
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          value: { oversize: 'x'.repeat(CATALOG_FOREGROUND_RESPONSE_BYTES) }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );
  await expect(
    callCatalogVideoForegroundHttp(
      'http://127.0.0.1:54321',
      'load',
      {},
      't'.repeat(43),
      undefined,
      fetchImpl
    )
  ).resolves.toEqual(snapshot);
  await expect(
    callCatalogVideoForegroundHttp(
      'http://127.0.0.1:54321',
      'load',
      {},
      't'.repeat(43),
      undefined,
      fetchImpl
    )
  ).rejects.toThrow('INVALID_RESPONSE');
});

it('uses the actual platform credential account contract for foreground vault startup', async () => {
  const { isRecoveryCredentialAccount, recoveryCredential } =
    await import('../apps/agent/src/platform/platform');
  const { CATALOG_FOREGROUND_VAULT_ACCOUNT } =
    await import('../apps/agent/src/team-bridge/catalog-video-foreground');
  expect(isRecoveryCredentialAccount(CATALOG_FOREGROUND_VAULT_ACCOUNT)).toBe(true);
  expect(isRecoveryCredentialAccount('soty-beta-catalog-foreground')).toBe(false);
  await expect(recoveryCredential('read', 'soty-beta-catalog-foreground')).rejects.toThrow(
    'INVALID_INPUT'
  );
});
it('reconciles an original canceled unknown set after restart without redeem, boot rotation or media execution', async () => {
  const f = fixture();
  const receipt = await f.controller.prepare(binding);
  const persisted = f.saved() as Array<Record<string, unknown>>;
  persisted[0] = {
    ...persisted[0],
    setId: id(7),
    ticket: 't'.repeat(43),
    executionNativeInstanceId: id(5),
    state: 'unknown'
  };
  let saved: unknown = persisted;
  const reconcileCanceled = vi.fn(async () => true),
    awaitBinding = vi.fn();
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(12),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: {
      read: async () => persisted,
      write: async value => {
        saved = structuredClone(value);
      }
    },
    redeem: f.redeem,
    awaitBinding,
    reconcileCanceled,
    run: f.run
  });
  await controller.load();
  await vi.waitFor(() => expect((saved as Array<{ state: string }>)[0]?.state).toBe('canceled'));
  expect(reconcileCanceled).toHaveBeenCalledWith(
    id(7),
    't'.repeat(43),
    receipt.enrollmentId,
    id(5)
  );
  expect(f.redeem).not.toHaveBeenCalled();
  expect(awaitBinding).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  await controller.shutdown();
});

it('preserves a waiting foreground intent while update admission is held', async () => {
  const f = fixture();
  const receipt = await f.controller.prepare(binding);
  const attach = {
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  };
  const resume = f.controller.pauseForUpdate();
  await expect(f.controller.attach(attach)).rejects.toThrow('UPDATE_PENDING');
  expect(f.redeem).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
  await f.controller.flushForUpdate();
  resume();
  await f.controller.attach(attach);
  expect(f.run).toHaveBeenCalledOnce();
  await f.controller.shutdown();
});

it('does not abort already accepted foreground work when an update begins draining', async () => {
  const f = fixture();
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => id(4),
    allowed: () => true,
    vault: { read: async () => null, write: async () => {} },
    redeem: f.redeem,
    run: async (_set, _ticket, _enrollment, abort) => {
      signal = abort;
      await new Promise<void>(resolve => {
        finish = resolve;
      });
    }
  });
  const receipt = await controller.prepare(binding);
  await controller.attach({
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  });
  const resume = controller.pauseForUpdate();
  expect(signal?.aborted).toBe(false);
  expect(controller.busy()).toBe(true);
  finish();
  await controller.flushForUpdate();
  expect(signal?.aborted).toBe(false);
  resume();
  await controller.shutdown();
});

it('stays busy until the terminal foreground vault write is durable', async () => {
  const f = fixture();
  let finish!: () => void, releaseWrite!: () => void, writeStarted!: () => void;
  const waitingForWrite = new Promise<void>(resolve => {
    writeStarted = resolve;
  });
  const persisted = new Promise<void>(resolve => {
    releaseWrite = resolve;
  });
  let blocked = false;
  const controller = new CatalogVideoForegroundController({
    nativeInstanceId: id(5),
    currentActorId: () => id(4),
    allowed: () => true,
    redeem: f.redeem,
    vault: {
      read: async () => null,
      write: async value => {
        if (!blocked && Array.isArray(value) && value.some(entry => entry.state === 'ready')) {
          blocked = true;
          writeStarted();
          await persisted;
        }
      }
    },
    run: async () => {
      await new Promise<void>(resolve => {
        finish = resolve;
      });
    }
  });
  const receipt = await controller.prepare(binding);
  await controller.attach({
    protocolVersion: 1,
    teamId: binding.teamId,
    setId: id(7),
    enrollmentId: receipt.enrollmentId,
    nativeInstanceId: receipt.nativeInstanceId
  });
  const resume = controller.pauseForUpdate();
  finish();
  await waitingForWrite;
  expect(controller.busy()).toBe(true);
  const flushed = controller.flushForUpdate();
  releaseWrite();
  await flushed;
  expect(controller.busy()).toBe(false);
  resume();
  await controller.shutdown();
});
