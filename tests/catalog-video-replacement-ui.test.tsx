// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CatalogVideoReplacementDialog } from '../apps/web/src/team/product-catalog/CatalogVideoReplacementDialog';
import type { CatalogVideoReplacementClient } from '../apps/web/src/api/catalog-video-replacement';
import { setPrivateCacheScope } from '../apps/web/src/team/private-cache-scope';
import { WorkspaceMutationJournal } from '../apps/web/src/team/workspace/mutationJournal';
import type {
  CatalogVideoReplacementContext,
  CatalogVideoReplacementReceipt
} from '@video-compressor/shared';
vi.mock('../apps/web/src/team/tasks/TaskAttachmentPicker', () => ({
  TaskAttachmentPicker: ({
    onAdd,
    trigger
  }: {
    onAdd: (v: unknown[]) => void;
    trigger: (open: () => void) => React.ReactNode;
  }) => trigger(() => onAdd([{ id: video, name: 'New video', category: 'video' }]))
}));
const actor = 'cf540000-0000-4000-8000-000000000001',
  team = 'cf540000-0000-4000-8000-000000000002',
  catalog = 'cf540000-0000-4000-8000-000000000003',
  video = 'cf540000-0000-4000-8000-000000000004';
const context: CatalogVideoReplacementContext = {
  teamId: team,
  catalogId: catalog,
  catalogName: 'Catalog',
  currentVideoId: 'cf540000-0000-4000-8000-000000000005',
  currentVideoName: 'Original video',
  version: 'v1',
  blockedReason: null,
  active: null
};
const receipt = (
  id: string,
  state: CatalogVideoReplacementReceipt['state'] = 'publishing'
): CatalogVideoReplacementReceipt => ({
  teamId: team,
  catalogId: catalog,
  requestId: id,
  newVideoId: video,
  state,
  errorCode: null
});
function fixture() {
  const changed = vi.fn(),
    close = vi.fn();
  let last = '';
  let reads = 0;
  const client: CatalogVideoReplacementClient = {
    context: vi.fn(async () => context),
    submit: vi.fn(async request => {
      last = request.requestId;
      return receipt(last);
    }),
    status: vi.fn(async request =>
      receipt(request.requestId, reads++ === 0 ? 'publishing' : 'confirmed')
    )
  };
  const props = {
    teamId: team,
    catalogId: catalog,
    open: true,
    onChanged: changed,
    onClose: close,
    client
  };
  return { client, changed, props };
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('language', 'en');
  setPrivateCacheScope(actor, 'replacement-ui');
});
afterEach(() => {
  cleanup();
  setPrivateCacheScope(null, 'ended');
  vi.restoreAllMocks();
  localStorage.clear();
});
it('defaults to moving the catalog and shows success only after the confirmed status', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const view = render(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByText('Original video');
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Choose a new video' }));
  await user.click(screen.getByRole('button', { name: 'Change video' }));
  await screen.findByText(/Replacement accepted/);
  expect(f.client.submit).toHaveBeenCalledWith(
    expect.objectContaining({ newVideoId: video, moveToVideoFolder: true, expectedActorId: actor }),
    expect.any(AbortSignal)
  );
  expect(screen.queryByText(/Video replaced\./)).toBeNull();
  await screen.findByText(/Video replaced\./, {}, { timeout: 3000 });
  expect(f.client.submit).toHaveBeenCalledTimes(1);
  view.rerender(<CatalogVideoReplacementDialog {...f.props} open={false} />);
  view.rerender(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByRole('button', { name: 'Choose a new video' });
  expect(screen.queryByText(/Video replaced\./)).toBeNull();
});
it('restores an unanswered durable request after remount without submitting another mutation', async () => {
  const user = userEvent.setup(),
    f = fixture();
  let finish!: (r: CatalogVideoReplacementReceipt) => void;
  vi.mocked(f.client.submit).mockImplementationOnce(
    request =>
      new Promise(resolve => {
        finish = resolve;
        vi.mocked(f.client.status).mockResolvedValue(receipt(request.requestId, 'confirmed'));
      })
  );
  const first = render(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByText('Original video');
  await user.click(screen.getByRole('button', { name: 'Choose a new video' }));
  await user.click(screen.getByRole('button', { name: 'Change video' }));
  await waitFor(() => expect(f.client.submit).toHaveBeenCalledTimes(1));
  first.unmount();
  const id = vi.mocked(f.client.submit).mock.calls[0]![0].requestId;
  render(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByText(/Video replaced\./);
  await act(async () => finish(receipt(id)));
  expect(f.client.submit).toHaveBeenCalledTimes(1);
  expect(f.client.status).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: id }),
    expect.any(AbortSignal)
  );
});
it('explains an unsupported publication before offering the video picker', async () => {
  const f = fixture();
  vi.mocked(f.client.context).mockResolvedValue({ ...context, blockedReason: 'legacy' });
  render(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByText(/verified immediate publication first/);
  expect(screen.queryByRole('button', { name: 'Choose a new video' })).toBeNull();
  expect(f.client.submit).not.toHaveBeenCalled();
});
it('does not seal an absent command while its submission is still in flight', async () => {
  const user = userEvent.setup(),
    f = fixture();
  let finish!: (r: CatalogVideoReplacementReceipt) => void;
  vi.mocked(f.client.submit).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const view = render(<CatalogVideoReplacementDialog {...f.props} revision="first" />);
  await screen.findByText('Original video');
  await user.click(screen.getByRole('button', { name: 'Choose a new video' }));
  await user.click(screen.getByRole('button', { name: 'Change video' }));
  view.rerender(<CatalogVideoReplacementDialog {...f.props} revision="another-catalog-event" />);
  await act(async () => Promise.resolve());
  expect(f.client.status).not.toHaveBeenCalled();
  const id = vi.mocked(f.client.submit).mock.calls[0]![0].requestId;
  await act(async () => finish(receipt(id)));
  await screen.findByText(/Replacement accepted/);
  await screen.findByText(/Video replaced\./, {}, { timeout: 3000 });
});
it('checks a request started in another tab instead of submitting this draft under its identity', async () => {
  const user = userEvent.setup(),
    f = fixture();
  render(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByText('Original video');
  await user.click(screen.getByRole('button', { name: 'Choose a new video' }));
  const otherTab = new WorkspaceMutationJournal(
    'catalog-video-replacement',
    actor,
    team,
    localStorage
  );
  const pending = otherTab.acquire([catalog]);
  vi.mocked(f.client.status).mockResolvedValue(receipt(pending.id, 'confirmed'));
  await user.click(screen.getByRole('button', { name: 'Change video' }));
  expect(f.client.submit).not.toHaveBeenCalled();
  await screen.findByText(/Video replaced\./, {}, { timeout: 3000 });
  expect(f.client.status).toHaveBeenCalledWith(
    expect.objectContaining({ requestId: pending.id }),
    expect.any(AbortSignal)
  );
});
it('explains a sealed absent request and uses a fresh identity for a deliberate retry', async () => {
  const user = userEvent.setup(),
    f = fixture();
  const journal = new WorkspaceMutationJournal(
    'catalog-video-replacement',
    actor,
    team,
    localStorage
  );
  const old = journal.acquire([catalog]);
  vi.mocked(f.client.status).mockResolvedValue(null);
  render(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByText(/This request was not accepted/);
  await screen.findByRole('button', { name: 'Choose a new video' });
  expect(f.client.submit).not.toHaveBeenCalled();
  vi.mocked(f.client.status).mockImplementation(async request => receipt(request.requestId));
  await user.click(screen.getByRole('button', { name: 'Choose a new video' }));
  await user.click(screen.getByRole('button', { name: 'Change video' }));
  await screen.findByText(/Replacement accepted/);
  expect(vi.mocked(f.client.submit).mock.calls[0]![0].requestId).not.toBe(old.id);
});
it('automatically reconciles a lost submission reply and a transient status failure without resubmitting', async () => {
  const user = userEvent.setup(),
    f = fixture();
  vi.mocked(f.client.submit).mockRejectedValueOnce(new Error('Network connection lost'));
  vi.mocked(f.client.status)
    .mockRejectedValueOnce(new Error('Temporary read failure'))
    .mockImplementation(async request => receipt(request.requestId, 'confirmed'));
  render(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByText('Original video');
  await user.click(screen.getByRole('button', { name: 'Choose a new video' }));
  await user.click(screen.getByRole('button', { name: 'Change video' }));
  await screen.findByText(/Video replaced\./, {}, { timeout: 3000 });
  expect(f.client.submit).toHaveBeenCalledTimes(1);
  expect(f.client.status).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull();
});
it('automatically notices another tab’s durable request on storage invalidation', async () => {
  const f = fixture();
  render(<CatalogVideoReplacementDialog {...f.props} />);
  await screen.findByText('Original video');
  const journal = new WorkspaceMutationJournal(
    'catalog-video-replacement',
    actor,
    team,
    localStorage
  );
  const pending = journal.acquire([catalog]);
  vi.mocked(f.client.status).mockResolvedValue(receipt(pending.id, 'confirmed'));
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-setting' })));
  await act(async () => Promise.resolve());
  expect(f.client.status).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new StorageEvent('storage')));
  await screen.findByText(/Video replaced\./);
  expect(f.client.submit).not.toHaveBeenCalled();
  expect(f.changed).toHaveBeenCalledTimes(1);
});
