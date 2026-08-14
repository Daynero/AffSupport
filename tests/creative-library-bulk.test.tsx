import { describe, expect, it, vi } from 'vitest';
import {
  createBatchUploadCoordinator,
  deriveUploadBatchState,
  uploadBatchItemKey
} from '../supabase/functions/library-ops/handler.js';

const items = Array.from({ length: 100 }, (_, index) => ({
  clientItemKey: `item-${index}`,
  name: `creative-${index}.mp4`,
  mimeType: 'video/mp4',
  sizeBytes: index + 1
}));

describe('Creative Library bulk upload orchestration', () => {
  it('processes 100 items with bounded concurrency and exposes each success immediately', async () => {
    let active = 0;
    let maximumActive = 0;
    const visible: string[] = [];
    const upload = vi.fn(async (item: (typeof items)[number]) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return { materialId: `material-${item.clientItemKey}` };
    });
    const coordinator = createBatchUploadCoordinator({ concurrency: 4, upload });
    const result = await coordinator.run(items, snapshot => {
      visible.splice(0, visible.length, ...snapshot.readyMaterialIds);
    });
    expect(upload).toHaveBeenCalledTimes(100);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(result.state).toBe('succeeded');
    expect(result.succeeded).toHaveLength(100);
    expect(visible).toHaveLength(100);
  });

  it('keeps successful items while retrying only failed/resumable items', async () => {
    const attempts = new Map<string, number>();
    const coordinator = createBatchUploadCoordinator({
      concurrency: 3,
      upload: async item => {
        const attempt = (attempts.get(item.clientItemKey) ?? 0) + 1;
        attempts.set(item.clientItemKey, attempt);
        if (item.clientItemKey === 'item-4' && attempt === 1) throw new Error('RATE_LIMITED');
        return { materialId: `material-${item.clientItemKey}` };
      }
    });
    const first = await coordinator.run(items.slice(0, 10));
    expect(first.state).toBe('partial');
    expect(first.failed.map(item => item.clientItemKey)).toEqual(['item-4']);
    const second = await coordinator.retryFailed(first);
    expect(second.state).toBe('succeeded');
    expect(attempts.get('item-0')).toBe(1);
    expect(attempts.get('item-4')).toBe(2);
  });

  it('uses a stable batch/item idempotency identity and derives truthful partial state', () => {
    expect(uploadBatchItemKey('batch-1', 'item-2')).toBe(uploadBatchItemKey('batch-1', 'item-2'));
    expect(uploadBatchItemKey('batch-1', 'item-2')).not.toBe(
      uploadBatchItemKey('batch-1', 'item-3')
    );
    expect(deriveUploadBatchState({ total: 3, succeeded: 1, failed: 1, canceled: 0 })).toBe(
      'partial'
    );
    expect(deriveUploadBatchState({ total: 3, succeeded: 3, failed: 0, canceled: 0 })).toBe(
      'succeeded'
    );
  });
});
