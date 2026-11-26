// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamFolderNode } from '@video-compressor/shared';
import { useAttachmentFolders } from '../apps/web/src/team/tasks/useAttachmentFolders';

function folder(driveFileId: string, name: string, parentFolderId: string | null): TeamFolderNode {
  return {
    id: `row-${driveFileId}`,
    driveFileId,
    parentFolderId,
    selectionId: null,
    name,
    indexedAt: '2026-11-26T00:00:00Z',
    childFolderCount: 0,
    childFileCount: 0,
    thumbnailReadyCount: 0
  };
}

const TREE = [
  folder('creo', 'Creo', null),
  folder('launches', 'Launches', 'creo'),
  folder('gluco', 'GlucoSoft', 'launches')
];

function setup(
  parents: Promise<Map<string, string | null>>,
  tree: Promise<TeamFolderNode[]> = Promise.resolve(TREE)
) {
  const client = {
    listTaskAttachmentFolders: vi.fn(() => parents),
    listFolderTree: vi.fn(() => tree)
  };
  const view = renderHook(
    ({ materialKey }) =>
      useAttachmentFolders({
        teamId: 'team',
        taskId: 'task',
        materialKey,
        rootLabel: 'Space',
        client
      }),
    { initialProps: { materialKey: 'a' } }
  );
  return { client, view };
}

afterEach(cleanup);

describe('where a task’s files live', () => {
  it('names each attached file by its folder path, and the root by the space', async () => {
    const { view } = setup(
      Promise.resolve(
        new Map<string, string | null>([
          ['deep', 'gluco'],
          ['top', null]
        ])
      )
    );
    expect(view.result.current.settled).toBe(false);
    await waitFor(() => expect(view.result.current.settled).toBe(true));
    await waitFor(() =>
      expect(view.result.current.pathOf('deep')).toBe('Creo / Launches / GlucoSoft')
    );
    expect(view.result.current.pathOf('top')).toBe('Space');
    // A file the read did not mention has no path yet, rather than a wrong one.
    expect(view.result.current.pathOf('unknown')).toBeNull();
    expect(view.result.current.parentOf('deep')).toBe('gluco');
  });

  it('gives the picker the trail from the top down to a file’s folder or to a folder', async () => {
    const { view } = setup(Promise.resolve(new Map([['deep', 'gluco']])));
    await waitFor(() => expect(view.result.current.trailOf('deep')).toHaveLength(3));
    expect(view.result.current.trailOf('deep').map(step => step.name)).toEqual([
      'Creo',
      'Launches',
      'GlucoSoft'
    ]);
    expect(view.result.current.trailTo('launches')).toEqual([
      { id: 'creo', name: 'Creo' },
      { id: 'launches', name: 'Launches' }
    ]);
    expect(view.result.current.trailTo(null)).toEqual([]);
    expect(view.result.current.trailOf('unknown')).toEqual([]);
  });

  it('stops at a folder that loops back on itself instead of walking forever', async () => {
    const loop = [folder('a', 'A', 'b'), folder('b', 'B', 'a')];
    const { view } = setup(Promise.resolve(new Map([['file', 'a']])), Promise.resolve(loop));
    await waitFor(() => expect(view.result.current.trailOf('file')).toHaveLength(2));
    expect(view.result.current.trailTo('a').map(step => step.id)).toEqual(['b', 'a']);
  });

  it('counts a failed read as settled, so the picker does not wait for paths that will not come', async () => {
    const { view } = setup(
      Promise.reject(new Error('offline')),
      Promise.reject(new Error('offline'))
    );
    await waitFor(() => expect(view.result.current.settled).toBe(true));
    expect(view.result.current.pathOf('anything')).toBeNull();
    expect(view.result.current.folders.size).toBe(0);
  });

  it('reads again when the attached files change, and is unsettled until it has', async () => {
    let release: (value: Map<string, string | null>) => void = () => undefined;
    const { client, view } = setup(Promise.resolve(new Map([['deep', 'gluco']])));
    await waitFor(() => expect(view.result.current.settled).toBe(true));
    client.listTaskAttachmentFolders.mockReturnValueOnce(
      new Promise(resolve => {
        release = resolve;
      })
    );
    view.rerender({ materialKey: 'b' });
    expect(view.result.current.settled).toBe(false);
    expect(client.listTaskAttachmentFolders).toHaveBeenCalledTimes(2);
    await act(async () => release(new Map([['other', 'creo']])));
    await waitFor(() => expect(view.result.current.settled).toBe(true));
    expect(view.result.current.pathOf('other')).toBe('Creo');
    // The tree is the space's, not the task's: it is read once.
    expect(client.listFolderTree).toHaveBeenCalledTimes(1);
  });

  it('ignores an answer that arrives after it was unmounted', async () => {
    let release: (value: Map<string, string | null>) => void = () => undefined;
    const { view } = setup(
      new Promise(resolve => {
        release = resolve;
      })
    );
    view.unmount();
    await act(async () => release(new Map([['late', 'creo']])));
    expect(view.result.current.settled).toBe(false);
  });
});
