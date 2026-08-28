// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderPage, TeamMaterialRow } from '@video-compressor/shared';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { ContentList } from '../apps/web/src/team/explorer/ContentList';

/**
 * Feature 011 (T024): the first screen and the total arrive together, the
 * next page appends behind a stable cursor, a realtime revision re-reads the
 * first page, and the provider is never asked for anything.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TEAM = 'team-1';

function row(index: number, overrides: Partial<TeamMaterialRow> = {}): TeamMaterialRow {
  return {
    id: `id-${index}`,
    teamId: TEAM,
    name: `file-${String(index).padStart(3, '0')}.png`,
    category: 'image',
    mimeType: 'image/png',
    fileExtension: 'png',
    sizeBytes: 1024 * index,
    kind: 'image',
    driveFileId: `drive-${index}`,
    parentFolderId: 'root',
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'pending',
    thumbnailReady: false,
    ...overrides
  };
}

function pages(total: number, size: number) {
  return vi.fn(
    async (_team: string, input: { after?: { id: string } | null }): Promise<FolderPage> => {
      const start = input.after ? Number(input.after.id.replace('id-', '')) + 1 : 0;
      const rows = Array.from({ length: Math.min(size, total - start) }, (_, i) => row(start + i));
      const last = rows.at(-1);
      return {
        rows,
        total,
        next:
          last && start + rows.length < total ? { sortKey: `1|${last.name}`, id: last.id } : null
      };
    }
  );
}

function renderList(listFolderPage: ReturnType<typeof pages>, revision = 0) {
  const client = { listFolderTree: vi.fn().mockResolvedValue([]), listFolderPage };
  return render(
    <ExplorerProvider teamId={TEAM} client={client} revision={revision}>
      <ContentList client={client} revision={revision} />
    </ExplorerProvider>
  );
}

describe('ContentList', () => {
  it('shows the first hundred rows with the total, then appends the next page', async () => {
    const user = userEvent.setup();
    const listFolderPage = pages(150, 100);
    renderList(listFolderPage);
    expect(await screen.findByText('Items: 150')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(100);
    expect(listFolderPage).toHaveBeenCalledWith(
      TEAM,
      expect.objectContaining({ parentFolderId: null, limit: 100 })
    );

    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(150));
    expect(listFolderPage).toHaveBeenLastCalledWith(
      TEAM,
      expect.objectContaining({ after: { sortKey: '1|file-099.png', id: 'id-99' } })
    );
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    // Order is the server's order, untouched by the append.
    const names = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(names[0]).toContain('file-000.png');
    expect(names[149]).toContain('file-149.png');
  });

  it('re-reads the first page when the revision moves, and never calls the provider', async () => {
    const listFolderPage = pages(3, 100);
    const client = { listFolderTree: vi.fn().mockResolvedValue([]), listFolderPage };
    const { rerender } = render(
      <ExplorerProvider teamId={TEAM} client={client} revision={0}>
        <ContentList client={client} revision={0} />
      </ExplorerProvider>
    );
    await screen.findByText('Items: 3');
    expect(listFolderPage).toHaveBeenCalledTimes(1);
    rerender(
      <ExplorerProvider teamId={TEAM} client={client} revision={1}>
        <ContentList client={client} revision={1} />
      </ExplorerProvider>
    );
    await waitFor(() => expect(listFolderPage).toHaveBeenCalledTimes(2));
    expect(listFolderPage).toHaveBeenLastCalledWith(TEAM, expect.objectContaining({ after: null }));
  });

  it('names every kind and explains the ones Soty cannot open', async () => {
    const listFolderPage = vi.fn(async (): Promise<FolderPage> => ({
      rows: [
        row(1, {
          name: 'Campaign',
          kind: 'folder',
          category: null,
          driveFileId: 'f-1'
        } as Partial<TeamMaterialRow>),
        row(2, {
          name: 'Brief',
          kind: 'document',
          mimeType: 'application/vnd.google-apps.document',
          category: null
        }),
        row(3, { name: 'Link', kind: 'shortcut', category: null }),
        row(4, { name: 'clip.mp4', kind: 'video', category: 'video', mimeType: 'video/mp4' })
      ],
      total: 4,
      next: null
    }));
    renderList(listFolderPage);
    await screen.findByText('Items: 4');
    expect(screen.getByText('Opens in Google Drive, not in Soty.')).toBeTruthy();
    expect(screen.getByText(/A shortcut/)).toBeTruthy();
    expect(screen.getByText('Video')).toBeTruthy();
    expect(screen.getByText('Folder')).toBeTruthy();
  });

  it('says the folder is empty rather than showing nothing', async () => {
    renderList(pages(0, 100));
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();
  });
});
