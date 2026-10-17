import { describe, expect, it, vi } from 'vitest';
import {
  generateLaunch,
  type LaunchGenerationDeps
} from '../supabase/functions/drive-ops/launches';
import { launchConfig, launchSources } from './fixtures/launches';
import { TeamFunctionError } from '../supabase/functions/_shared/errors';
const ACTOR = '75000000-0000-4000-8000-000000000001';
const input = {
  teamId: '75000000-0000-4000-8000-000000000002',
  launchId: '75000000-0000-4000-8000-000000000003',
  expectedVersion: '2',
  requestKey: 'other-test-request'
};
function deps(method: 'other' | 'catalog' = 'other') {
  const cfg = launchConfig({ method });
  const caller = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'find_launch_generation' ? null : { id: input.launchId, version: '2', draft: cfg }
  }));
  const service = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_launch_sources'
        ? {
            ...launchSources,
            schemaVersion: 1,
            agentRowId: cfg.agentRowId,
            offerId: cfg.offerId,
            buyerId: cfg.buyerId,
            materialId: cfg.materialId,
            catalogSettingsVersion: null
          }
        : name === 'service_accept_launch_generation'
          ? { id: 'generation', fence: '1' }
          : { id: 'generation', state: 'succeeded' }
  }));
  return {
    caller: { rpc: caller },
    service: { rpc: service },
    callerSpy: caller,
    serviceSpy: service
  };
}
describe('Launch other server orchestration', () => {
  it('derives from saved config and publishes one fenced result with no provider calls', async () => {
    const d = deps();
    const result = await generateLaunch(d, input, ACTOR);
    expect(result).toEqual({ id: 'generation', state: 'succeeded' });
    expect(d.serviceSpy.mock.calls.map(([name]) => name)).toEqual([
      'service_launch_sources',
      'service_accept_launch_generation',
      'service_publish_launch_generation'
    ]);
  });
  it('replays success before live source reads and rejects payload mismatch', async () => {
    const service = vi.fn();
    const replay: LaunchGenerationDeps = {
      caller: {
        rpc: async () => ({
          error: null,
          data: {
            id: 'generation',
            launchId: input.launchId,
            expectedVersion: '2',
            state: 'succeeded',
            method: 'other'
          }
        })
      },
      service: { rpc: service }
    };
    await generateLaunch(replay, input, ACTOR);
    expect(service).not.toHaveBeenCalled();
    await expect(
      generateLaunch(replay, { ...input, expectedVersion: '3' }, ACTOR)
    ).rejects.toMatchObject({ code: 'LAUNCH_VERSION_CONFLICT' });
  });
  it('finishes an accepted other intent after a lost reply without new sources or intent', async () => {
    const service = vi.fn(async () => ({ error: null, data: { state: 'succeeded' } }));
    await generateLaunch(
      {
        caller: {
          rpc: async () => ({
            error: null,
            data: {
              id: 'generation',
              launchId: input.launchId,
              expectedVersion: '2',
              state: 'accepted',
              method: 'other',
              fence: '1'
            }
          })
        },
        service: { rpc: service }
      },
      input,
      ACTOR
    );
    expect(service.mock.calls).toHaveLength(1);
  });
  it('does not accept catalog work before durable provider integration is available', async () => {
    const d = deps('catalog');
    await expect(generateLaunch(d, input, ACTOR)).rejects.toMatchObject({ code: 'NO_WORK' });
    expect(d.serviceSpy).not.toHaveBeenCalled();
  });
});

it('does not accept work after live source proof fails, and does not leak unknown exception content', async () => {
  const d = deps();
  const secret = 'SYNTHETIC_CAPI_SECRET';
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(
      generateLaunch(
        {
          ...d,
          proveSource: async () => {
            throw new Error(`https://example.invalid/?token=${secret}`);
          }
        },
        input,
        ACTOR
      )
    ).rejects.toMatchObject({
      code: 'LAUNCH_INTERNAL_ERROR',
      details: { reason: 'UNKNOWN_CAUSE' }
    });
    expect(d.serviceSpy.mock.calls.map(([name]) => name)).toEqual(['service_launch_sources']);
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it('preserves a typed source mismatch and refuses a durable Other generation intent', async () => {
  const d = deps();
  await expect(
    generateLaunch(
      {
        ...d,
        proveSource: async () => {
          throw new TeamFunctionError('SOURCE_CHANGED');
        }
      },
      input,
      ACTOR
    )
  ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
  expect(d.serviceSpy.mock.calls.map(([name]) => name)).toEqual(['service_launch_sources']);
});

it('accepts a configured non-restitch catalog for hosted execution without publishing early', async () => {
  const d = deps('catalog');
  const ready = vi.fn(async () => undefined);
  const result = await generateLaunch({ ...d, catalogReady: ready }, input, ACTOR);
  expect(result).toEqual({ id: 'generation', fence: '1', state: 'accepted' });
  expect(ready).toHaveBeenCalledTimes(1);
  expect(d.serviceSpy.mock.calls.map(([name]) => name)).toEqual([
    'service_launch_sources',
    'service_accept_launch_generation'
  ]);
});

it('accepts configured restitch work without starting local or provider work on the accept endpoint', async () => {
  const d = deps('catalog');
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120
    }
  });
  d.callerSpy.mockImplementation(async (name: string) => ({
    error: null,
    data:
      name === 'find_launch_generation' ? null : { id: input.launchId, version: '2', draft: config }
  }));
  const result = await generateLaunch({ ...d, catalogReady: async () => undefined }, input, ACTOR);
  expect(result).toMatchObject({ state: 'accepted' });
  expect(d.serviceSpy.mock.calls.map(([name]) => name)).toEqual([
    'service_launch_sources',
    'service_accept_launch_generation'
  ]);
});
