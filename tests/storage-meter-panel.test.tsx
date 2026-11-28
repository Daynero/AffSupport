// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SpaceStorageItem,
  SpaceStorageItemsPage,
  SpaceStorageSummary
} from '@video-compressor/shared';
import { spaceStorageLevel } from '@video-compressor/shared';
import { clearSpaceStorageCaches, rememberSpaceBackend } from '../apps/web/src/api/space-storage';
import { ToastProvider } from '../apps/web/src/components/toast';
import { publishSpaceStorageSignal } from '../apps/web/src/team/storage/spaceSignals';
import {
  StorageItemsList,
  STORAGE_TOP,
  type StorageItemsClient
} from '../apps/web/src/team/storage/StorageItemsList';
import { StorageMeterPanel } from '../apps/web/src/team/storage/StorageMeterPanel';
import {
  SpaceStorageWarning,
  spaceStorageNotice
} from '../apps/web/src/team/storage/SpaceStorageWarning';
import { clearSpaceStorageReads } from '../apps/web/src/team/storage/useSpaceStorage';

/**
 * 057 T056: the memory panel of an R2 space (US9.2–US9.5). It opens on the ten biggest of a
 * category and grows into the full list with a search and an order by size, date or author; a
 * thing opens where it is or is deleted from here; a catalog shows its three numbers; the places
 * that add bytes warn from 80 %, 95 % and 100 % with what they will take; a `usage` signal
 * redraws the scale without a reload. A Drive space shows none of it.
 */

const TEAM = '05791360-0000-4000-8000-0000000000aa';
const DRIVE = '05791360-0000-4000-8000-0000000000bb';
const GB = 1_000_000_000n;

function summary(usedGb: number, reservedGb = 0): SpaceStorageSummary {
  const used = BigInt(Math.round(usedGb * 1000)) * 1_000_000n;
  return {
    capacityBytes: 10n * GB,
    usedBytes: used,
    reservedBytes: BigInt(Math.round(reservedGb * 1000)) * 1_000_000n,
    revision: 1,
    poolBytes: 0n,
    segments: [
      { category: 'materials', bytes: used, objects: 1, sharedBytes: 0n },
      { category: 'catalogs', bytes: 0n, objects: 0, sharedBytes: 0n },
      { category: 'process', bytes: 0n, objects: 0, sharedBytes: 0n },
      { category: 'attachments', bytes: 0n, objects: 0, sharedBytes: 0n },
      { category: 'versions', bytes: 0n, objects: 0, sharedBytes: 0n },
      { category: 'trash', bytes: 0n, objects: 0, sharedBytes: 0n }
    ]
  };
}

function item(index: number, overrides: Partial<SpaceStorageItem> = {}): SpaceStorageItem {
  return {
    kind: 'file',
    id: `05791360-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name: `Clip ${index}.mp4`,
    bytes: BigInt(1000 - index),
    sharedBytes: 0n,
    freedBytes: BigInt(1000 - index),
    authorId: null,
    authorName: 'Owner',
    at: '2026-11-20T10:00:00Z',
    parentFolderId: '05791360-0000-4000-8000-0000000000f0',
    materialKind: 'video',
    mimeType: 'video/mp4',
    trashed: false,
    ...overrides
  };
}

function itemsClient(
  pages: (input: Parameters<StorageItemsClient['storageItems']>[0]) => SpaceStorageItemsPage
) {
  return {
    storageItems: vi.fn(async (input: Parameters<StorageItemsClient['storageItems']>[0]) =>
      pages(input)
    ),
    mutate: vi.fn(async () => ({})),
    emptyTrash: vi.fn(async () => ({}))
  } satisfies StorageItemsClient;
}

beforeEach(() => {
  localStorage.setItem('language', 'en');
  rememberSpaceBackend(TEAM, 'r2');
  rememberSpaceBackend(DRIVE, 'drive');
});
afterEach(() => {
  cleanup();
  clearSpaceStorageCaches();
  clearSpaceStorageReads();
  localStorage.clear();
});

describe('StorageItemsList', () => {
  it(
    'opens on the ten biggest, then the full list searches and sorts by size, date and author',
    { timeout: 30_000 },
    async () => {
      const client = itemsClient(input => {
        const all = Array.from({ length: 23 }, (_, index) => item(index));
        const found = input.search ? all.filter(row => row.name!.includes(input.search!)) : all;
        const start = Number(input.cursor ?? 0);
        const limit = input.limit ?? 50;
        return {
          category: 'materials',
          items: found.slice(start, start + limit),
          total: found.length,
          nextCursor: start + limit < found.length ? String(start + limit) : null
        };
      });
      render(
        <ToastProvider>
          <StorageItemsList teamId={TEAM} category="materials" revision={1} client={client} />
        </ToastProvider>
      );
      await waitFor(() =>
        expect(document.querySelectorAll('.space-storage-row')).toHaveLength(STORAGE_TOP)
      );
      expect(client.storageItems).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: 'materials', sort: 'size', limit: STORAGE_TOP })
      );
      expect(screen.getByRole('heading', { name: 'Materials: largest' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Full list · 23' }));
      await waitFor(() => expect(document.querySelectorAll('.space-storage-row')).toHaveLength(23));
      expect(client.storageItems).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'size', limit: 50 })
      );
      fireEvent.click(screen.getByRole('radio', { name: 'Date' }));
      await waitFor(() =>
        expect(client.storageItems).toHaveBeenLastCalledWith(
          expect.objectContaining({ sort: 'date' })
        )
      );
      fireEvent.click(screen.getByRole('radio', { name: 'Author' }));
      await waitFor(() =>
        expect(client.storageItems).toHaveBeenLastCalledWith(
          expect.objectContaining({ sort: 'author' })
        )
      );
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Clip 2' } });
      await waitFor(() =>
        expect(client.storageItems).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'Clip 2' })
        )
      );
      // Clip 2, 20, 21, 22.
      await waitFor(() => expect(document.querySelectorAll('.space-storage-row')).toHaveLength(4));
    }
  );

  it(
    'opens a thing where it is and deletes it from the list, to the trash or for good',
    { timeout: 30_000 },
    async () => {
      const onOpen = vi.fn();
      const client = itemsClient(() => ({
        category: 'materials',
        items: [item(1), item(2, { trashed: true, name: 'Old.mp4' })],
        total: 2,
        nextCursor: null
      }));
      render(
        <ToastProvider>
          <StorageItemsList
            teamId={TEAM}
            category="materials"
            revision={1}
            client={client}
            onOpen={onOpen}
            canDelete
          />
        </ToastProvider>
      );
      await waitFor(() => expect(document.querySelectorAll('.space-storage-row')).toHaveLength(2));
      fireEvent.click(screen.getAllByRole('button', { name: 'Open' })[0]!);
      expect(onOpen).toHaveBeenCalledWith({
        kind: 'file',
        id: item(1).id,
        parentFolderId: item(1).parentFolderId,
        trashed: false
      });
      fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
      const move = await screen.findAllByRole('button', { name: 'Move to trash' });
      expect(move).toHaveLength(2);
      fireEvent.click(move[move.length - 1]!);
      await waitFor(() =>
        expect(client.mutate).toHaveBeenCalledWith({
          teamId: TEAM,
          action: 'trash',
          materialIds: [item(1).id]
        })
      );
      fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
      const confirm = await screen.findAllByRole('button', { name: 'Delete forever' });
      fireEvent.click(confirm[confirm.length - 1]!);
      await waitFor(() => expect(client.emptyTrash).toHaveBeenCalledWith(TEAM, [item(2).id]));
    }
  );

  it('shows a catalog’s three numbers, and offers no delete for an attachment', async () => {
    const client = itemsClient(input =>
      input.category === 'catalogs'
        ? {
            category: 'catalogs',
            items: [
              item(1, {
                kind: 'catalog',
                name: 'Catalog one',
                bytes: 1700n,
                sharedBytes: 1500n,
                freedBytes: 200n
              })
            ],
            total: 1,
            nextCursor: null
          }
        : { category: 'attachments', items: [item(3)], total: 1, nextCursor: null }
    );
    render(
      <ToastProvider>
        <StorageItemsList
          teamId={TEAM}
          category="catalogs"
          revision={1}
          client={client}
          canDelete
        />
      </ToastProvider>
    );
    const catalog = await screen.findByRole('button', { name: 'Catalog one' });
    expect(screen.getByText('frees 200 B')).toBeTruthy();
    fireEvent.click(catalog);
    const numbers = screen.getByTestId('catalog-storage-breakdown');
    expect(numbers.textContent).toContain('Takes1.66 KB');
    expect(numbers.textContent).toContain('Shared — stays1.46 KB');
    expect(numbers.textContent).toContain('Deleting frees200 B');
    expect(screen.queryByRole('button', { name: 'Move to trash' })).toBeNull();
    cleanup();
    render(
      <ToastProvider>
        <StorageItemsList
          teamId={TEAM}
          category="attachments"
          revision={1}
          client={client}
          canDelete
        />
      </ToastProvider>
    );
    await screen.findByText('Clip 3.mp4');
    expect(screen.queryByRole('button', { name: 'Move to trash' })).toBeNull();
  });

  // 057 T124: the owner frees space from the list itself (US9.2, US10).
  it(
    'deletes a catalog the way its manager does, with what it frees and what stays, and a trashed one for good',
    { timeout: 30_000 },
    async () => {
      const onChanged = vi.fn();
      const catalog = item(1, {
        kind: 'catalog',
        name: 'Catalog one',
        bytes: 1700n,
        sharedBytes: 1500n,
        freedBytes: 200n
      });
      const trashed = item(2, {
        kind: 'catalog',
        name: 'Old catalog',
        trashed: true,
        sharedBytes: 0n
      });
      const library = item(3, {
        kind: 'library',
        id: null,
        name: null,
        sharedBytes: 900n,
        freedBytes: 0n
      });
      const client = itemsClient(() => ({
        category: 'catalogs',
        items: [catalog, trashed, library],
        total: 3,
        nextCursor: null
      }));
      render(
        <ToastProvider>
          <StorageItemsList
            teamId={TEAM}
            category="catalogs"
            revision={1}
            client={client}
            canDelete
            onChanged={onChanged}
          />
        </ToastProvider>
      );
      await waitFor(() => expect(document.querySelectorAll('.space-storage-row')).toHaveLength(3));
      // The shared library only shows what it holds.
      const libraryRow = document.querySelector('.space-storage-row[data-kind="library"]')!;
      expect(libraryRow.querySelectorAll('button')).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: 'Delete catalog' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('Delete catalog “Catalog one”?');
      expect(dialog.textContent).toContain('What only it holds (200 B)');
      expect(dialog.textContent).toContain('1.46 KB is shared');
      expect(dialog.textContent).not.toMatch(/Google|Drive/u);
      const confirm = await screen.findAllByRole('button', { name: 'Delete catalog' });
      fireEvent.click(confirm[confirm.length - 1]!);
      await waitFor(() =>
        expect(client.mutate).toHaveBeenCalledWith({
          teamId: TEAM,
          action: 'trash',
          materialIds: [catalog.id]
        })
      );
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: 'Delete forever' }));
      expect((await screen.findByRole('dialog')).textContent).toContain(
        'its feed, videos and variations'
      );
      const forever = await screen.findAllByRole('button', { name: 'Delete forever' });
      fireEvent.click(forever[forever.length - 1]!);
      await waitFor(() => expect(client.emptyTrash).toHaveBeenCalledWith(TEAM, [trashed.id]));
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    }
  );

  it('empties the whole trash with one confirmation, and only for someone who may delete', async () => {
    const onChanged = vi.fn();
    const client = itemsClient(() => ({
      category: 'trash',
      items: [item(1, { trashed: true }), item(2, { trashed: true })],
      total: 2,
      nextCursor: null
    }));
    const { rerender } = render(
      <ToastProvider>
        <StorageItemsList teamId={TEAM} category="trash" revision={1} client={client} />
      </ToastProvider>
    );
    await waitFor(() => expect(document.querySelectorAll('.space-storage-row')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Empty trash' })).toBeNull();
    rerender(
      <ToastProvider>
        <StorageItemsList
          teamId={TEAM}
          category="trash"
          revision={1}
          client={client}
          canDelete
          categoryBytes={1_997n}
          onChanged={onChanged}
        />
      </ToastProvider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Empty trash' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Empty the trash?');
    expect(dialog.textContent).toContain('Frees 1.95 KB at once');
    const confirm = await screen.findAllByRole('button', { name: 'Empty trash' });
    fireEvent.click(confirm[confirm.length - 1]!);
    await waitFor(() => expect(client.emptyTrash).toHaveBeenCalledWith(TEAM));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Trash emptied')).toBeTruthy();
  });
});

describe('Warnings where bytes are added', () => {
  it('says nothing below 80 %, warns from 80 %, more from 95 %, and refuses what cannot fit', async () => {
    expect(spaceStorageLevel({ usedBytes: 7n, reservedBytes: 0n, capacityBytes: 10n })).toBe('ok');
    expect(spaceStorageLevel({ usedBytes: 8n, reservedBytes: 0n, capacityBytes: 10n })).toBe(
      'warning'
    );
    expect(spaceStorageLevel({ usedBytes: 950n, reservedBytes: 0n, capacityBytes: 1000n })).toBe(
      'critical'
    );
    expect(
      spaceStorageLevel({ usedBytes: 5n, reservedBytes: 3n, capacityBytes: 10n, addBytes: 2n })
    ).toBe('full');

    const calm = { storageSummary: vi.fn(async () => summary(5)) };
    const { container } = render(
      <SpaceStorageWarning teamId={TEAM} addBytes={1_000_000} client={calm} />
    );
    await waitFor(() => expect(calm.storageSummary).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    cleanup();
    clearSpaceStorageReads();

    const nearly = { storageSummary: vi.fn(async () => summary(8.2)) };
    render(<SpaceStorageWarning teamId={TEAM} addBytes={500 * 1024 * 1024} client={nearly} />);
    const warning = await screen.findByRole('status');
    expect(warning.textContent).toContain('Almost full');
    expect(warning.textContent).toContain('Will take ≈ 500 MB');
    expect(screen.getByRole('button', { name: 'Free up space' })).toBeTruthy();
    cleanup();
    clearSpaceStorageReads();

    const tight = { storageSummary: vi.fn(async () => summary(9.6)) };
    render(<SpaceStorageWarning teamId={TEAM} client={tight} />);
    expect((await screen.findByRole('status')).textContent).toContain('Running out of space');
    cleanup();
    clearSpaceStorageReads();

    const full = { storageSummary: vi.fn(async () => summary(9, 0.5)) };
    render(<SpaceStorageWarning teamId={TEAM} addBytes={2 * 1024 * 1024 * 1024} client={full} />);
    const refused = await screen.findByRole('status');
    expect(refused.textContent).toContain('No space left');
    expect(refused.textContent).toContain('Won’t fit: needs ≈ 2 GB');
  });

  it('gives a drop on the explorer the same words, and nothing in a Drive space', async () => {
    const words = {
      t: (key: string, values?: Record<string, string | number>) =>
        `${key}${values ? JSON.stringify(values) : ''}`,
      bytes: (value: bigint | number) => `${value}`
    } as Parameters<typeof spaceStorageNotice>[2];
    const client = { storageSummary: vi.fn(async () => summary(9.9)) };
    const notice = await spaceStorageNotice(TEAM, 200_000_000, words, client);
    expect(notice?.level).toBe('full');
    expect(notice?.text).toContain('spaceStorageWarnWontFit');
    expect(await spaceStorageNotice(DRIVE, 200_000_000, words, client)).toBeNull();
    // A scale that cannot be read never holds an upload back.
    clearSpaceStorageReads();
    const broken = { storageSummary: vi.fn(async () => Promise.reject(new Error('offline'))) };
    expect(await spaceStorageNotice(TEAM, 1, words, broken)).toBeNull();
  });
});

describe('StorageMeterPanel', () => {
  it('redraws on a `usage` signal without a reload, and opens a category’s list', async () => {
    let used = 2;
    const client = { storageSummary: vi.fn(async () => summary(used)) };
    const items = itemsClient(() => ({
      category: 'materials',
      items: [item(1)],
      total: 1,
      nextCursor: null
    }));
    render(
      <ToastProvider>
        <StorageMeterPanel teamId={TEAM} client={client} itemsClient={items} compact={false} />
      </ToastProvider>
    );
    expect(await screen.findByText('Used 1.86 GB of 9.31 GB')).toBeTruthy();
    used = 4;
    act(() =>
      publishSpaceStorageSignal({ teamId: TEAM, kind: 'usage', folderId: null, revision: 2 })
    );
    expect(await screen.findByText('Used 3.73 GB of 9.31 GB')).toBeTruthy();
    expect(client.storageSummary).toHaveBeenCalledTimes(2);
    // A content signal is not a usage one.
    act(() =>
      publishSpaceStorageSignal({ teamId: TEAM, kind: 'content', folderId: null, revision: 3 })
    );
    expect(client.storageSummary).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: /^Materials · / }));
    expect(await screen.findByText('Clip 1.mp4')).toBeTruthy();
  });

  it('redraws the scale as soon as something is deleted from its list', async () => {
    let used = 2;
    const client = { storageSummary: vi.fn(async () => summary(used)) };
    const items = itemsClient(() => ({
      category: 'materials',
      items: [item(1)],
      total: 1,
      nextCursor: null
    }));
    items.mutate.mockImplementation(async () => {
      used = 1;
      return {};
    });
    render(
      <ToastProvider>
        <StorageMeterPanel
          teamId={TEAM}
          client={client}
          itemsClient={items}
          compact={false}
          initialCategory="materials"
          canDelete
        />
      </ToastProvider>
    );
    expect(await screen.findByText('Used 1.86 GB of 9.31 GB')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Move to trash' }));
    const confirm = await screen.findAllByRole('button', { name: 'Move to trash' });
    fireEvent.click(confirm[confirm.length - 1]!);
    // No signal was published: the list told the scale itself.
    expect(await screen.findByText('Used 954 MB of 9.31 GB')).toBeTruthy();
  });

  it('reads nothing for a Drive space', async () => {
    const client = { storageSummary: vi.fn(async () => summary(2)) };
    render(<SpaceStorageWarning teamId={DRIVE} client={client} />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(client.storageSummary).not.toHaveBeenCalled();
  });
});
