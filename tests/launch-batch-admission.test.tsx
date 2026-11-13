// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LaunchBatch } from '../apps/web/src/team/launches/LaunchBatch.js';
import { launchBatchApi } from '../apps/web/src/api/launch-batches.js';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope.js';
import {
  launchBatchAdmission,
  launchObservedGeneration
} from '../apps/web/src/team/launches/analytics.js';
import { batchCommand, batchReceipt, batchUuid } from './fixtures/launch-batches.js';
import type { LaunchBatchCommand } from '@video-compressor/shared';
vi.mock('../apps/web/src/team/launches/analytics.js', () => ({
  launchBatchAdmission: vi.fn(),
  launchObservedGeneration: vi.fn()
}));
function props(command: LaunchBatchCommand | null = batchCommand()) {
  return {
    teamId: batchUuid(1),
    actorId: batchUuid(2),
    command,
    enabled: true,
    reconcileEpoch: 0,
    onSubmitted: vi.fn(),
    onChange: vi.fn(),
    onOpen: vi.fn(),
    onPendingChange: vi.fn(),
    onSubmissionPendingChange: vi.fn(),
    onBatches: vi.fn()
  };
}
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  setPrivateCacheScope(batchUuid(2), 'team');
  vi.spyOn(launchBatchApi, 'read').mockResolvedValue(null);
  vi.spyOn(launchBatchApi, 'submit').mockImplementation(async command => batchReceipt(command));
  vi.spyOn(launchBatchApi, 'list').mockResolvedValue({
    items: [],
    hasMore: false,
    nextCursor: null
  });
  vi.spyOn(launchBatchApi, 'cancel').mockImplementation(async (_team, key) => ({
    ...batchReceipt(),
    requestKey: key,
    cancelRequestedAt: new Date().toISOString()
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setPrivateCacheScope(null, '');
});
it('accepts four account intents in one immutable command under StrictMode, without browser media workers', async () => {
  const input = props();
  render(
    <StrictMode>
      <LaunchBatch {...input} />
    </StrictMode>
  );
  await waitFor(() => expect(input.onSubmitted).toHaveBeenCalledWith(input.command!.requestKey));
  expect(launchBatchApi.submit).toHaveBeenCalledOnce();
  expect(launchBatchApi.submit).toHaveBeenCalledWith(input.command, expect.any(AbortSignal));
  expect(
    await screen.findByRole('button', {
      name: 'Nutra Balance · g1 · Ad account 781 · Preparing launch…'
    })
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: /check status/i })).toBeNull();
  expect(
    localStorage.getItem(`soty:launch-batch-outbox:${input.actorId}:${input.teamId}`)
  ).toBeNull();
});
it('shows eight ready children beside two refused/deleted children and can open each result', async () => {
  const command = batchCommand(10),
    receipt = batchReceipt(command, 'succeeded');
  receipt.items = receipt.items.map((item, n) =>
    n < 2
      ? {
          ...item,
          admission: 'refused',
          generationId: null,
          generation: null,
          errorCode: 'NOT_FOUND'
        }
      : item
  );
  vi.mocked(launchBatchApi.submit).mockResolvedValue(receipt);
  const input = props(command);
  render(<LaunchBatch {...input} />);
  await waitFor(() => expect(input.onSubmitted).toHaveBeenCalledOnce());
  expect(screen.getByText('Batch · 10 of 10 finished')).toBeTruthy();
  expect(await screen.findAllByRole('button', { name: / · Ready$/ })).toHaveLength(8);
  fireEvent.click(
    screen.getByRole('button', { name: 'Nutra Balance · g3 · Ad account 783 · Ready' })
  );
  expect(input.onOpen).toHaveBeenCalledWith(command.items[2].launchId);
  expect(launchBatchApi.cancel).not.toHaveBeenCalled();
});
it('restores server batches on re-entry without another generate command', async () => {
  vi.mocked(launchBatchApi.list).mockResolvedValue({
    items: [batchReceipt()],
    hasMore: false,
    nextCursor: null
  });
  const input = props(null);
  render(<LaunchBatch {...input} />);
  await screen.findByRole('button', { name: /Nutra Balance · g1/ });
  expect(launchBatchApi.submit).not.toHaveBeenCalled();
  expect(input.onPendingChange).toHaveBeenLastCalledWith(true);
});
it('keeps pending video work observable after the parent catalog has succeeded', async () => {
  const receipt = batchReceipt(undefined, 'succeeded');
  receipt.items[0].generation!.videoGeneration = {
    setId: batchUuid(900),
    state: 'preparing',
    requestedCount: 5,
    registeredCount: 2
  };
  vi.mocked(launchBatchApi.list).mockResolvedValue({
    items: [receipt],
    hasMore: false,
    nextCursor: null
  });
  const input = props(null);
  render(<LaunchBatch {...input} />);
  await screen.findByRole('button', { name: /Nutra Balance · g1.*Preparing launch/ });
  expect(input.onPendingChange).toHaveBeenLastCalledWith(true);
  expect(screen.getByText(/Videos ready: 2 of 5/i)).toBeTruthy();
});
it('does not duplicate admission analytics as generation state versions change', async () => {
  const receipt = batchReceipt();
  vi.mocked(launchBatchApi.list).mockResolvedValue({
    items: [receipt],
    hasMore: false,
    nextCursor: null
  });
  const input = props(null),
    view = render(<LaunchBatch {...input} />);
  await screen.findByRole('button', { name: /Nutra Balance · g1/ });
  expect(launchBatchAdmission).toHaveBeenCalledTimes(4);
  vi.mocked(launchBatchApi.list).mockResolvedValue({
    items: [
      {
        ...receipt,
        items: receipt.items.map(item => ({
          ...item,
          generation: { ...item.generation!, stateVersion: '2' }
        }))
      }
    ],
    hasMore: false,
    nextCursor: null
  });
  view.rerender(<LaunchBatch {...input} reconcileEpoch={1} />);
  await waitFor(() => expect(launchObservedGeneration).toHaveBeenCalledTimes(8));
  expect(launchBatchAdmission).toHaveBeenCalledTimes(4);
});
it('cancels by one stable request, retains completed siblings and confirms cancellation automatically', async () => {
  vi.mocked(launchBatchApi.list).mockResolvedValue({
    items: [batchReceipt()],
    hasMore: false,
    nextCursor: null
  });
  const input = props(null);
  render(<LaunchBatch {...input} />);
  const button = await screen.findByRole('button', { name: /cancel unfinished/i });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(launchBatchApi.cancel).toHaveBeenCalledOnce());
  expect(vi.mocked(launchBatchApi.cancel).mock.calls[0]?.slice(0, 2)).toEqual([
    input.teamId,
    batchCommand().requestKey
  ]);
  await act(async () => {});
  expect(screen.getByRole('button', { name: /canceling/i }).hasAttribute('disabled')).toBe(true);
});
