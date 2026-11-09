import { expect, it, vi } from 'vitest';
import { createRestoreBatch } from '../apps/web/src/team/materials/restore-batch';
const receipt = (id: string) => ({
  operationId: 'operation',
  state: 'succeeded',
  materialId: id,
  reused: false
});
it('serializes double Undo clicks and reports completion only once', async () => {
  let release!: (v: unknown) => void;
  const restore = vi.fn(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    ),
    completed = vi.fn();
  const batch = createRestoreBatch({
    materialIds: ['a'],
    restore,
    current: () => true,
    completed,
    failed: vi.fn()
  });
  const first = batch.run(),
    second = batch.run();
  expect(second).toBe(first);
  await Promise.resolve();
  expect(restore).toHaveBeenCalledTimes(1);
  release(receipt('a'));
  await first;
  await batch.run();
  expect(completed).toHaveBeenCalledTimes(1);
  expect(restore).toHaveBeenCalledTimes(1);
});
it('retries only unfinished siblings with their original request keys', async () => {
  const restore = vi
    .fn()
    .mockResolvedValueOnce(receipt('a'))
    .mockRejectedValueOnce(Error('lost'))
    .mockResolvedValueOnce(receipt('b'))
    .mockResolvedValueOnce(receipt('c'));
  const completed = vi.fn();
  const batch = createRestoreBatch({
    materialIds: ['a', 'b', 'c'],
    restore,
    current: () => true,
    completed,
    failed: vi.fn()
  });
  expect(await batch.run()).toBe(false);
  expect(await batch.run()).toBe(true);
  expect(restore.mock.calls.map(call => call[0])).toEqual(['a', 'b', 'b', 'c']);
  expect(restore.mock.calls[1]![1]).toBe(restore.mock.calls[2]![1]);
  expect(completed).toHaveBeenCalledTimes(1);
});
it('stops sibling writes and visible feedback when ownership ends during a reply', async () => {
  let current = true;
  const completed = vi.fn(),
    failed = vi.fn();
  const restore = vi.fn(async () => {
    current = false;
    return receipt('a');
  });
  const batch = createRestoreBatch({
    materialIds: ['a', 'b'],
    restore,
    current: () => current,
    completed,
    failed
  });
  expect(await batch.run()).toBe(false);
  expect(restore).toHaveBeenCalledTimes(1);
  expect(completed).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
});
