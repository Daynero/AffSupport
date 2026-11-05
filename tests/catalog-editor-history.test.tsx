// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CatalogUpdateAttempt, CatalogUpdateProfile } from '@video-compressor/shared';
import { CatalogProfileEditor } from '../apps/web/src/team/catalog-updater/CatalogProfileEditor';
import { CatalogStatusDetails } from '../apps/web/src/team/catalog-updater/CatalogStatusDetails';

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(cleanup);
const profile: CatalogUpdateProfile = {
  catalogId: 'catalog',
  version: 1,
  updatedAt: '',
  refreshImages: true,
  refreshTexts: true,
  randomLinkVariation: true,
  growProducts: false,
  restitch: false
};
it('keeps the draft and original expected version when server data refreshes', async () => {
  const save = vi.fn().mockResolvedValue(profile);
  const props = {
    catalogName: 'Catalog',
    interval: null,
    save,
    onSaved: vi.fn(),
    onClose: vi.fn()
  };
  const view = render(<CatalogProfileEditor {...props} profile={profile} />);
  fireEvent.click(screen.getAllByRole('checkbox')[0]);
  view.rerender(
    <CatalogProfileEditor {...props} profile={{ ...profile, version: 2, refreshTexts: false }} />
  );
  expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false);
  expect((screen.getAllByRole('checkbox')[2] as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(1, { randomLinkVariation: false }));
});
const attempt = (
  result: CatalogUpdateAttempt['result'],
  startedAt: string
): CatalogUpdateAttempt => ({
  attemptId: result,
  catalogId: 'catalog',
  trigger: 'manual',
  startedAt,
  endedAt: null,
  stage: null,
  result,
  failureCode: null,
  deliveryVerifiedAt: null
});
it('does not offer retry for an older failure after a newer success', async () => {
  const load = vi
    .fn()
    .mockResolvedValue([
      attempt('failed', '2026-10-17T10:00:00Z'),
      attempt('success', '2026-10-18T10:00:00Z')
    ]);
  render(
    <CatalogStatusDetails
      teamId="team"
      catalogId="catalog"
      load={load}
      onClose={vi.fn()}
      onRetry={vi.fn()}
    />
  );
  await screen.findByText('Updated');
  expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull();
});
it('retries the latest failed attempt even when history arrives out of order', async () => {
  const onRetry = vi.fn();
  const load = vi
    .fn()
    .mockResolvedValue([
      attempt('success', '2026-10-17T10:00:00Z'),
      attempt('failed', '2026-10-18T10:00:00Z')
    ]);
  render(
    <CatalogStatusDetails
      teamId="team"
      catalogId="catalog"
      load={load}
      onClose={vi.fn()}
      onRetry={onRetry}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Try again now' }));
  expect(onRetry).toHaveBeenCalledWith('failed');
});
it('keeps navigation guarded while saving and hands confirmed flow to the visible result owner', async () => {
  let resolveSave!: (value: CatalogUpdateProfile) => void;
  const save = vi.fn().mockImplementation(
    () =>
      new Promise<CatalogUpdateProfile>(resolve => {
        resolveSave = resolve;
      })
  );
  const onSaved = vi.fn();
  const onDirtyChange = vi.fn();
  const onPendingChange = vi.fn();
  const view = render(
    <CatalogProfileEditor
      catalogName="Catalog"
      profile={profile}
      interval={null}
      save={save}
      onSaved={onSaved}
      onClose={vi.fn()}
      onDirtyChange={onDirtyChange}
      onPendingChange={onPendingChange}
    />
  );
  fireEvent.click(screen.getAllByRole('checkbox')[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  expect(onPendingChange).toHaveBeenLastCalledWith(true);
  resolveSave(profile);
  await waitFor(() =>
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ complete: expect.any(Function), id: expect.any(String) }),
      profile,
      null
    )
  );
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  view.unmount();
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
});
it('locks retry while it is pending and refreshes history after acceptance', async () => {
  let accept!: () => void;
  const onRetry = vi.fn(
    () =>
      new Promise<void>(resolve => {
        accept = resolve;
      })
  );
  const load = vi
    .fn()
    .mockResolvedValueOnce([attempt('failed', '2026-10-18T10:00:00Z')])
    .mockResolvedValue([attempt('running', '2026-10-18T11:00:00Z')]);
  render(
    <CatalogStatusDetails
      teamId="team"
      catalogId="catalog"
      load={load}
      onClose={vi.fn()}
      onRetry={onRetry}
    />
  );
  const button = await screen.findByRole('button', { name: 'Try again now' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  accept();
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull());
});
it('clears the dirty draft when all changes are reverted', async () => {
  const onDirtyChange = vi.fn();
  render(
    <CatalogProfileEditor
      catalogName="Catalog"
      profile={profile}
      interval={null}
      save={vi.fn()}
      onSaved={vi.fn()}
      onClose={vi.fn()}
      onDirtyChange={onDirtyChange}
    />
  );
  const checkbox = screen.getAllByRole('checkbox')[0]!;
  fireEvent.click(checkbox);
  expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(checkbox);
  expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  expect(
    (screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled
  ).toBe(true);
});
it('shows delivered changes outside collapsed history details', async () => {
  const load = vi.fn().mockResolvedValue([
    {
      ...attempt('success', '2026-10-18T10:00:00Z'),
      deliveryVerifiedAt: '2026-10-18T10:01:00Z',
      actualChanges: { productIds: true }
    }
  ]);
  render(<CatalogStatusDetails teamId="team" catalogId="catalog" load={load} onClose={vi.fn()} />);
  const changes = await screen.findByText(/Confirmed in delivered result:/);
  expect(changes.closest('details')).toBeNull();
});

it('shows automatic confirmation as progress and refreshes details when it becomes successful', async () => {
  const pending = attempt('running', '2026-10-19T10:00:00Z');
  const load = vi.fn().mockResolvedValue([pending]);
  const props = { teamId: 'team', catalogId: 'catalog', load, onClose: vi.fn() };
  const view = render(<CatalogStatusDetails {...props} checkingDelivery />);
  await screen.findByText('Checking Drive confirmation…');
  expect(screen.queryByText('Unknown result')).toBeNull();
  expect(screen.getByText(/Waiting for Google Drive confirmation/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
  load.mockResolvedValue([
    { ...pending, result: 'success', failureCode: null, deliveryVerifiedAt: '2026-10-19T10:00:05Z' }
  ]);
  view.rerender(<CatalogStatusDetails {...props} checkingDelivery={false} />);
  await screen.findByText('Updated');
  expect(screen.queryByText('Checking Drive confirmation…')).toBeNull();
  expect(screen.queryByText(/Waiting for Google Drive confirmation/)).toBeNull();
});

it('retains a terminal failure reason even before the registry clears its checking flag', async () => {
  const failed = {
    ...attempt('failed', '2026-10-19T10:00:00Z'),
    failureCode: 'PERMISSION_DENIED',
    endedAt: '2026-10-19T10:00:05Z'
  };
  render(
    <CatalogStatusDetails
      teamId="team"
      catalogId="catalog"
      load={vi.fn().mockResolvedValue([failed])}
      onClose={vi.fn()}
      checkingDelivery
    />
  );
  await screen.findByText(/You do not have permission for this/);
  expect(screen.getByText(/Finished/)).toBeTruthy();
  expect(screen.queryByText('Checking Drive confirmation…')).toBeNull();
});

it('does not overlap confirmation history reads or allow older responses to replace success', async () => {
  let tick: (() => void) | undefined;
  const timer = vi.spyOn(window, 'setInterval').mockImplementation(callback => {
    tick = callback as () => void;
    return 1 as unknown as ReturnType<typeof window.setInterval>;
  });
  let finish!: (rows: CatalogUpdateAttempt[]) => void;
  const load = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<CatalogUpdateAttempt[]>(resolve => {
          finish = resolve;
        })
    )
    .mockResolvedValue([attempt('success', '2026-10-19T10:00:00Z')]);
  try {
    render(
      <CatalogStatusDetails
        teamId="team"
        catalogId="catalog"
        load={load}
        onClose={vi.fn()}
        checkingDelivery
      />
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      tick?.();
      tick?.();
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => finish([attempt('unknown', '2026-10-19T10:00:00Z')]));
    act(() => tick?.());
    await screen.findByText('Updated');
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Unknown result')).toBeNull();
  } finally {
    timer.mockRestore();
  }
});

it('bounds a hung history read and aborts it so the user can retry', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const load = vi.fn((_team: string, _catalog: string, options?: { signal?: AbortSignal }) => {
    signal = options?.signal;
    return new Promise<CatalogUpdateAttempt[]>(() => {});
  });
  try {
    render(
      <CatalogStatusDetails teamId="team" catalogId="catalog" load={load} onClose={() => {}} />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15001);
    });
    expect(screen.getByText('Could not load update history.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(signal?.aborted).toBe(true);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it('does not carry a late retry error from the previous catalog into the next history', async () => {
  let rejectRetry!: (error: Error) => void;
  const retry = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectRetry = reject;
      })
  );
  const load = vi.fn(async (_team: string, catalog: string) => [
    {
      ...attempt(catalog === 'a' ? 'failed' : 'success', '2026-11-05T10:00:00Z'),
      catalogId: catalog
    }
  ]);
  const props = { teamId: 'team', load, onClose: vi.fn(), onRetry: retry };
  const view = render(<CatalogStatusDetails {...props} catalogId="a" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Try again now' }));
  view.rerender(<CatalogStatusDetails {...props} catalogId="b" />);
  await screen.findByText('Updated');
  await act(async () => {
    rejectRetry(new Error('PERMISSION_DENIED'));
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull();
});

it('does not label an older running history row as the active attempt’s Drive confirmation', async () => {
  const load = vi
    .fn()
    .mockResolvedValue([
      { ...attempt('running', '2026-11-05T10:00:00Z'), attemptId: 'old-attempt' }
    ]);
  render(
    <CatalogStatusDetails
      teamId="team"
      catalogId="catalog"
      activeAttemptId="new-attempt"
      checkingDelivery
      load={load}
      onClose={vi.fn()}
    />
  );
  await screen.findByText('Updating');
  expect(screen.queryByText('Checking Drive confirmation…')).toBeNull();
  expect(screen.queryByText(/Waiting for Google Drive confirmation/)).toBeNull();
});

it('reads current history before allowing another retry after its reply is lost', async () => {
  let finishRead!: (rows: CatalogUpdateAttempt[]) => void;
  const failed = attempt('failed', '2026-11-05T10:00:00Z');
  const load = vi
    .fn()
    .mockResolvedValueOnce([failed])
    .mockImplementationOnce(
      () =>
        new Promise<CatalogUpdateAttempt[]>(resolve => {
          finishRead = resolve;
        })
    );
  const onRetry = vi.fn().mockRejectedValue(new TypeError('lost reply'));
  render(
    <CatalogStatusDetails
      teamId="team"
      catalogId="catalog"
      load={load}
      onRetry={onRetry}
      onClose={vi.fn()}
    />
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Try again now' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull();
  await act(async () => {
    finishRead([{ ...failed, attemptId: 'later', result: 'success' }]);
  });
  await screen.findByText('Updated');
  expect(onRetry).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Try again now' })).toBeNull();
});

it('resumes a canceled history read after a same-tick hide and refocus without waiting for another poll', async () => {
  let hidden = false;
  const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  let oldSignal: AbortSignal | undefined;
  const load = vi
    .fn()
    .mockImplementationOnce(
      (_team: string, _catalog: string, options?: { signal?: AbortSignal }) => {
        oldSignal = options?.signal;
        return new Promise<CatalogUpdateAttempt[]>(() => {});
      }
    )
    .mockResolvedValue([attempt('success', '2026-11-05T10:00:00Z')]);
  try {
    render(
      <CatalogStatusDetails teamId="team" catalogId="catalog" load={load} onClose={vi.fn()} />
    );
    await waitFor(() => expect(load).toHaveBeenCalledOnce());
    await act(async () => {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await screen.findByText('Updated');
    expect(oldSignal?.aborted).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  } finally {
    visibility.mockRestore();
  }
});
