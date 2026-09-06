// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderPage, TeamMaterialRow, TeamMaterialTagColor } from '@video-compressor/shared';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { ContentList } from '../apps/web/src/team/explorer/ContentList';
import { useFolderPage } from '../apps/web/src/team/explorer/useFolderPage';
import { useExplorer } from '../apps/web/src/team/explorer/ExplorerProvider';
import { sortRows } from '../apps/web/src/team/explorer/sort';

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

/** Stands in for the shell, which is where the folder's page now lives. */
function List({
  client,
  revision
}: {
  client: { listFolderPage: ReturnType<typeof pages> };
  revision: number;
}) {
  const { currentFolderId } = useExplorer();
  const page = useFolderPage({ teamId: TEAM, client, parentFolderId: currentFolderId, revision });
  return <ContentList page={page} />;
}

function renderList(listFolderPage: ReturnType<typeof pages>, revision = 0) {
  const client = { listFolderTree: vi.fn().mockResolvedValue([]), listFolderPage };
  return render(
    <ExplorerProvider teamId={TEAM} client={client} revision={revision}>
      <List client={client} revision={revision} />
    </ExplorerProvider>
  );
}

/** The same list, with a preview handler, so opening a row has somewhere to go. */
function PreviewingList({
  client,
  onPreview
}: {
  client: { listFolderPage: ReturnType<typeof vi.fn> };
  onPreview: (material: { name: string }) => void;
}) {
  const { currentFolderId } = useExplorer();
  const page = useFolderPage({ teamId: TEAM, client, parentFolderId: currentFolderId });
  return <ContentList page={page} onPreview={onPreview} />;
}

/** The same list, with the tag control the space owner gets. */
function TaggableList({
  client,
  onSetTag
}: {
  client: { listFolderPage: ReturnType<typeof pages> };
  onSetTag: (row: TeamMaterialRow, color: TeamMaterialTagColor | null) => void;
}) {
  const { currentFolderId } = useExplorer();
  const page = useFolderPage({ teamId: TEAM, client, parentFolderId: currentFolderId });
  return <ContentList page={page} tagging={{ canTag: true, onSetTag }} />;
}

describe('selecting and opening a row', () => {
  it('takes one press to select and two to open', async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    const listFolderPage = vi.fn(async (): Promise<FolderPage> => ({
      rows: [
        row(0, { name: 'nested', kind: 'folder', driveFileId: 'drive-nested' }),
        row(1, { name: 'clip.png' })
      ],
      total: 2,
      next: null
    }));
    const client = { listFolderTree: vi.fn().mockResolvedValue([]), listFolderPage };
    render(
      <ExplorerProvider teamId={TEAM} client={client}>
        <PreviewingList client={client} onPreview={onPreview} />
      </ExplorerProvider>
    );
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));

    // The name is a label, not a target: nothing in the row opens on one press.
    await user.click(screen.getByText('clip.png'));
    expect(onPreview).not.toHaveBeenCalled();
    expect(screen.getAllByRole('listitem')[1]!.getAttribute('aria-selected')).toBe('true');

    await user.dblClick(screen.getByText('clip.png'));
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ name: 'clip.png' }));
  });
});

describe('file tags', () => {
  const tagged = () =>
    vi.fn(async (): Promise<FolderPage> => ({
      rows: [row(0, { tagColor: 'blue' }), row(1, { tagColor: null }), row(2, { tagColor: 'red' })],
      total: 3,
      next: null
    }));

  it('sets a colour from the dot, and takes it off when the same one is pressed', async () => {
    const user = userEvent.setup();
    const onSetTag = vi.fn();
    const listFolderPage = tagged();
    const client = { listFolderTree: vi.fn().mockResolvedValue([]), listFolderPage };
    render(
      <ExplorerProvider teamId={TEAM} client={client}>
        <TaggableList client={client} onSetTag={onSetTag} />
      </ExplorerProvider>
    );
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));

    // The untagged row: any colour is a colour to add.
    const untagged = screen.getAllByRole('listitem')[1]!;
    await user.click(within(untagged).getByRole('button', { name: /^Tag of file-001/ }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Green' }));
    expect(onSetTag).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'id-1' }), 'green');

    // The blue row, pressed on blue: Finder's own behaviour is to take it off.
    const blue = screen.getAllByRole('listitem')[0]!;
    await user.click(within(blue).getByRole('button', { name: /^Tag of file-000/ }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Blue' }));
    expect(onSetTag).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'id-0' }), null);
  });

  it('is not a control at all for anyone but the owner', async () => {
    const listFolderPage = tagged();
    const client = { listFolderTree: vi.fn().mockResolvedValue([]), listFolderPage };
    render(
      <ExplorerProvider teamId={TEAM} client={client}>
        <List client={client} revision={0} />
      </ExplorerProvider>
    );
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    // The colours are still read — two of the three rows carry one — and there
    // is nothing to press: a disabled button would still say "you could".
    expect(screen.getAllByRole('img', { name: /^Tag of/ })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Tag of/ })).toBeNull();
  });

  it('sorts by tag in the swatches' + "'" + ' own order, with the untagged last', () => {
    const rows = [
      row(0, { tagColor: null }),
      row(1, { tagColor: 'grey' }),
      row(2, { tagColor: 'red' }),
      row(3, { tagColor: 'green' })
    ];
    const byTag = sortRows(rows, { key: 'tag', direction: 'asc', foldersSeparate: false });
    expect(byTag.map(item => item.tagColor ?? 'none')).toEqual(['red', 'green', 'grey', 'none']);
    // Reversed, the colours turn round and the untagged still come last: "no
    // tag" is the absence of a value, not the far end of the scale.
    const reversed = sortRows(rows, { key: 'tag', direction: 'desc', foldersSeparate: false });
    expect(reversed.map(item => item.tagColor ?? 'none')).toEqual(['grey', 'green', 'red', 'none']);
  });
});

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
        <List client={client} revision={0} />
      </ExplorerProvider>
    );
    await screen.findByText('Items: 3');
    expect(listFolderPage).toHaveBeenCalledTimes(1);
    rerender(
      <ExplorerProvider teamId={TEAM} client={client} revision={1}>
        <List client={client} revision={1} />
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
