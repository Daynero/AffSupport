import { describe, expect, it, vi } from 'vitest';
import {
  createCatalogForegroundCoordinator,
  admitCatalogForeground,
  catalogForegroundPreparationFailure,
  isCatalogForegroundPreparationFailure,
  isCatalogForegroundExecutorSnapshot
} from '../apps/web/src/api/catalog-video-foreground';
const teamId = '47000000-0000-4000-8000-000000000001';
const actor = '47000000-0000-4000-8000-000000000002';
const sourceMaterialId = '47000000-0000-4000-8000-000000000003';
const enrollmentId = '47000000-0000-4000-8000-000000000004';
const nativeInstanceId = '47000000-0000-4000-8000-000000000005';
const setId = '47000000-0000-4000-8000-000000000006';
const publicReceipt = {
  protocolVersion: 1 as const,
  enrollmentId,
  nativeInstanceId,
  proofDigest: 'a'.repeat(64)
};
const binding = {
  kind: 'create' as const,
  teamId,
  sourceMaterialId,
  idempotencyKey: 'product-catalog:original'
};
const progress = {
  videoSetId: setId,
  state: 'preparing',
  executor: { mode: 'paired_session', enrollmentId, nativeInstanceId }
};
function setup() {
  const state = { actor: actor as string | null, epoch: 1 };
  const local = vi.fn(async (path: string, _body: unknown): Promise<unknown> =>
    path.endsWith('/prepare')
      ? publicReceipt
      : { protocolVersion: 1, setId, enrollmentId, state: 'running' }
  );
  const deps = {
    actor: () => state.actor,
    epoch: () => state.epoch,
    enabled: () => true,
    capability: vi.fn(async () => ({ available: true, protocolVersion: 1 })),
    entitlement: vi.fn(async () => undefined),
    local
  };
  return { state, deps, coordinator: createCatalogForegroundCoordinator(deps) };
}
describe('paired one-set browser coordination', () => {
  it('reuses the same public proof for duplicate/retry admission and never sends browser credentials', async () => {
    const { coordinator, deps } = setup();
    const [a, b] = await Promise.all([coordinator.prepare(binding), coordinator.prepare(binding)]);
    expect(a).toEqual(publicReceipt);
    expect(b).toEqual(a);
    expect(await coordinator.prepare(binding)).toEqual(a);
    expect(deps.local).toHaveBeenCalledOnce();
    expect(deps.local.mock.calls[0]).toEqual([
      '/api/team/catalog-video/foreground/prepare',
      { protocolVersion: 1, teamId, sourceMaterialId, requestKey: binding.idempotencyKey },
      undefined
    ]);
    expect(JSON.stringify(deps.local.mock.calls)).not.toMatch(
      /access_token|refresh_token|authorization|jwt|proofSecret/iu
    );
  });
  it('binds manager preparation to the original profile version', async () => {
    const { coordinator, deps } = setup();
    await coordinator.prepare({
      kind: 'updater',
      teamId,
      sourceMaterialId,
      catalogMaterialId: setId,
      requestId: enrollmentId,
      profileVersion: 7
    });
    expect(deps.local).toHaveBeenCalledWith(
      '/api/team/catalog-video/foreground/prepare',
      {
        protocolVersion: 1,
        teamId,
        sourceMaterialId,
        requestKey: enrollmentId,
        expectedVersion: 7
      },
      undefined
    );
  });
  it('rejects actor replacement during attachment and retries later with the same set', async () => {
    const { coordinator, deps, state } = setup();
    deps.local.mockImplementationOnce(async () => {
      state.epoch++;
      return { protocolVersion: 1, setId, enrollmentId, state: 'running' };
    });
    await expect(coordinator.attach(teamId, progress)).rejects.toThrow('PERMISSION_DENIED');
    await coordinator.attach(teamId, progress);
    expect(deps.local.mock.calls[0]).toEqual(deps.local.mock.calls[1]);
  });
  it('does not require native execution for source-only/reused responses without an executor', async () => {
    const { coordinator, deps } = setup();
    deps.capability.mockResolvedValue({ available: false, protocolVersion: 1 });
    expect(await coordinator.prepare(binding)).toBeUndefined();
    await coordinator.attach(teamId, { ...progress, executor: undefined });
    expect(deps.entitlement).not.toHaveBeenCalled();
    expect(deps.local).not.toHaveBeenCalled();
  });
  it.each(['actor', 'epoch', 'abort'] as const)(
    'fences %s replacement during native preparation before admission',
    async kind => {
      const { coordinator, deps, state } = setup();
      const controller = new AbortController();
      deps.entitlement.mockImplementation(async () => {
        if (kind === 'actor') state.actor = sourceMaterialId;
        if (kind === 'epoch') state.epoch++;
        if (kind === 'abort') controller.abort();
      });
      await expect(coordinator.prepare(binding, controller.signal)).rejects.toThrow(
        kind === 'abort' ? 'PROCESS_CANCELED' : 'PERMISSION_DENIED'
      );
      expect(deps.local).not.toHaveBeenCalled();
    }
  );
  it('copies only public preparation evidence and rejects malformed proof', async () => {
    const { coordinator, deps } = setup();
    deps.local.mockResolvedValueOnce({ ...publicReceipt, proofSecret: 'native-only' });
    expect(await coordinator.prepare(binding)).toEqual(publicReceipt);
    deps.local.mockResolvedValueOnce({ ...publicReceipt, proofDigest: 'bad' });
    await expect(coordinator.prepare({ ...binding, idempotencyKey: 'other' })).rejects.toThrow(
      'INVALID_RESPONSE'
    );
  });
  it('attaches only an exact server-confirmed active set and coalesces readback', async () => {
    const { coordinator, deps } = setup();
    await Promise.all([coordinator.attach(teamId, progress), coordinator.attach(teamId, progress)]);
    expect(deps.local).toHaveBeenCalledExactlyOnceWith(
      '/api/team/catalog-video/foreground/attach',
      { protocolVersion: 1, teamId, setId, enrollmentId, nativeInstanceId },
      undefined
    );
    await coordinator.attach(teamId, { ...progress, state: 'canceled' });
    await coordinator.attach(teamId, { ...progress, state: 'unknown' });
    expect(deps.local).toHaveBeenCalledOnce();
  });
  it('retains exact set and enrollment on lost attach reply without preparing or claiming another set', async () => {
    const { coordinator, deps } = setup();
    deps.local.mockRejectedValueOnce(Error('lost reply'));
    await expect(coordinator.attach(teamId, progress)).rejects.toThrow('lost reply');
    await coordinator.attach(teamId, progress);
    expect(deps.local.mock.calls[0]).toEqual(deps.local.mock.calls[1]);
    expect(deps.capability).not.toHaveBeenCalled();
  });
  it('rejects mismatched native attachment receipt and uncertain start', async () => {
    const { coordinator, deps } = setup();
    deps.local.mockResolvedValueOnce({
      protocolVersion: 1,
      setId: sourceMaterialId,
      enrollmentId,
      state: 'running'
    });
    await expect(coordinator.attach(teamId, progress)).rejects.toThrow('INVALID_RESPONSE');
    deps.local.mockResolvedValueOnce({ protocolVersion: 1, setId, enrollmentId, state: 'unknown' });
    await expect(coordinator.attach(teamId, progress)).rejects.toThrow('PROCESS_RESULT_UNCERTAIN');
  });
  it('does not accept another authentication mode or malformed native identity', () => {
    expect(isCatalogForegroundExecutorSnapshot({ ...progress.executor, mode: 'background' })).toBe(
      false
    );
    expect(
      isCatalogForegroundExecutorSnapshot({ ...progress.executor, nativeInstanceId: 'bad' })
    ).toBe(false);
  });
});

it('recognizes local pre-admission failures only by a private identity, never provider payload fields', () => {
  const local = catalogForegroundPreparationFailure(Error('INVALID_RESPONSE'));
  expect(isCatalogForegroundPreparationFailure(local)).toBe(true);
  expect(isCatalogForegroundPreparationFailure({ accepted: false, code: 'INVALID_RESPONSE' })).toBe(
    false
  );
  expect(isCatalogForegroundPreparationFailure(Error('INVALID_RESPONSE'))).toBe(false);
});

it('allows canonical READY reuse after optional preparation failed without attaching native execution', async () => {
  const run = vi.fn(async (executor: unknown) => {
    expect(executor).toBeUndefined();
    return { state: 'ready', setId };
  });
  const result = await admitCatalogForeground({
    prepare: async () => {
      throw Error('INVALID_RESPONSE');
    },
    admit: run,
    current: () => {}
  });
  expect(result).toEqual({ state: 'ready', setId });
  expect(run).toHaveBeenCalledOnce();
});
it('preserves an unknown canonical POST despite an earlier local preparation failure', async () => {
  const unknown = Error('lost canonical response');
  try {
    await admitCatalogForeground({
      prepare: async () => {
        throw Error('INVALID_RESPONSE');
      },
      admit: async () => {
        throw unknown;
      },
      current: () => {}
    });
    expect.unreachable();
  } catch (error) {
    expect(error).toBe(unknown);
    expect(isCatalogForegroundPreparationFailure(error)).toBe(false);
  }
});
it('brands a local failure only after a proved nonretryable admission refusal', async () => {
  try {
    await admitCatalogForeground({
      prepare: async () => {
        throw Error('INVALID_RESPONSE');
      },
      admit: async () => {
        throw Object.assign(Error('AGENT_REQUIRED'), { code: 'AGENT_REQUIRED', retryable: false });
      },
      current: () => {}
    });
    expect.unreachable();
  } catch (error) {
    expect(isCatalogForegroundPreparationFailure(error)).toBe(true);
    expect((error as Error).message).toBe('INVALID_RESPONSE');
  }
});
it('never dispatches canonical admission after abort or owner replacement during optional preparation', async () => {
  let changed = false;
  const run = vi.fn();
  await expect(
    admitCatalogForeground({
      prepare: async () => {
        changed = true;
        throw Error('INVALID_RESPONSE');
      },
      admit: run,
      current: () => {
        if (changed) throw Error('PERMISSION_DENIED');
      }
    })
  ).rejects.toThrow('PERMISSION_DENIED');
  expect(run).not.toHaveBeenCalled();
});
