import { afterEach, expect, it, vi } from 'vitest';
import type { LaunchDetail } from '../packages/shared/src/team/launches';
import { launchConfig, launchSources } from './fixtures/launches';
import { prepareOriginalVideo } from '../apps/web/src/team/launches/originalVideo';
const detail = {
  id: 'launch',
  version: '3',
  draft: {
    ...launchConfig(),
    method: 'catalog',
    catalog: { ...launchConfig().catalog, productCount: 100, restitchEnabled: true }
  },
  generation: { id: 'gen', state: 'failed' }
} as LaunchDetail;
it('cancels and confirms the previous attempt before preparing original video for generation and future updates', async () => {
  const order: string[] = [];
  const cancel = vi.fn(async () => {
    order.push('cancel');
  });
  const read = vi.fn(async () => {
    order.push('read');
    return {
      ...detail,
      version: '4',
      generation: { ...detail.generation!, state: 'canceled' as const }
    };
  });
  const selection = vi.fn(async () => {
    order.push('selection');
    const config = launchConfig();
    return {
      ...launchSources,
      schemaVersion: 1 as const,
      agentRowId: config.agentRowId,
      offerId: config.offerId,
      buyerId: config.buyerId,
      materialId: config.materialId,
      catalogSettingsVersion: '1'
    };
  });
  const result = await prepareOriginalVideo({ detail, cancel, read, selection });
  expect(order).toEqual(['cancel', 'read', 'selection']);
  expect(result.config.catalog?.restitchEnabled).toBe(false);
  expect(result.config.materialId).toBe(detail.draft.materialId);
  expect(result.config.catalog?.productCount).toBe(100);
  expect(detail.draft.catalog?.restitchEnabled).toBe(true);
  expect(result.detail.version).toBe('4');
  expect(selection).toHaveBeenCalledWith(result.config);
});
it.each(['running', 'failed'] as const)(
  'never starts another catalog while prior state is %s',
  async state => {
    const selection = vi.fn();
    await expect(
      prepareOriginalVideo({
        detail,
        cancel: vi.fn(),
        read: async () => ({ ...detail, generation: { ...detail.generation!, state } }),
        selection
      })
    ).rejects.toMatchObject({ code: 'LAUNCH_BUSY' });
    expect(selection).not.toHaveBeenCalled();
  }
);
it('rejects a changed generation rather than canceling or replacing somebody else’s result', async () => {
  const selection = vi.fn();
  await expect(
    prepareOriginalVideo({
      detail,
      cancel: vi.fn(),
      read: async () => ({
        ...detail,
        generation: { ...detail.generation!, id: 'other', state: 'canceled' }
      }),
      selection
    })
  ).rejects.toMatchObject({ code: 'LAUNCH_VERSION_CONFLICT' });
  expect(selection).not.toHaveBeenCalled();
});

afterEach(() => vi.useRealTimers());
it('waits for confirmed cancellation before accepting a changed restitch policy', async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      ...detail,
      generation: { ...detail.generation!, state: 'cancel_requested' }
    })
    .mockResolvedValue({ ...detail, generation: { ...detail.generation!, state: 'canceled' } });
  const selection = vi.fn().mockResolvedValue(launchSources);
  const result = prepareOriginalVideo({ detail, cancel: vi.fn(), read, selection });
  await vi.advanceTimersByTimeAsync(1999);
  expect(selection).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect((await result).config.catalog?.restitchEnabled).toBe(false);
});
it('bounds an unfinished cancellation and never generates over uncertain cleanup', async () => {
  vi.useFakeTimers();
  const selection = vi.fn();
  const result = prepareOriginalVideo({
    detail,
    cancel: vi.fn(),
    read: async () => ({
      ...detail,
      generation: { ...detail.generation!, state: 'canceled_with_cleanup_pending' }
    }),
    selection
  });
  const rejected = expect(result).rejects.toMatchObject({ code: 'LAUNCH_BUSY' });
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(selection).not.toHaveBeenCalled();
});

it('does not overwrite a draft edited while cancellation was being settled', async () => {
  const selection = vi.fn();
  await expect(
    prepareOriginalVideo({
      detail,
      cancel: vi.fn(),
      read: async () => ({
        ...detail,
        draft: { ...detail.draft, creativeAlias: 'changed' },
        generation: { ...detail.generation!, state: 'canceled' }
      }),
      selection
    })
  ).rejects.toMatchObject({ code: 'LAUNCH_VERSION_CONFLICT' });
  expect(selection).not.toHaveBeenCalled();
});
it('stops waiting on unmount without preparing a replacement generation', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const selection = vi.fn();
  const result = prepareOriginalVideo({
    detail,
    cancel: vi.fn(),
    read: async () => ({
      ...detail,
      generation: { ...detail.generation!, state: 'cancel_requested' }
    }),
    selection,
    signal: controller.signal
  });
  const rejected = expect(result).rejects.toMatchObject({ code: 'PROCESS_CANCELED' });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  expect(selection).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
