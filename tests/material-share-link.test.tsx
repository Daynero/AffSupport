// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import React, { type ReactNode } from 'react';
const { share, push, begin, complete, reportError } = vi.hoisted(() => ({
  share: vi.fn(),
  push: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  reportError: vi.fn()
}));
vi.mock('../apps/web/src/analytics/service', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/analytics/service')>()),
  startTeamFileAttempt: begin,
  completeTeamFileAttempt: complete
}));
vi.mock('../apps/web/src/api/team', () => ({ teamApi: { shareLibraryMaterial: share } }));
vi.mock('../apps/web/src/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../apps/web/src/components/toast', () => ({ useToasts: () => ({ push }) }));
vi.mock('../apps/web/src/team/catalog/useMaterialActions', () => ({
  useMaterialActions: () => ({ busy: false }),
  analyticsOutcome: () => 'failure',
  retryableError: () => false,
  reportFileAttemptError: reportError
}));
vi.mock('../apps/web/src/team/catalog/FolderPicker', () => ({ FolderPicker: () => null }));
vi.mock('../apps/web/src/team/materials/MaterialNote', () => ({ MaterialNoteDialog: () => null }));
vi.mock('../apps/web/src/components/ui/index', () => ({
  Modal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  FormField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />
}));
import { useMaterialActionHost } from '../apps/web/src/team/materials/MaterialActionHost';
function Harness({ teamId = 'team' }: { teamId?: string }) {
  const host = useMaterialActionHost({
    teamId,
    storageKind: 'shared_drive',
    surface: 'catalog_manager',
    material: {
      id: 'catalog',
      teamId,
      name: 'catalog.csv',
      kind: 'file',
      category: 'other',
      availability: 'ready'
    },
    permissions: {
      upload: true,
      process: true,
      download: true,
      view: true,
      edit: true,
      delete: true,
      manage_members: true,
      manage_metadata: true
    },
    browseClient: {} as never,
    onChanged: () => undefined
  });
  return (
    <>
      <button onClick={host.handlers.copyLink}>get-link</button>
      {host.dialogs}
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const url = 'https://drive.google.com/file/d/catalog/view';
function clipboard() {
  const writeText = vi.fn().mockRejectedValue(new Error('denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}
it('keeps the URL selectable and retries only clipboard copying after denial', async () => {
  const write = clipboard();
  share.mockResolvedValue({ state: 'ready', url });
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  expect(screen.getByDisplayValue(url)).toHaveProperty('readOnly', true);
  fireEvent.click(screen.getByText('materialActionCopyLink'));
  await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  expect(share).toHaveBeenCalledTimes(1);
  expect(push).not.toHaveBeenCalledWith(expect.objectContaining({ tone: 'success' }));
});
it('serializes double clicks before the first request settles', async () => {
  clipboard();
  let resolve!: (value: unknown) => void;
  share.mockReturnValue(
    new Promise(r => {
      resolve = r;
    })
  );
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  fireEvent.click(screen.getByText('get-link'));
  expect(share).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ state: 'ready', url }));
});
it('retains the request key after a lost response and hides late results from another team', async () => {
  clipboard();
  share.mockRejectedValueOnce(new Error('lost')).mockResolvedValue({ state: 'ready', url });
  const view = render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await waitFor(() => expect(push).toHaveBeenCalled());
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  expect(share.mock.calls[0][0].idempotencyKey).toBe(share.mock.calls[1][0].idempotencyKey);
  view.rerender(<Harness teamId="other" />);
  expect(screen.queryByDisplayValue(url)).toBeNull();
});

it('records one correlated share lifecycle after the selectable result appears, even if clipboard is denied', async () => {
  clipboard();
  const attempt = { attemptId: 'attempt', completed: false };
  begin.mockReturnValue(attempt);
  share.mockResolvedValue({ state: 'ready', url });
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await screen.findByDisplayValue(url);
  await waitFor(() =>
    expect(complete).toHaveBeenCalledWith(attempt, { outcome: 'success', retryable: false })
  );
  expect(begin).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'share',
      storageKind: 'shared_drive',
      surface: 'catalog_manager'
    })
  );
  expect(complete).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('materialActionCopyLink'));
  expect(share).toHaveBeenCalledTimes(1);
  expect(begin).toHaveBeenCalledTimes(1);
});
it('keeps the failed share cause correlated to the same attempt', async () => {
  const attempt = { attemptId: 'failed-attempt', completed: false };
  begin.mockReturnValue(attempt);
  const error = new Error('DRIVE_UNAVAILABLE');
  share.mockRejectedValue(error);
  render(<Harness />);
  fireEvent.click(screen.getByText('get-link'));
  await waitFor(() => expect(reportError).toHaveBeenCalledWith(attempt, error));
  expect(complete).toHaveBeenCalledWith(attempt, { outcome: 'failure', retryable: false });
});
