import { diagnostics } from '../apps/agent/src/server/diagnostics-log';
import { ScreenCacheError } from '../apps/agent/src/team-bridge/screen-cache';
import { expect, it, vi } from 'vitest';
import { NativeRestitchController } from '../apps/agent/src/team-bridge/native-restitch-controller';
const id = (n: number) => 'b1860000-0000-4000-8000-' + String(n).padStart(12, '0');
const actor = id(1),
  team = id(2),
  root = id(3),
  endpoint = 'http://127.0.0.1:54321/functions/v1/drive-ops';
function setup() {
  let vault: unknown = null;
  const calls: string[] = [],
    store = {
      read: vi.fn(async () => structuredClone(vault)),
      write: vi.fn(async (value: unknown) => {
        vault = structuredClone(value);
      })
    };
  const registration = () => {
    const value = vault as { records: Array<{ enrollmentId: string; nativeInstanceId: string }> };
    return value.records[0]!;
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input)),
      action = url.pathname.split('/').at(-1)!;
    calls.push(action);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const r = registration();
    let value: unknown = true;
    if (action === 'redeem')
      value = {
        grantId: r.enrollmentId,
        enrollmentId: r.enrollmentId,
        rootOperationId: root,
        teamId: team,
        actorId: actor,
        nativeInstanceId: r.nativeInstanceId,
        redeemed: true,
        expiresAt: '2030-01-01T00:00:00Z',
        purpose: 'restitch_native_control_v1',
        protocolVersion: 1,
        ticket: 't'.repeat(43)
      };
    if (action === 'claim')
      value = {
        rootOperationId: root,
        claimId: body.claimId,
        nativeInstanceId: r.nativeInstanceId,
        executorId: id(4),
        epoch: 1,
        active: true
      };
    if (action === 'context')
      value = {
        selectionProtocol: 1,
        rootOperationId: root,
        teamId: team,
        actorId: actor,
        poolNamespaceId: id(5),
        executorId: id(4),
        epoch: 1,
        nativeInstanceId: r.nativeInstanceId,
        defaults: {
          configured: true,
          sourceMode: 'drive',
          operation: 'restitch',
          startImageIds: [],
          endImageIds: [],
          startEnabled: false,
          endEnabled: true,
          fitMode: 'cover',
          finalDurationMode: 'custom',
          customFinalDurationSeconds: 3,
          updatedAt: '',
          updatedBy: null
        },
        source: {
          materialId: id(6),
          version: '1',
          checksum: 'a'.repeat(32),
          sizeBytes: 4,
          mimeType: 'video/mp4'
        }
      };
    return new Response(JSON.stringify({ ok: true, value }), {
      headers: { 'content-type': 'application/json' }
    });
  });
  const journal = { load: vi.fn(async () => []), save: vi.fn(async () => {}) };
  return { store, fetcher, journal, calls, registration };
}
const request = () => ({
  operationId: id(7),
  transferUrl: 'http://127.0.0.1:54321/functions/v1/drive-transfer/range',
  transferGrant: {
    ticket: 'd'.repeat(43),
    purpose: 'download_range' as const,
    expiresAt: '2030-01-01T00:00:00Z',
    maxRangeBytes: 2097152,
    maxUses: 1
  },
  fileName: 'fixture.mp4'
});
it('persists its original enrollment proof before returning only the browser-safe digest, then redeems privately', async () => {
  const f = setup(),
    controller = new NativeRestitchController({
      endpoint,
      environment: 'beta',
      currentActorId: () => actor,
      vault: f.store,
      journal: f.journal,
      cache: {} as never,
      fetch: f.fetcher,
      run: vi.fn()
    });
  const prepared = await controller.prepare({ rootOperationId: root, teamId: team });
  expect(f.store.write).toHaveBeenCalledTimes(1);
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(prepared).toMatchObject({
    rootOperationId: root,
    actorId: actor,
    teamId: team,
    proofDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
  });
  expect(JSON.stringify(prepared)).not.toMatch(/proofSecret|ticket/u);
  await controller.redeem(prepared.enrollmentId);
  expect(f.calls).toEqual(['redeem']);
  const headers = new Headers(f.fetcher.mock.calls[0]![1]?.headers);
  expect(headers.get('x-restitch-enrollment-secret')).toHaveLength(43);
  expect(headers.has('authorization')).toBe(false);
  expect(JSON.stringify(prepared)).not.toContain(headers.get('x-restitch-enrollment-secret'));
  await controller.shutdown();
});
it('keeps ownership through the original run and cleanup before quiescence and logical completion', async () => {
  const f = setup();
  let complete!: () => void;
  const cleanup = new Promise<void>(resolve => {
    complete = resolve;
  });
  const run = vi.fn(async () => {
    await cleanup;
    return {
      saved: true as const,
      fileName: 'result.mp4',
      sizeBytes: 4,
      destination: '/synthetic'
    };
  });
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run
  });
  const p = await controller.prepare({ rootOperationId: root, teamId: team });
  await controller.redeem(p.enrollmentId);
  const result = controller.download(p.enrollmentId, request());
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(f.calls).toEqual(['redeem', 'claim', 'context']);
  complete();
  expect(await result).toMatchObject({ saved: true });
  expect(f.calls).toEqual(['redeem', 'claim', 'context', 'finish']);
  await controller.shutdown();
});
it('refuses a foreign actor before redeeming a stored enrollment', async () => {
  const f = setup();
  let current = actor;
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => current,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn()
  });
  const p = await controller.prepare({ rootOperationId: root, teamId: team });
  current = id(99);
  await expect(controller.redeem(p.enrollmentId)).rejects.toMatchObject({
    code: 'PERMISSION_DENIED'
  });
  expect(f.fetcher).not.toHaveBeenCalled();
  await controller.shutdown();
});
it('starts no enrollment request if platform secret persistence is unconfirmed', async () => {
  const f = setup();
  f.store.write.mockRejectedValueOnce(Error('PRIVATE_SECRET_PAYLOAD'));
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn()
  });
  await expect(controller.prepare({ rootOperationId: root, teamId: team })).rejects.toMatchObject({
    code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
  });
  expect(f.fetcher).not.toHaveBeenCalled();
  await controller.shutdown();
});

it('shares the original persisted proof for concurrent enrollment of the same root', async () => {
  const f = setup(),
    controller = new NativeRestitchController({
      endpoint,
      environment: 'beta',
      currentActorId: () => actor,
      vault: f.store,
      journal: f.journal,
      cache: {} as never,
      fetch: f.fetcher,
      run: vi.fn()
    });
  const [a, b] = await Promise.all([
    controller.prepare({ rootOperationId: root, teamId: team }),
    controller.prepare({ rootOperationId: root, teamId: team })
  ]);
  expect(a.enrollmentId).toBe(b.enrollmentId);
  expect(a.proofDigest).toBe(b.proofDigest);
  expect(f.store.write).toHaveBeenCalledTimes(1);
  await controller.shutdown();
});

it('journals a native failure under its cloud root with a closed cause and no private payload', async () => {
  const f = setup(),
    record = vi.spyOn(diagnostics, 'record').mockReturnValue(true);
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: async () => {
      throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
    }
  });
  try {
    const prepared = await controller.prepare({ rootOperationId: root, teamId: team });
    await controller.redeem(prepared.enrollmentId);
    await expect(controller.download(prepared.enrollmentId, request())).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_UNSUPPORTED'
    });
    expect(record).toHaveBeenCalledWith('team', 'process_terminal', {
      operationId: root,
      tool: 'restitch',
      stage: 'unknown',
      outcome: 'failed',
      errorCode: 'RESTITCH_SCREEN_UNSUPPORTED'
    });
    expect(JSON.stringify(record.mock.calls)).not.toMatch(
      /proofSecret|ticket|synthetic|127\.0\.0\.1/u
    );
  } finally {
    await controller.shutdown();
    record.mockRestore();
  }
});

it('retains the trusted delivery failure stage in the cloud-root journal', async () => {
  const f = setup(),
    record = vi.spyOn(diagnostics, 'record').mockReturnValue(true);
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: async ({ reportFailureStage }) => {
      reportFailureStage('processing');
      throw new ScreenCacheError('RESTITCH_SCREEN_UNSUPPORTED');
    }
  });
  try {
    const prepared = await controller.prepare({ rootOperationId: root, teamId: team });
    await controller.redeem(prepared.enrollmentId);
    await expect(controller.download(prepared.enrollmentId, request())).rejects.toMatchObject({
      code: 'RESTITCH_SCREEN_UNSUPPORTED'
    });
    expect(record).toHaveBeenCalledWith('team', 'process_terminal', {
      operationId: root,
      tool: 'restitch',
      stage: 'processing',
      outcome: 'failed',
      errorCode: 'RESTITCH_SCREEN_UNSUPPORTED'
    });
    expect(JSON.stringify(record.mock.calls)).not.toMatch(
      /proofSecret|ticket|synthetic|127\.0\.0\.1/u
    );
  } finally {
    await controller.shutdown();
    record.mockRestore();
  }
});

function heldVaultRead() {
  let release!: (value: unknown) => void;
  const wait = new Promise<unknown>(resolve => {
    release = resolve;
  });
  return { wait, release };
}
it('cancelAll joins pending preparation without returning a usable enrollment', async () => {
  const f = setup(),
    held = heldVaultRead();
  f.store.read.mockImplementation(() => held.wait);
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn()
  });
  const preparing = controller.prepare({ rootOperationId: root, teamId: team });
  const result = preparing.then(
    value => ({ value }),
    error => ({ error })
  );
  await vi.waitFor(() => expect(f.store.read).toHaveBeenCalledOnce());
  const stopping = controller.cancelAll();
  held.release(null);
  expect(await result).toMatchObject({ error: { code: 'PROCESS_CANCELED' } });
  expect(await stopping).toBe(1);
  expect(f.store.write).not.toHaveBeenCalled();
  expect(f.fetcher).not.toHaveBeenCalled();
  await controller.shutdown();
});
it('does not bind an old actor preparation to a replacement account after initialization', async () => {
  const f = setup(),
    held = heldVaultRead();
  let current = actor;
  f.store.read.mockImplementation(() => held.wait);
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => current,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn()
  });
  const result = controller.prepare({ rootOperationId: root, teamId: team }).then(
    value => ({ value }),
    error => ({ error })
  );
  await vi.waitFor(() => expect(f.store.read).toHaveBeenCalledOnce());
  current = id(99);
  held.release(null);
  expect(await result).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
  expect(f.store.write).not.toHaveBeenCalled();
  await controller.shutdown();
});

it.each([false, true])(
  'reads the original claim after a lost HTTP acknowledgement (canceled=%s)',
  async canceled => {
    const f = setup(),
      original = f.fetcher.getMockImplementation()!;
    let claimResponse: Response | undefined;
    const run = vi.fn(async () => ({
      saved: true as const,
      fileName: 'result.mp4',
      sizeBytes: 4,
      destination: '/synthetic'
    }));
    const controller = new NativeRestitchController({
      endpoint,
      environment: 'beta',
      currentActorId: () => actor,
      vault: f.store,
      journal: f.journal,
      cache: {} as never,
      fetch: f.fetcher,
      run
    });
    f.fetcher.mockImplementation(async (url, init) => {
      const action = new URL(String(url)).pathname.split('/').at(-1);
      if (action === 'read') return claimResponse!.clone();
      const response = await original(url, init);
      if (action === 'claim') {
        claimResponse = response;
        if (canceled) controller.cancelOperation(request().operationId);
        throw Error('LOST_CLAIM_HTTP_REPLY');
      }
      return response;
    });
    try {
      const prepared = await controller.prepare({ rootOperationId: root, teamId: team });
      await controller.redeem(prepared.enrollmentId);
      const result = controller.download(prepared.enrollmentId, request());
      if (canceled) await expect(result).rejects.toMatchObject({ code: 'PROCESS_CANCELED' });
      else await expect(result).resolves.toMatchObject({ saved: true });
      expect(run).toHaveBeenCalledTimes(canceled ? 0 : 1);
      const actions = f.fetcher.mock.calls.map(call =>
        new URL(String(call[0])).pathname.split('/').at(-1)
      );
      expect(actions.filter(action => action === 'claim')).toHaveLength(1);
      expect(actions.filter(action => action === 'read')).toHaveLength(1);
      expect(actions.filter(action => action === 'finish')).toHaveLength(1);
      const claim = f.fetcher.mock.calls.find(call => String(call[0]).endsWith('/claim'))!;
      const read = f.fetcher.mock.calls.find(call => String(call[0]).endsWith('/read'))!;
      expect(JSON.parse(String(read[1]?.body))).toEqual(JSON.parse(String(claim[1]?.body)));
    } finally {
      await controller.shutdown();
    }
  }
);
it('keeps process selection owned until original upload and registration resolve', async () => {
  const f = setup();
  let finish!: () => void;
  const registered = new Promise<void>(resolve => {
    finish = resolve;
  });
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn()
  });
  const enrollment = await controller.prepare({ rootOperationId: root, teamId: team }, 'process');
  await controller.redeem(enrollment.enrollmentId);
  const result = controller.process(enrollment.enrollmentId, root, async () => {
    await registered;
    return { operationId: root, state: 'succeeded', materialId: id(8), reused: false };
  });
  await vi.waitFor(() => expect(f.calls).toContain('context'));
  expect(f.calls).not.toContain('finish');
  finish();
  expect(await result).toMatchObject({ operationId: root, state: 'succeeded', materialId: id(8) });
  expect(f.calls).toContain('finish');
  await controller.shutdown();
});
it('drains the same process bridge before canonical cancellation and protected finish', async () => {
  const { settleCatalogVariantProcess } =
    await import('../apps/agent/src/team-bridge/catalog-variant-closure');
  const f = setup(),
    order: string[] = [];
  let terminal = false,
    started = false;
  const implementation = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/finish')) {
      expect(terminal).toBe(true);
      order.push('native_finish');
    }
    return implementation(input, init);
  });
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn()
  });
  const enrollment = await controller.prepare({ rootOperationId: root, teamId: team }, 'process');
  await controller.redeem(enrollment.enrollmentId);
  const result = controller.process(enrollment.enrollmentId, root, async ({ signal }) =>
    settleCatalogVariantProcess({
      operationId: root,
      signal,
      run: async () => {
        started = true;
        try {
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          );
          throw Error('unreachable');
        } finally {
          await Promise.resolve();
          order.push('bridge_drained');
        }
      },
      complete: async () => {
        expect(order).toEqual(['bridge_drained']);
        terminal = true;
        order.push('canonical_canceled');
        return { kind: 'terminal', state: 'canceled', operationId: root };
      }
    })
  );
  const rejected = expect(result).rejects.toThrow('PROCESS_CANCELED');
  await vi.waitFor(() => expect(started).toBe(true));
  controller.cancelOperation(root);
  await rejected;
  expect(order).toEqual(['bridge_drained', 'canonical_canceled', 'native_finish']);
  await controller.shutdown();
});
it('uncertain authority interruption is a failed unknown closure rather than a proved user cancellation', async () => {
  const f = setup(),
    record = vi.spyOn(diagnostics, 'record');
  let started = false;
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn()
  });
  const enrollment = await controller.prepare({ rootOperationId: root, teamId: team }, 'process');
  await controller.redeem(enrollment.enrollmentId);
  const result = controller.process(enrollment.enrollmentId, root, async ({ signal }) => {
    started = true;
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    );
    throw Error('unreachable');
  });
  const rejected = expect(result).rejects.toThrow();
  await vi.waitFor(() => expect(started).toBe(true));
  controller.cancelOperation(root, 'PROCESS_RESULT_UNCERTAIN');
  await rejected;
  expect(record).toHaveBeenCalledWith(
    'team',
    'process_terminal',
    expect.objectContaining({
      operationId: root,
      outcome: 'failed',
      errorCode: 'PROCESS_RESULT_UNCERTAIN'
    })
  );
  record.mockRestore();
  await controller.shutdown();
});
it('after restart finishes only the original drained canceled process using its saved claim and nonce after guarded canonical closure', async () => {
  const f = setup();
  let saved: import('../apps/agent/src/team-bridge/native-restitch-executor').NativeRestitchCheckpoint[] =
    [];
  let canonicalCanceled = false;
  const journal = {
    load: async () => saved,
    save: async (
      value: readonly import('../apps/agent/src/team-bridge/native-restitch-executor').NativeRestitchCheckpoint[]
    ) => {
      saved = structuredClone([...value]);
    }
  };
  const base = f.fetcher.getMockImplementation()!;
  const finishes: Array<Record<string, unknown>> = [];
  f.fetcher.mockImplementation(async (input, init) => {
    const action = new URL(String(input)).pathname.split('/').at(-1),
      body = JSON.parse(String(init?.body ?? '{}'));
    const r = f.registration();
    if (action === 'read')
      return new Response(
        JSON.stringify({
          ok: true,
          value: {
            rootOperationId: root,
            claimId: body.claimId,
            nativeInstanceId: r.nativeInstanceId,
            executorId: id(4),
            epoch: 1,
            active: true
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    if (action === 'finish') {
      finishes.push(body);
      return new Response(
        JSON.stringify(
          canonicalCanceled
            ? { ok: true, value: true }
            : { ok: false, error: { code: 'WRONG_STATE', retryable: false } }
        ),
        { status: canonicalCanceled ? 200 : 409, headers: { 'content-type': 'application/json' } }
      );
    }
    return base(input, init);
  });
  const options = {
    endpoint,
    environment: 'beta' as const,
    currentActorId: () => actor,
    vault: f.store,
    journal,
    cache: { resolveProtected: vi.fn(), refusedProtected: vi.fn() },
    fetch: f.fetcher,
    run: vi.fn()
  };
  const first = new NativeRestitchController({ ...options, nativeInstanceId: id(90) });
  const prepared = await first.prepare({ rootOperationId: root, teamId: team }, 'process');
  await first.redeem(prepared.enrollmentId);
  await expect(
    first.process(prepared.enrollmentId, root, async () => {
      throw Error('PROCESS_RESULT_UNCERTAIN');
    })
  ).rejects.toThrow();
  expect(saved[0]).toMatchObject({
    phase: 'blocked',
    reason: 'quiescence_unconfirmed',
    outcome: 'rejected'
  });
  const originalNonce = saved[0]!.quiescenceId;
  const claimCount = f.calls.filter(x => x === 'claim').length;
  const restarted = new NativeRestitchController({ ...options, nativeInstanceId: id(91) });
  const prove = vi.fn(async () => {
    canonicalCanceled = true;
    return true;
  });
  expect(await restarted.reconcileCatalogCancellation(root, prove)).toBe(true);
  expect(prove).toHaveBeenCalledTimes(1);
  expect(f.calls.filter(x => x === 'claim')).toHaveLength(claimCount);
  expect(finishes.at(-1)).toMatchObject({ quiescenceId: originalNonce, outcome: 'canceled' });
  expect(saved[0]).toMatchObject({
    phase: 'quiescent',
    outcome: 'rejected',
    quiescenceId: originalNonce
  });
});
it.each(['canceled', 'registered'] as const)(
  'uses canonical %s process outcome for original native finish before a heartbeat can fire',
  async outcome => {
    const f = setup(),
      base = f.fetcher.getMockImplementation()!,
      finishes: Array<Record<string, unknown>> = [];
    f.fetcher.mockImplementation(async (input, init) => {
      const action = new URL(String(input)).pathname.split('/').at(-1);
      if (action === 'finish') {
        const body = JSON.parse(String(init?.body));
        finishes.push(body);
        expect(body.outcome).toBe(outcome === 'canceled' ? 'canceled' : 'delivered');
      }
      return base(input, init);
    });
    const controller = new NativeRestitchController({
      endpoint,
      environment: 'beta',
      currentActorId: () => actor,
      vault: f.store,
      journal: f.journal,
      cache: { resolveProtected: vi.fn(), refusedProtected: vi.fn() },
      fetch: f.fetcher,
      run: vi.fn()
    });
    const prepared = await controller.prepare({ rootOperationId: root, teamId: team }, 'process');
    await controller.redeem(prepared.enrollmentId);
    const result = controller.process(prepared.enrollmentId, root, async () => {
      if (outcome === 'canceled') throw Error('PROCESS_CANCELED');
      return { operationId: root, state: 'succeeded', materialId: id(70), reused: true };
    });
    if (outcome === 'canceled') await expect(result).rejects.toThrow('PROCESS_CANCELED');
    else await expect(result).resolves.toMatchObject({ state: 'succeeded', materialId: id(70) });
    expect(finishes).toHaveLength(1);
    expect(f.journal.save).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'quiescent',
          outcome: outcome === 'canceled' ? 'canceled' : 'returned'
        })
      ])
    );
  }
);

it('reaches the hosted backend only as a production agent, and a local stack from either', () => {
  const build = (environment: 'beta' | 'production', endpoint: string) =>
    new NativeRestitchController({
      endpoint,
      environment,
      currentActorId: () => actor,
      vault: setup().store,
      journal: setup().journal,
      cache: {} as never,
      fetch: vi.fn(),
      run: vi.fn()
    });
  const hosted = 'https://yvvvignywfmbdgkcxtfk.supabase.co/functions/v1/drive-ops';
  expect(() => build('production', hosted)).not.toThrow();
  expect(() => build('production', endpoint)).not.toThrow();
  expect(() => build('beta', endpoint)).not.toThrow();
  // A beta agent never leaves this machine; nobody reaches the hosted backend in plain HTTP.
  expect(() => build('beta', hosted)).toThrow('INVALID_INPUT');
  expect(() => build('production', hosted.replace('https:', 'http:'))).toThrow('INVALID_INPUT');
  expect(() => build('production', 'https://127.0.0.1:54321/functions/v1/drive-ops')).toThrow(
    'INVALID_INPUT'
  );
});
it('asks for authorization again after one lost reply instead of failing the finished video', async () => {
  // Production 1.4.2: the backend answered nothing for 15 s right after a
  // variant was built; the single authorization read failed and the variant
  // became terminally failed, which no later pass may run again.
  const f = setup();
  const implementation = f.fetcher.getMockImplementation()!;
  let nativeInstanceId = '',
    authorizeCalls = 0;
  f.fetcher.mockImplementation(async (input, init) => {
    const action = new URL(String(input)).pathname.split('/').at(-1);
    if (action === 'authorize') {
      authorizeCalls += 1;
      if (authorizeCalls === 1) throw new TypeError('fetch failed');
      return new Response(
        JSON.stringify({
          ok: true,
          value: {
            grantId: JSON.parse(String(init?.body)).grantId,
            rootOperationId: root,
            actorId: actor,
            teamId: team,
            nativeInstanceId,
            executorId: id(4),
            epoch: 1,
            active: true
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      );
    }
    const response = await implementation(input, init);
    if (action === 'context')
      nativeInstanceId = (await response.clone().json()).value.nativeInstanceId;
    return response;
  });
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn(),
    transientRetry: { delaysMs: [1], sleep: async () => {} }
  });
  const enrollment = await controller.prepare({ rootOperationId: root, teamId: team }, 'process');
  await controller.redeem(enrollment.enrollmentId);
  const result = await controller.process(enrollment.enrollmentId, root, async ({ authorize }) => {
    await authorize();
    return { operationId: root, state: 'succeeded', materialId: id(8), reused: false };
  });
  expect(result).toMatchObject({ state: 'succeeded' });
  expect(authorizeCalls).toBe(2);
  await controller.shutdown();
});
it('still fails when authorization stays unreachable for the whole budget', async () => {
  let clock = 0;
  const f = setup();
  const implementation = f.fetcher.getMockImplementation()!;
  let authorizeCalls = 0;
  f.fetcher.mockImplementation(async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/authorize')) {
      authorizeCalls += 1;
      throw new TypeError('fetch failed');
    }
    return implementation(input, init);
  });
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn(),
    // Unreachable for the whole budget: 90 s of 10 s waits on a fake clock.
    transientRetry: {
      delaysMs: [10_000],
      sleep: async ms => {
        clock += ms;
      },
      now: () => clock
    }
  });
  const enrollment = await controller.prepare({ rootOperationId: root, teamId: team }, 'process');
  await controller.redeem(enrollment.enrollmentId);
  await expect(
    controller.process(enrollment.enrollmentId, root, async ({ authorize }) => {
      await authorize();
      return { operationId: root, state: 'succeeded', materialId: id(8), reused: false };
    })
  ).rejects.toMatchObject({ code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN' });
  // Attempts at 0, 10 s … 90 s: the run's whole 90 s budget, then it gives up.
  expect(authorizeCalls).toBe(10);
  await controller.shutdown();
});
function healing(healVaultFaults: boolean) {
  const f = setup();
  const controller = new NativeRestitchController({
    endpoint,
    environment: 'beta',
    currentActorId: () => actor,
    vault: f.store,
    journal: f.journal,
    cache: {} as never,
    fetch: f.fetcher,
    run: vi.fn(),
    healVaultFaults
  });
  return { f, controller };
}
const otherRoot = id(40);
it('Windows: a journal read that failed on first use is read again on the next call', async () => {
  const { f, controller } = healing(true);
  f.store.read.mockRejectedValueOnce(new Error('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'));
  await expect(controller.prepare({ rootOperationId: root, teamId: team })).rejects.toThrow();
  expect(f.store.write).not.toHaveBeenCalled();
  const prepared = await controller.prepare({ rootOperationId: root, teamId: team });
  expect(prepared.proofDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(f.store.read).toHaveBeenCalledTimes(2);
  await controller.shutdown();
});
it('Windows: one failed journal write is committed by the next call instead of refusing until restart', async () => {
  const { f, controller } = healing(true);
  f.store.write.mockRejectedValueOnce(new Error('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'));
  await expect(controller.prepare({ rootOperationId: root, teamId: team })).rejects.toThrow();
  const prepared = await controller.prepare({ rootOperationId: otherRoot, teamId: team });
  expect(prepared.proofDigest).toMatch(/^[a-f0-9]{64}$/u);
  await controller.shutdown();
});
it('macOS keeps a failed journal read or write until restart, exactly as before', async () => {
  const read = healing(false);
  read.f.store.read.mockRejectedValueOnce(new Error('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'));
  await expect(read.controller.prepare({ rootOperationId: root, teamId: team })).rejects.toThrow();
  await expect(read.controller.prepare({ rootOperationId: root, teamId: team })).rejects.toThrow();
  expect(read.f.store.read).toHaveBeenCalledTimes(1);
  await read.controller.shutdown();
  const write = healing(false);
  write.f.store.write.mockRejectedValueOnce(new Error('RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'));
  await expect(write.controller.prepare({ rootOperationId: root, teamId: team })).rejects.toThrow();
  await expect(
    write.controller.prepare({ rootOperationId: otherRoot, teamId: team })
  ).rejects.toThrow();
  await write.controller.shutdown();
});
