// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { ContentGrid } from '../apps/web/src/team/explorer/ContentGrid';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { MaterialRank } from '../apps/web/src/team/ranks/MaterialRank';
import {
  CreativeRankDemoteError,
  type CreativeRank
} from '../apps/web/src/team/ranks/creativeRanks';
import type { CreativeRanksState } from '../apps/web/src/team/ranks/useCreativeRanks';

/**
 * Feature 059: a video's honey league on its tile and in its card, and the owner's way down.
 */

/** The card's own league line — the ladder below names every league too. */
const LEAGUE = { selector: '.creative-rank-card-league' };

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const rank = (patch: Partial<CreativeRank> = {}): CreativeRank => ({
  materialId: 'v1',
  launchCount: 16,
  rankCredit: 16,
  lastLaunchedAt: daysAgo(3),
  version: 4,
  demotion: null,
  ...patch
});

const row = (id: string, name: string, patch: Partial<TeamMaterialRow> = {}): TeamMaterialRow =>
  ({
    id,
    teamId: 'team-1',
    name,
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    sizeBytes: 1000,
    kind: 'video',
    driveFileId: `drive-${id}`,
    parentFolderId: 'folder-1',
    modifiedAt: '2026-09-17T10:00:00.000Z',
    driveVersion: '1',
    previewState: 'ready',
    thumbnailReady: false,
    ...patch
  }) as TeamMaterialRow;

const page = {
  rows: [],
  total: 3,
  loading: false,
  error: false,
  hasMore: false,
  loadMore: vi.fn(),
  reload: vi.fn()
} as never;

function grid(ranks: CreativeRanksState, rows: TeamMaterialRow[]) {
  return render(
    <ExplorerProvider teamId="team-1" client={{ listFolderTree: vi.fn().mockResolvedValue([]) }}>
      <ContentGrid
        page={page}
        rows={rows}
        ranks={ranks}
        client={{ thumbnailUrl: () => null, openSession: async () => null } as never}
      />
    </ExplorerProvider>
  );
}

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('a tile', () => {
  it('shows the league, its state and the exact facts', () => {
    grid({ ranks: new Map([['v1', rank()]]), known: true, now: NOW }, [row('v1', 'clip.mp4')]);
    const emblem = screen.getByRole('img', { name: 'Rank: Gold, fresh' });
    expect(emblem.getAttribute('src')).toBe('/creative-ranks/4_gold_fresh-128.webp');
    expect(screen.getByText('16 launches · 3 days ago')).toBeTruthy();
  });

  it('marks a single launch as Wax', () => {
    grid(
      {
        ranks: new Map([
          ['v1', rank({ rankCredit: 1, launchCount: 1, lastLaunchedAt: daysAgo(1) })]
        ]),
        known: true,
        now: NOW
      },
      [row('v1', 'clip.mp4')]
    );
    expect(screen.getByRole('img', { name: 'Rank: Wax, fresh' })).toBeTruthy();
    expect(screen.getByText('1 launch · yesterday')).toBeTruthy();
  });

  it('ranks an image the same way as a video', () => {
    grid({ ranks: new Map([['i1', rank({ materialId: 'i1' })]]), known: true, now: NOW }, [
      row('i1', 'banner.png', {
        kind: 'image',
        category: 'image',
        mimeType: 'image/png',
        fileExtension: 'png'
      } as never)
    ]);
    expect(screen.getByRole('img', { name: 'Rank: Gold, fresh' })).toBeTruthy();
  });

  it('leaves a video never launched unmarked, and invents no date', () => {
    grid({ ranks: new Map(), known: true, now: NOW }, [row('v1', 'clip.mp4')]);
    expect(screen.queryByRole('img', { name: /Rank:/ })).toBeNull();
    expect(screen.queryByText(/launch/)).toBeNull();
  });

  it('gathers cobwebs on the emblem, never on the text', () => {
    grid(
      {
        ranks: new Map([
          ['v1', rank({ rankCredit: 6, launchCount: 6, lastLaunchedAt: daysAgo(70) })]
        ]),
        known: true,
        now: NOW
      },
      [row('v1', 'clip.mp4')]
    );
    expect(screen.getByRole('img', { name: 'Rank: Silver, in cobwebs' })).toBeTruthy();
    expect(screen.getByText(/^6 launches · /).className).toBe('creative-rank-facts');
  });

  it('draws nothing while ranks are unknown, and nothing on what is not a video', () => {
    grid({ ranks: new Map(), known: false, now: NOW }, [row('v1', 'clip.mp4')]);
    expect(screen.queryByRole('img', { name: /Rank:/ })).toBeNull();
    cleanup();
    grid({ ranks: new Map(), known: true, now: NOW }, [
      row('f1', 'Folder', { kind: 'folder', category: 'folder', mimeType: null } as never)
    ]);
    expect(screen.queryByRole('img', { name: /Rank:/ })).toBeNull();
  });
});

describe('the card', () => {
  it('lets the owner lower a rank with a reason, keeping the launch count', async () => {
    const demoteCreativeRank = vi.fn(async () => rank({ rankCredit: 6, version: 5 }));
    render(
      <MaterialRank
        teamId="team-1"
        materialId="v1"
        isOwner
        ranksRevision={0}
        client={{
          listCreativeRanks: vi.fn(async () => new Map([['v1', rank()]])),
          demoteCreativeRank
        }}
      />
    );
    expect(await screen.findByText('Gold', LEAGUE)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Lower the rank' }));
    await user.click(await screen.findByRole('menuitem', { name: /Disappointed/ }));
    await waitFor(() => expect(screen.getByText('Silver', LEAGUE)).toBeTruthy());
    expect(demoteCreativeRank).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'disappointed', targetCredit: 6, expectedVersion: 4 })
    );
    expect(screen.getByText(/^16 launches · /)).toBeTruthy();
    // The ladder: five leagues with their thresholds, the current one marked, the next one's
    // distance in launches of league credit.
    const ladder = screen.getByRole('list', { name: 'Leagues by launches' });
    expect(
      within(ladder)
        .getAllByRole('listitem')
        .map(step => step.textContent)
    ).toEqual(['Wax1+', 'Bronze3+', 'Silver6+', 'Gold12+', 'Diamond25+']);
    expect(ladder.querySelector('[aria-current="step"]')?.textContent).toBe('Silver6+');
    expect(screen.getByText('Gold in 6 launches')).toBeTruthy();
  });

  it('retries an unanswered demotion with the same key', async () => {
    const demoteCreativeRank = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(rank({ rankCredit: 6, version: 5 }));
    render(
      <MaterialRank
        teamId="team-1"
        materialId="v1"
        isOwner
        ranksRevision={0}
        client={{
          listCreativeRanks: vi.fn(async () => new Map([['v1', rank()]])),
          demoteCreativeRank
        }}
      />
    );
    const user = userEvent.setup();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await user.click(await screen.findByRole('button', { name: 'Lower the rank' }));
      await user.click(await screen.findByRole('menuitem', { name: /Disappointed/ }));
      await waitFor(() => expect(demoteCreativeRank).toHaveBeenCalledTimes(attempt + 1));
    }
    const keys = demoteCreativeRank.mock.calls.map(
      call => (call[0] as { requestKey: string }).requestKey
    );
    expect(keys[0]).toBe(keys[1]);
    await waitFor(() => expect(screen.getByText('Silver', LEAGUE)).toBeTruthy());
  });

  it('says "No rank" without an emblem for a creative never launched', async () => {
    render(
      <MaterialRank
        teamId="team-1"
        materialId="v1"
        isOwner
        ranksRevision={0}
        client={{ listCreativeRanks: vi.fn(async () => new Map()), demoteCreativeRank: vi.fn() }}
      />
    );
    expect(await screen.findByText('No rank', LEAGUE)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Rank:/ })).toBeNull();
    expect(screen.getByText('Not launched yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lower the rank' })).toBeNull();
  });

  it('lowers a Wax creative to no rank', async () => {
    const demoteCreativeRank = vi.fn(async () => rank({ rankCredit: 0, version: 5 }));
    render(
      <MaterialRank
        teamId="team-1"
        materialId="v1"
        isOwner
        ranksRevision={0}
        client={{
          listCreativeRanks: vi.fn(async () => new Map([['v1', rank({ rankCredit: 2 })]])),
          demoteCreativeRank
        }}
      />
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Lower the rank' }));
    await user.click(await screen.findByRole('menuitem', { name: /Disappointed/ }));
    expect(demoteCreativeRank).toHaveBeenCalledWith(expect.objectContaining({ targetCredit: 0 }));
    await waitFor(() => expect(screen.getByText('No rank', LEAGUE)).toBeTruthy());
  });

  it('lets the owner raise a demoted rank back, one league per press, launches untouched', async () => {
    // 20 launches earned Gold; the owner had lowered it to Bronze (credit 3).
    const demoted = rank({ launchCount: 20, rankCredit: 3, version: 6 });
    const promoteCreativeRank = vi
      .fn()
      .mockResolvedValueOnce(rank({ launchCount: 20, rankCredit: 6, version: 7 }))
      .mockResolvedValueOnce(rank({ launchCount: 20, rankCredit: 20, version: 8 }));
    render(
      <MaterialRank
        teamId="team-1"
        materialId="v1"
        isOwner
        ranksRevision={0}
        client={{
          listCreativeRanks: vi.fn(async () => new Map([['v1', demoted]])),
          demoteCreativeRank: vi.fn(),
          promoteCreativeRank
        }}
      />
    );
    expect(await screen.findByText('Bronze', LEAGUE)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Raise the rank' }));
    await waitFor(() => expect(screen.getByText('Silver', LEAGUE)).toBeTruthy());
    expect(promoteCreativeRank).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetCredit: 6, expectedVersion: 6 })
    );
    // Reaching the league the launches earned restores the credit whole, and the way up ends.
    await user.click(screen.getByRole('button', { name: 'Raise the rank' }));
    await waitFor(() => expect(screen.getByText('Gold', LEAGUE)).toBeTruthy());
    expect(promoteCreativeRank).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetCredit: 20, expectedVersion: 7 })
    );
    expect(screen.queryByRole('button', { name: 'Raise the rank' })).toBeNull();
    expect(screen.getByText(/^20 launches · /)).toBeTruthy();
  });

  it('offers no way up to a rank that stands where its launches put it', async () => {
    render(
      <MaterialRank
        teamId="team-1"
        materialId="v1"
        isOwner
        ranksRevision={0}
        client={{
          listCreativeRanks: vi.fn(async () => new Map([['v1', rank()]])),
          demoteCreativeRank: vi.fn(),
          promoteCreativeRank: vi.fn()
        }}
      />
    );
    expect(await screen.findByText('Gold', LEAGUE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Raise the rank' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Lower the rank' })).toBeTruthy();
  });

  it('offers no way down to a member who is not the owner', async () => {
    render(
      <MaterialRank
        teamId="team-1"
        materialId="v1"
        isOwner={false}
        ranksRevision={0}
        client={{
          listCreativeRanks: vi.fn(async () => new Map([['v1', rank()]])),
          demoteCreativeRank: vi.fn()
        }}
      />
    );
    expect(await screen.findByText('Gold', LEAGUE)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lower the rank' })).toBeNull();
  });

  it('shows the current rank when someone changed it first', async () => {
    const current = rank({ rankCredit: 3, version: 9 });
    render(
      <MaterialRank
        teamId="team-1"
        materialId="v1"
        isOwner
        ranksRevision={0}
        client={{
          listCreativeRanks: vi.fn(async () => new Map([['v1', rank()]])),
          demoteCreativeRank: vi.fn(async () => {
            throw new CreativeRankDemoteError('conflict', current);
          })
        }}
      />
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Lower the rank' }));
    await user.click(await screen.findByRole('menuitem', { name: /Never actually launched/ }));
    expect(await screen.findByText('The rank just changed. Showing the current one.')).toBeTruthy();
    expect(screen.getByText('Bronze', LEAGUE)).toBeTruthy();
  });
});
