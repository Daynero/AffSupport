import { afterEach, expect, it, vi } from 'vitest';
import {
  executeLaunchCatalog,
  type LaunchCatalogExecutionDeps
} from '../supabase/functions/drive-ops/launch-catalog';
import { launchConfig, launchSources } from './fixtures/launches';

/**
 * 1.4.3: a launch whose video set went unknown used to be interrupted as
 * retryable and retried every few minutes although nothing could change. It now
 * first requeues every variant that provably failed without output; only a set
 * with no retry left stops the generation, and then for good.
 */
const SET = 'c1930000-0000-4000-8000-000000000010';
type Settled = { retried: number; terminal: number; parentState: string } | null;
afterEach(() => vi.restoreAllMocks());

async function run(input: {
  publication: 'immediate' | 'scheduled';
  settled: Settled;
  cause: string | null;
  /** The scheduled path's observed set state; unknown by default. */
  observed?: 'unknown' | 'preparing';
}) {
  const durable = await import('../supabase/functions/drive-ops/catalog-durable');
  const create = vi.spyOn(durable, 'createDurableProductCatalog').mockResolvedValue({
    outcome: 'preparing_video',
    catalogIntentId: 'intent',
    videoSetId: SET,
    requestedCount: 10,
    registeredCount: 9,
    state: 'unknown'
  });
  const videoPublication =
    input.publication === 'immediate'
      ? { mode: 'immediate' as const }
      : {
          mode: 'scheduled' as const,
          localDateTime: '2030-01-01T12:00',
          timeZone: 'Europe/Kyiv',
          resolvedOffset: '+02:00',
          dueAt: '2030-01-01T10:00:00.000Z'
        };
  const config = launchConfig({
    method: 'catalog',
    catalog: {
      productCount: 100,
      restitchEnabled: true,
      finalDurationMode: 'custom',
      customFinalDurationSeconds: 120,
      catalogVideoProtocolVersion: 1,
      videoVariationCount: 10,
      videoPublication
    }
  });
  const rpc = vi.fn(async (name: string) => ({
    error: null,
    data:
      name === 'service_claim_launch_generation'
        ? {
            state: 'running',
            catalogImageContractVersion: 2,
            fence: '2',
            config,
            sources: launchSources,
            advertisingUrl: 'https://synthetic.invalid/'
          }
        : name === 'service_read_launch_catalog_video_context'
          ? {
              requestPayload: { idempotencyKey: 'launch:generation:catalog' },
              executorId: 'c1930000-0000-4000-8000-000000000002',
              settings: { configured: true, operation: 'restitch', sourceMode: 'drive' }
            }
          : name === 'service_read_initial_catalog_video'
            ? input.publication === 'scheduled'
              ? {
                  outcome: 'created',
                  catalog: { materialId: 'same' },
                  videoGenerationObservation: {
                    videoSetId: SET,
                    requestedCount: 10,
                    registeredCount: 9,
                    state: input.observed ?? 'unknown',
                    catalogVideoCells: 'deferred_blank'
                  }
                }
              : null
            : name === 'service_retry_failed_catalog_video_variants'
              ? input.settled
              : name === 'service_restore_registered_launch_catalog'
                ? false
                : null
  }));
  const result = await executeLaunchCatalog(
    {
      service: { rpc },
      catalog: {} as LaunchCatalogExecutionDeps['catalog'],
      driveFor: vi.fn(),
      proveSource: vi.fn(),
      proveCatalog: vi.fn(),
      createInitialVideoAuthority: vi.fn(async () => ({
        serverNow: vi.fn(),
        prepare: vi.fn(),
        registerCreated: vi.fn()
      })),
      readCatalogVideoFailure: async () => input.cause as never
    },
    'team',
    'generation',
    'actor'
  );
  return { result, rpc, names: rpc.mock.calls.map(([name]) => name), create };
}

it.each(['immediate', 'scheduled'] as const)(
  'keeps a %s launch waiting when its failed variant was requeued',
  async publication => {
    const { result, rpc, names } = await run({
      publication,
      settled: { retried: 1, terminal: 0, parentState: 'preparing' },
      cause: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    });
    expect(result).toEqual({ id: 'generation', state: 'accepted' });
    expect(rpc).toHaveBeenCalledWith('service_retry_failed_catalog_video_variants', {
      p_set: SET,
      p_team: 'team',
      p_actor: 'actor'
    });
    expect(names).toContain('service_wait_launch_catalog_video');
    expect(names).not.toContain('service_interrupt_launch_generation');
    expect(names).not.toContain('service_fail_launch_catalog_video');
  }
);

it.each(['immediate', 'scheduled'] as const)(
  'stops a %s launch as non-retryable when its set has no retry left',
  async publication => {
    const { result, rpc, names } = await run({
      publication,
      settled: { retried: 0, terminal: 1, parentState: 'unknown' },
      cause: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
    });
    expect(result).toEqual({ id: 'generation', state: 'interrupted' });
    expect(rpc).toHaveBeenCalledWith(
      'service_fail_launch_catalog_video',
      expect.objectContaining({
        p_generation: 'generation',
        p_code: 'RESTITCH_SCREEN_ACCOUNTING_UNCERTAIN'
      })
    );
    expect(names).not.toContain('service_interrupt_launch_generation');
    expect(names).not.toContain('service_wait_launch_catalog_video');
  }
);

it('settles a preparing set too, so an abandoned video is noticed while waiting', async () => {
  const { rpc, names } = await run({
    publication: 'scheduled',
    observed: 'preparing',
    settled: { retried: 1, terminal: 0, parentState: 'preparing' },
    cause: null
  });
  expect(rpc).toHaveBeenCalledWith('service_retry_failed_catalog_video_variants', {
    p_set: SET,
    p_team: 'team',
    p_actor: 'actor'
  });
  expect(names).not.toContain('service_interrupt_launch_generation');
  expect(names).not.toContain('service_fail_launch_catalog_video');
});

it('never stops for good with the code the recovery lane retries by design', async () => {
  const { rpc } = await run({
    publication: 'immediate',
    settled: { retried: 0, terminal: 1, parentState: 'unknown' },
    cause: 'PROCESS_RESULT_UNCERTAIN'
  });
  expect(rpc).toHaveBeenCalledWith(
    'service_fail_launch_catalog_video',
    expect.objectContaining({ p_code: 'PROCESS_FAILED' })
  );
});

it('keeps the old retryable interruption when nothing proves the set is terminal', async () => {
  // An unreadable settle (older database, transient failure) or an uncertain variant.
  for (const settled of [null, { retried: 0, terminal: 0, parentState: 'unknown' }]) {
    const { result, rpc, names } = await run({
      publication: 'immediate',
      settled,
      cause: 'STITCH_VERIFICATION_FAILED'
    });
    expect(result).toEqual({ id: 'generation', state: 'interrupted' });
    expect(rpc).toHaveBeenCalledWith(
      'service_interrupt_launch_generation',
      expect.objectContaining({ p_code: 'STITCH_VERIFICATION_FAILED' })
    );
    expect(names).not.toContain('service_fail_launch_catalog_video');
    vi.restoreAllMocks();
  }
});
