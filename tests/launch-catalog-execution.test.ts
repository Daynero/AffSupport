import { expect, it, vi } from 'vitest';
import {
  executeLaunchCatalog,
  type LaunchCatalogExecutionDeps
} from '../supabase/functions/drive-ops/launch-catalog';
import { launchConfig, launchSources } from './fixtures/launches';

it('settles the exact registered child before mutable-source proof or provider work', async () => {
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_claim_launch_generation'
        ? {
            state: 'running',
            fence: '2',
            config: launchConfig({ method: 'catalog' }),
            sources: launchSources,
            advertisingUrl: 'https://example.invalid/'
          }
        : name === 'service_restore_registered_launch_catalog'
          ? true
          : name === 'service_publish_launch_generation'
            ? { state: 'succeeded' }
            : null
  }));
  const deps: LaunchCatalogExecutionDeps = {
    service: { rpc },
    catalog: {} as LaunchCatalogExecutionDeps['catalog'],
    driveFor: vi.fn(),
    proveSource: vi.fn(),
    proveCatalog: vi.fn()
  };
  expect(await executeLaunchCatalog(deps, 'team', 'generation', 'actor')).toEqual({
    state: 'succeeded'
  });
  expect(rpc.mock.calls.map(([name]) => name)).toEqual([
    'service_claim_launch_generation',
    'service_restore_registered_launch_catalog',
    'service_touch_launch_generation',
    'service_publish_launch_generation'
  ]);
  expect(deps.proveSource).not.toHaveBeenCalled();
  expect(deps.driveFor).not.toHaveBeenCalled();
});

it('refuses an uncertified restitch receipt before planning catalog resources or provider work', async () => {
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_claim_launch_generation'
        ? {
            state: 'running',
            fence: '2',
            config: launchConfig({
              method: 'catalog',
              catalog: {
                productCount: 100,
                restitchEnabled: true,
                finalDurationMode: 'custom',
                customFinalDurationSeconds: 120
              }
            }),
            sources: launchSources,
            advertisingUrl: 'https://example.invalid/'
          }
        : name === 'service_restore_registered_launch_catalog'
          ? false
          : name === 'service_launch_restitch_receipt'
            ? { operationId: 'invalid', materialId: 'invalid' }
            : null
  }));
  const deps: LaunchCatalogExecutionDeps = {
    service: { rpc },
    catalog: {} as LaunchCatalogExecutionDeps['catalog'],
    driveFor: vi.fn(),
    proveSource: vi.fn(),
    proveCatalog: vi.fn()
  };
  await expect(executeLaunchCatalog(deps, 'team', 'generation', 'actor')).rejects.toMatchObject({
    code: 'INVALID_RESPONSE'
  });
  expect(rpc.mock.calls.some(([name]) => name === 'service_begin_catalog_intent')).toBe(false);
  expect(deps.driveFor).not.toHaveBeenCalled();
});

it('retries parent publication after a lost reply without recreating an already registered catalog', async () => {
  let publishCalls = 0;
  const rpc = vi.fn(async (name: string) => {
    if (name === 'service_publish_launch_generation') {
      publishCalls++;
      if (publishCalls === 1) throw new Error('lost publication reply');
      return { data: { state: 'succeeded' }, error: null };
    }
    return {
      error: null,
      data:
        name === 'service_claim_launch_generation'
          ? {
              state: 'running',
              fence: '2',
              config: launchConfig({ method: 'catalog' }),
              sources: launchSources,
              advertisingUrl: 'https://example.invalid/'
            }
          : name === 'service_restore_registered_launch_catalog'
            ? true
            : null
    };
  });
  const deps: LaunchCatalogExecutionDeps = {
    service: { rpc },
    catalog: {} as LaunchCatalogExecutionDeps['catalog'],
    driveFor: vi.fn(),
    proveSource: vi.fn(),
    proveCatalog: vi.fn()
  };
  await expect(executeLaunchCatalog(deps, 'team', 'generation', 'actor')).rejects.toMatchObject({
    code: 'LAUNCH_INTERNAL_ERROR'
  });
  await expect(executeLaunchCatalog(deps, 'team', 'generation', 'actor')).resolves.toEqual({
    state: 'succeeded'
  });
  expect(publishCalls).toBe(2);
  expect(deps.proveSource).not.toHaveBeenCalled();
  expect(deps.driveFor).not.toHaveBeenCalled();
  expect(
    rpc.mock.calls.filter(([name]) => name === 'service_restore_registered_launch_catalog')
  ).toHaveLength(2);
});
