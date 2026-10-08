// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderPage, TeamFolderNode } from '@video-compressor/shared';
import { ExplorerProvider, useExplorer } from '../apps/web/src/team/explorer/ExplorerProvider';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';
import { deferred } from './fixtures/catalog-sync';

/**
 * 028 — a sync that finishes behind a Realtime refresh. The strict read the
 * finished job waits for loses the race to the background read the event
 * started; the background read is the one that paints the screen, so its
 * answer is the one to report. "Could not sync" after a successful sync was
 * this race.
 */

afterEach(cleanup);

const node: TeamFolderNode = {
  id: 'a',
  driveFileId: 'a',
  parentFolderId: null,
  selectionId: null,
  name: 'a',
  indexedAt: '2026-10-07T00:00:00Z',
  childFolderCount: 0,
  childFileCount: 0,
  thumbnailReadyCount: 0
};

function Probe({ onReady }: { onReady: (explorer: ReturnType<typeof useExplorer>) => void }) {
  const explorer = useExplorer();
  onReady(explorer);
  return null;
}

describe('ExplorerProvider.refreshStrict', () => {
  it('a strict refresh superseded by a background read resolves with the newer read instead of failing', async () => {
    const first = deferred<TeamFolderNode[]>();
    const strict = deferred<TeamFolderNode[]>();
    const background = deferred<TeamFolderNode[]>();
    const listFolderTree = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(strict.promise)
      .mockReturnValueOnce(background.promise);
    const client = { listFolderTree };
    const onReady = (value: ReturnType<typeof useExplorer>) => {
      explorer = value;
    };
    let explorer!: ReturnType<typeof useExplorer>;
    const view = render(
      <ExplorerProvider teamId="team-1" client={client} revision={0}>
        <Probe onReady={onReady} />
      </ExplorerProvider>
    );
    await act(async () => first.resolve([node]));
    let settled: 'ok' | 'rejected' | null = null;
    let pending!: Promise<void>;
    await act(async () => {
      pending = explorer.refreshStrict().then(
        () => void (settled = 'ok'),
        () => void (settled = 'rejected')
      );
    });
    // A Realtime event bumps the revision: the debounced background read supersedes the strict one.
    view.rerender(
      <ExplorerProvider teamId="team-1" client={client} revision={1}>
        <Probe onReady={onReady} />
      </ExplorerProvider>
    );
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
    });
    expect(listFolderTree).toHaveBeenCalledTimes(3);
    await act(async () => strict.resolve([node]));
    expect(settled).toBeNull();
    await act(async () =>
      background.resolve([node, { ...node, id: 'b', driveFileId: 'b', name: 'b' }])
    );
    await act(async () => pending);
    expect(settled).toBe('ok');
    expect(explorer.nodes?.map(item => item.name)).toEqual(['a', 'b']);
  });

  it('a strict refresh fails only when the newest read failed', async () => {
    const first = deferred<TeamFolderNode[]>();
    const strict = deferred<TeamFolderNode[]>();
    const background = deferred<TeamFolderNode[]>();
    const listFolderTree = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(strict.promise)
      .mockReturnValueOnce(background.promise);
    const client = { listFolderTree };
    const onReady = (value: ReturnType<typeof useExplorer>) => {
      explorer = value;
    };
    let explorer!: ReturnType<typeof useExplorer>;
    const view = render(
      <ExplorerProvider teamId="team-1" client={client} revision={0}>
        <Probe onReady={onReady} />
      </ExplorerProvider>
    );
    await act(async () => first.resolve([node]));
    let settled: 'ok' | 'rejected' | null = null;
    let pending!: Promise<void>;
    await act(async () => {
      pending = explorer.refreshStrict().then(
        () => void (settled = 'ok'),
        () => void (settled = 'rejected')
      );
    });
    view.rerender(
      <ExplorerProvider teamId="team-1" client={client} revision={1}>
        <Probe onReady={onReady} />
      </ExplorerProvider>
    );
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 600));
    });
    await act(async () => strict.resolve([node]));
    await act(async () => background.reject(new Error('offline')));
    await act(async () => pending);
    expect(settled).toBe('rejected');
  });
});

describe('useFolderPage.reloadStrict', () => {
  const page = (names: string[]): FolderPage => ({
    rows: names.map(name => ({ id: name, name }) as FolderPage['rows'][number]),
    total: names.length,
    next: null
  });

  it('a superseded strict reload resolves once the newer window has painted', async () => {
    const first = deferred<FolderPage>();
    const strict = deferred<FolderPage>();
    const background = deferred<FolderPage>();
    let calls = 0;
    const listFolderPage = vi.fn(() => {
      calls += 1;
      if (calls > 3) throw new Error('UNEXPECTED_FOURTH_READ');
      return calls === 1 ? first.promise : calls === 2 ? strict.promise : background.promise;
    });
    // One client object for the hook's lifetime, as the app passes it.
    const client = { listFolderPage };
    const hook = renderHook(
      ({ revision }) => useFolderPage({ teamId: 'team-1', client, parentFolderId: 'a', revision }),
      { initialProps: { revision: 0 } }
    );
    await act(async () => first.resolve(page(['one'])));
    let settled: 'ok' | 'rejected' | null = null;
    let pending!: Promise<void>;
    await act(async () => {
      pending = hook.result.current.reloadStrict().then(
        () => void (settled = 'ok'),
        () => void (settled = 'rejected')
      );
    });
    hook.rerender({ revision: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(listFolderPage).toHaveBeenCalledTimes(3);
    await act(async () => strict.resolve(page(['one'])));
    expect(settled).toBeNull();
    await act(async () => background.resolve(page(['one', 'two'])));
    await act(async () => pending);
    expect(settled).toBe('ok');
    expect(hook.result.current.rows.map(row => row.name)).toEqual(['one', 'two']);
  });
});
