// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderSubtree, TeamMaterialSummary } from '../apps/web/src/api/team';
import { FolderScopeDialog } from '../apps/web/src/team/explorer/FolderScopeDialog';
import { ToastProvider } from '../apps/web/src/components/toast';

const TEAM = '22222222-2222-4222-8222-222222222222';
const FOLDER = { driveFileId: 'drive-root', name: 'spy joints' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function video(index: number): TeamMaterialSummary {
  return {
    id: `video-${index}`,
    teamId: TEAM,
    providerId: `drive-video-${index}`,
    parentFolderId: FOLDER.driveFileId,
    name: `clip-${index}.mp4`,
    kind: 'file',
    category: 'video'
  } as TeamMaterialSummary;
}

function show(subtree: Partial<FolderSubtree>) {
  const onResolved = vi.fn();
  const listFolderSubtree = vi.fn().mockResolvedValue({
    videos: [],
    landings: [],
    foldersVisited: 1,
    truncated: false,
    ...subtree
  } satisfies FolderSubtree);
  render(
    <ToastProvider>
      <FolderScopeDialog
        teamId={TEAM}
        folder={FOLDER}
        intent="process"
        client={{ listFolderSubtree }}
        onResolved={onResolved}
        onClose={vi.fn()}
      />
    </ToastProvider>
  );
  return { onResolved, listFolderSubtree };
}

/**
 * Reading a folder before the batch opens.
 *
 * The answer is handed over only when there is one. An empty hand-off is not a
 * small batch: with no ids the server reads the request as the whole space, so
 * a folder that yielded nothing would quietly start everything in it.
 */
describe('the folder scope window', () => {
  it('asks once and hands over what it found', async () => {
    const { onResolved, listFolderSubtree } = show({ videos: [video(1)] });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    // One read for the whole subtree; this used to be one per folder.
    expect(listFolderSubtree).toHaveBeenCalledTimes(1);
    expect(listFolderSubtree).toHaveBeenCalledWith(TEAM, FOLDER.driveFileId);
    expect(onResolved.mock.calls[0]![0].videos).toHaveLength(1);
  });

  it('says a folder is empty only when the read actually reached the end', async () => {
    const { onResolved } = show({ foldersVisited: 500, truncated: true });
    expect(
      await screen.findByText(
        'Stopped after 500 folders without reaching any files. Open a folder further in and start there.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Process what was found' })).toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('offers what a truncated read did reach, and says it was cut short', async () => {
    const { onResolved } = show({
      videos: [video(1), video(2)],
      foldersVisited: 500,
      truncated: true
    });
    expect(await screen.findByRole('button', { name: 'Process what was found' })).toBeTruthy();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('refuses an over-large folder even when the read was cut short', async () => {
    // Six hundred videos, and the read stopped at its ceiling. Offering
    // "process what was found" here would hand the server a scope it refuses,
    // and the person would read "Частина даних некоректна" in a window with no
    // fields.
    const { onResolved } = show({
      videos: Array.from({ length: 600 }, (_, index) => video(index)),
      foldersVisited: 500,
      truncated: true
    });
    expect(
      await screen.findByText(
        '600 files here — more than one batch can take (500). Run the subfolders one at a time, or the whole space.'
      )
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Process what was found' })).toBeNull();
    expect(onResolved).not.toHaveBeenCalled();
  });
});
