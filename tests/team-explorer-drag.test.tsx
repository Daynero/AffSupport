// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderPage, TeamMaterialRow } from '@video-compressor/shared';
import { ExplorerProvider, useExplorer } from '../apps/web/src/team/explorer/ExplorerProvider';
import { ContentList } from '../apps/web/src/team/explorer/ContentList';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';

/**
 * Dragging files onto a folder moves them (024): the ticked files go together, and a folder in
 * the list takes the drop, not only the tree.
 */

const TEAM = 'team-1';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function row(id: string, name: string, overrides: Partial<TeamMaterialRow> = {}): TeamMaterialRow {
  return {
    id,
    teamId: TEAM,
    name,
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    sizeBytes: 1024,
    kind: 'video',
    driveFileId: `drive-${id}`,
    parentFolderId: 'root',
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'pending',
    thumbnailReady: false,
    ...overrides
  };
}

const ROWS = [
  row('folder', 'Launches', { kind: 'folder', category: null, mimeType: null, sizeBytes: null }),
  row('a', 'a.mp4'),
  row('b', 'b.mp4'),
  row('c', 'c.mp4')
];

const client = {
  listFolderPage: vi.fn(async (): Promise<FolderPage> => ({ rows: ROWS, total: 4, next: null }))
};

function List({ onDrop }: { onDrop?: (folder: string, ids: string[]) => void }) {
  const { currentFolderId } = useExplorer();
  const page = useFolderPage({ teamId: TEAM, client, parentFolderId: currentFolderId });
  return <ContentList page={page} onDropMaterials={onDrop} />;
}

function transfer() {
  const data = new Map<string, string>();
  return {
    data,
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    get types() {
      return [...data.keys()];
    },
    setDragImage: vi.fn(),
    effectAllowed: 'all',
    dropEffect: 'none'
  };
}

function renderList(onDrop?: (folder: string, ids: string[]) => void) {
  render(
    <ExplorerProvider teamId={TEAM} client={{ listFolderTree: vi.fn().mockResolvedValue([]) }}>
      <List onDrop={onDrop} />
    </ExplorerProvider>
  );
}

const rowNamed = (name: string) => screen.getByText(name).closest('[role="row"]') as HTMLElement;

describe('dragging files onto a folder', () => {
  it('moves the ticked files together onto a folder in the list', async () => {
    const onDrop = vi.fn();
    renderList(onDrop);
    await screen.findByText('a.mp4');
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes.find(box => rowNamed('a.mp4').contains(box))!);
    fireEvent.click(boxes.find(box => rowNamed('c.mp4').contains(box))!);

    const dataTransfer = transfer();
    fireEvent.dragStart(rowNamed('c.mp4'), { dataTransfer });
    expect(dataTransfer.setDragImage).toHaveBeenCalled();
    fireEvent.dragOver(rowNamed('Launches'), { dataTransfer });
    await waitFor(() => expect(rowNamed('Launches').className).toContain('is-drop-target'));
    fireEvent.drop(rowNamed('Launches'), { dataTransfer });

    expect(onDrop).toHaveBeenCalledWith('drive-folder', ['a', 'c']);
  });

  it('drags only the row under the pointer when it is not ticked', async () => {
    const onDrop = vi.fn();
    renderList(onDrop);
    await screen.findByText('b.mp4');
    const dataTransfer = transfer();
    fireEvent.dragStart(rowNamed('b.mp4'), { dataTransfer });
    fireEvent.drop(rowNamed('Launches'), { dataTransfer });
    expect(onDrop).toHaveBeenCalledWith('drive-folder', ['b']);
  });

  it('makes nothing draggable for a reader who may not move files', async () => {
    renderList(undefined);
    await screen.findByText('a.mp4');
    expect(rowNamed('a.mp4').getAttribute('draggable')).toBeNull();
  });
});
