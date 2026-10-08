// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncStatusPanel } from '../apps/web/src/team/explorer/SyncStatusPanel';
import type { FolderSyncState, FolderSyncStatus } from '../apps/web/src/team/syncStatus';

afterEach(cleanup);

const NOW = Date.parse('2026-10-07T10:30:00Z');

function status(
  state: FolderSyncState,
  overrides: Partial<FolderSyncStatus> = {}
): FolderSyncStatus {
  const terminal = state === 'succeeded' || state === 'failed' || state === 'canceled';
  return {
    jobId: 'c0ffee00-0000-4000-8000-000000000001',
    requestId: 'req',
    scopeFolderId: 'doctors',
    state,
    phase: terminal ? 'done' : 'listing',
    blockedReason: state === 'blocked' ? 'canonical_failed' : null,
    errorCode: null,
    errorDetail: null,
    nextAttemptAt: null,
    startedAt: '2026-10-07T10:12:00Z',
    lastProgressAt: '2026-10-07T10:28:00Z',
    scanCompletedAt: null,
    completedAt: null,
    filesListed: 40,
    filesAdded: 3,
    filesUpdated: 1,
    filesRemoved: 0,
    itemsUnavailable: 0,
    foldersDone: 4,
    pendingFolders: 6,
    coverage: 'unknown',
    progressRevision: 4,
    cancelable: !terminal,
    sharedWith: 0,
    ...overrides
  };
}

describe('SyncStatusPanel', () => {
  it.each([
    ['queued', 'Queued'],
    ['running', 'Syncing'],
    ['retry_wait', 'Waiting to retry'],
    ['blocked', 'Blocked'],
    ['canceling', 'Stopping'],
    ['canceled', 'Stopped'],
    ['succeeded', 'Done'],
    ['failed', 'Failed']
  ] as const)('renders the %s state', (state, label) => {
    render(<SyncStatusPanel status={status(state)} scopeName="Doctors" now={NOW} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Sync status for Doctors' })).toBeTruthy();
  });

  it('shows absolute progress and no invented percentage when the total is unknown', () => {
    render(
      <SyncStatusPanel
        status={status('running', { pendingFolders: null })}
        scopeName="Doctors"
        now={NOW}
      />
    );
    expect(screen.getByText('4 folders done · 40 files seen')).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
  });

  it('summarises the result in numbers: changes, none, partial', () => {
    const { rerender } = render(
      <SyncStatusPanel status={status('succeeded')} scopeName="Doctors" now={NOW} />
    );
    expect(screen.getByText('Added 3, updated 1, removed 0')).toBeTruthy();
    rerender(
      <SyncStatusPanel
        status={status('succeeded', { filesAdded: 0, filesUpdated: 0 })}
        scopeName="Doctors"
        now={NOW}
      />
    );
    expect(screen.getByText('No changes')).toBeTruthy();
    rerender(
      <SyncStatusPanel
        status={status('succeeded', { itemsUnavailable: 2 })}
        scopeName="Doctors"
        now={NOW}
      />
    );
    expect(screen.getByText(/^Partial: added 3, updated 1, removed 0; 2 item/)).toBeTruthy();
  });

  it('offers Stop only while cancelable, with a hint when the job is shared', () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <SyncStatusPanel
        status={status('running', { sharedWith: 2 })}
        scopeName="Doctors"
        onCancel={onCancel}
        now={NOW}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Shared with 2')).toBeTruthy();
    rerender(
      <SyncStatusPanel
        status={status('running', { cancelable: false })}
        scopeName="Doctors"
        onCancel={onCancel}
        now={NOW}
      />
    );
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('names the reason and the action when blocked or failed, and offers a retry', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <SyncStatusPanel status={status('blocked')} scopeName="Doctors" onRetry={onRetry} now={NOW} />
    );
    expect(screen.getByRole('status').textContent).toContain(
      'change feed for this storage has stopped'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sync again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(
      <SyncStatusPanel
        status={status('failed', { errorCode: 'CANONICAL_FAILED', errorDetail: 'NEEDS_REAUTH' })}
        scopeName="Doctors"
        onRetry={onRetry}
        now={NOW}
      />
    );
    expect(screen.getByRole('status').textContent).toContain('asks the owner to reconnect');
  });

  it('announces the state once, not every file, and copies the diagnostic id', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { rerender, container } = render(
      <SyncStatusPanel status={status('running')} scopeName="Doctors" now={NOW} />
    );
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('Doctors: Syncing');
    rerender(
      <SyncStatusPanel
        status={status('running', { filesListed: 41, progressRevision: 5 })}
        scopeName="Doctors"
        now={NOW}
      />
    );
    expect(live.textContent).toBe('Doctors: Syncing');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('18 min ago')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('c0ffee00'));
  });
});
