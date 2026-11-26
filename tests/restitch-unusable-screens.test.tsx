// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestitchPoolSummary, RestitchSourcesListing } from '@video-compressor/shared';

/**
 * The files a re-stitch pool cannot use, as the settings show them (2026-11-26). Soty has
 * already stopped drawing them; what is worth proving here is that their owner is told how
 * many there are and which, in words that say what to do, and that a server from before the
 * field — or one that sends something odd — changes nothing about the pool.
 */

const { ToastProvider } = await import('../apps/web/src/components/toast');
const { RestitchSourcePool } = await import('../apps/web/src/team/workspace/RestitchSourcePool');
const { parseUnusableScreens, unusableScreensOf, withUnusableScreens } =
  await import('../apps/web/src/team/workspace/restitch/unusable-screens');

const TEAM_ID = '30000000-0000-4000-8000-0000000000bb';

function pool(overrides: Partial<RestitchPoolSummary> = {}): RestitchPoolSummary {
  return {
    state: 'ready',
    overLimit: false,
    eligibleCount: 2,
    sources: [
      {
        materialId: 'm-folder',
        driveFileId: null,
        kind: 'folder',
        name: 'Screens',
        availability: 'available',
        imageCount: 2,
        skipped: { format: 0, size: 0, animated: 0 }
      }
    ],
    ...overrides
  };
}

function listing(): RestitchSourcesListing {
  return {
    sourceMode: 'drive',
    legacyImageCount: 0,
    pools: { start: pool(), end: pool({ eligibleCount: 0, state: 'empty', sources: [] }) }
  };
}

const UNUSABLE = {
  count: 3,
  items: [
    {
      materialId: 'u-1',
      name: '._images (13) 1.png',
      folderName: 'Screens',
      sizeBytes: 180,
      reason: 'service_file'
    },
    {
      materialId: 'u-2',
      name: 'depositphotos play.jpg',
      folderName: '',
      sizeBytes: 11_124,
      reason: 'undecodable'
    },
    {
      materialId: 'u-3',
      name: 'blank.png',
      folderName: 'Screens',
      sizeBytes: 90,
      reason: 'not_an_image'
    }
  ]
};

beforeEach(() => {
  localStorage.setItem('language', 'en');
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function renderPool(value: RestitchPoolSummary) {
  render(
    <ToastProvider>
      <RestitchSourcePool
        teamId={TEAM_ID}
        slot="start"
        pool={value}
        editable
        client={{ listMaterials: vi.fn().mockResolvedValue([]) }}
        onChange={vi.fn()}
      />
    </ToastProvider>
  );
}

describe('reading the field off the wire', () => {
  it('hangs each pool’s unusable files on that pool and leaves the other as it was', () => {
    const parsed = listing();
    const read = withUnusableScreens(parsed, {
      pools: { start: { unusable: UNUSABLE }, end: { unusable: { count: 0, items: [] } } }
    });
    expect(unusableScreensOf(read.pools.start)).toEqual(UNUSABLE);
    expect(unusableScreensOf(read.pools.end)).toEqual({ count: 0, items: [] });
    // A pool with nothing unusable is the very object the shared parser returned.
    expect(read.pools.end).toBe(parsed.pools.end);
    expect(read.pools.start).toMatchObject(parsed.pools.start);
  });

  it('reads a server from before the field as "nothing unusable"', () => {
    const parsed = listing();
    for (const raw of [undefined, null, {}, { pools: null }, { pools: { start: {} } }, 'text']) {
      const read = withUnusableScreens(parsed, raw);
      expect(read.pools.start).toBe(parsed.pools.start);
      expect(unusableScreensOf(read.pools.start).count).toBe(0);
    }
    expect(unusableScreensOf(null).count).toBe(0);
  });

  it('drops what it cannot read and never loses the count', () => {
    expect(
      parseUnusableScreens({
        count: 250,
        items: [
          UNUSABLE.items[0],
          { materialId: '', name: 'no id.png', reason: 'service_file' },
          { materialId: 'x', name: '', reason: 'service_file' },
          'not an item',
          {
            materialId: 'new',
            name: 'later.png',
            sizeBytes: -5,
            reason: 'a reason from the future'
          }
        ]
      })
    ).toEqual({
      count: 250,
      items: [
        UNUSABLE.items[0],
        { materialId: 'new', name: 'later.png', folderName: '', sizeBytes: null, reason: 'unknown' }
      ]
    });
    // A count that undersells the list is the list's length.
    expect(parseUnusableScreens({ count: 0, items: [UNUSABLE.items[0]] }).count).toBe(1);
    expect(parseUnusableScreens({ count: 'many', items: 'none' })).toEqual({ count: 0, items: [] });
  });
});

describe('the pool in the settings', () => {
  it('says nothing when every file of the pool is usable', () => {
    renderPool(pool());
    expect(screen.queryByText(/cannot be used/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show the list' })).toBeNull();
  });

  it('says how many files it cannot use and what to do, with the names one press away', async () => {
    renderPool({ ...pool(), unusable: UNUSABLE } as RestitchPoolSummary);
    expect(screen.getByText('3 files cannot be used')).toBeTruthy();
    expect(screen.getByText(/remove or replace them in Google Drive/)).toBeTruthy();
    // The pool's own line stays the one live region and still counts only usable pictures.
    expect(screen.getByRole('status').textContent).toContain('2 pictures in the selection pool');
    const toggle = screen.getByRole('button', { name: 'Show the list' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await userEvent.setup().click(toggle);
    expect(
      screen.getByRole('button', { name: 'Hide the list' }).getAttribute('aria-expanded')
    ).toBe('true');
    const rows = within(screen.getByRole('list', { name: 'Files that cannot be stitched' }))
      .getAllByRole('listitem')
      .map(row => row.textContent);
    expect(rows).toEqual([
      '._images (13) 1.pngFolder “Screens” · A system service file, not a picture',
      'depositphotos play.jpgDoes not open as a picture',
      'blank.pngFolder “Screens” · Not an image'
    ]);
  });

  it('says so when the list is only the first of many', async () => {
    renderPool({
      ...pool(),
      unusable: { count: 230, items: UNUSABLE.items }
    } as RestitchPoolSummary);
    expect(screen.getByText('230 files cannot be used')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Show the list' }));
    expect(screen.getByText('Showing the first 3 of 230.')).toBeTruthy();
  });

  it('has words for a reason a newer server may send, and for a count without names', () => {
    renderPool({
      ...pool(),
      unusable: {
        count: 1,
        items: [
          { materialId: 'n', name: 'new.png', folderName: '', sizeBytes: null, reason: 'unknown' }
        ]
      }
    } as RestitchPoolSummary);
    expect(screen.getByText('Cannot be used as a screen')).toBeTruthy();
    cleanup();
    renderPool({ ...pool(), unusable: { count: 7, items: [] } } as RestitchPoolSummary);
    expect(screen.getByText('7 files cannot be used')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show the list' })).toBeNull();
  });

  it('speaks Ukrainian in the product’s own words', () => {
    localStorage.setItem('language', 'uk');
    renderPool({ ...pool(), unusable: UNUSABLE } as RestitchPoolSummary);
    expect(screen.getByText('Непридатних файлів: 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Показати список' })).toBeTruthy();
  });
});
