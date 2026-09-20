// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { foldCompanions } from '../apps/web/src/team/explorer/companions';
import { ContentGrid } from '../apps/web/src/team/explorer/ContentGrid';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';

/**
 * Feature 024 (US25): a transcript and a catalog belong to their video, so the folder shows the
 * video and keeps its files one press away — ten creatives read as ten rows, not thirty.
 */

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

const companion = (id: string, name: string, of: string): TeamMaterialRow =>
  ({
    ...row(id, name, { kind: 'transcript', category: 'transcript', mimeType: 'text/plain' }),
    companionOf: of,
    companionKind: 'transcript'
  }) as TeamMaterialRow;

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('folding a video’s own files', () => {
  it('keeps the video, counts its files and puts them back when it is opened', () => {
    const rows = [row('v1', 'clip.mp4'), companion('t1', 'clip.txt', 'v1'), row('v2', 'other.mp4')];
    const closed = foldCompanions(rows, new Set());
    expect(closed.rows.map(item => item.id)).toEqual(['v1', 'v2']);
    expect(closed.counts.get('v1')).toBe(1);

    const open = foldCompanions(rows, new Set(['v1']));
    expect(open.rows.map(item => item.id)).toEqual(['v1', 't1', 'v2']);
  });

  it('never hides a file whose video is not here', () => {
    // Its video was deleted, filtered out, or sits on a later page: hiding it would put it
    // out of reach entirely.
    const rows = [companion('t1', 'gone.txt', 'v-missing'), row('v2', 'other.mp4')];
    expect(foldCompanions(rows, new Set()).rows.map(item => item.id)).toEqual(['t1', 'v2']);
  });
});

describe('the grid', () => {
  const page = {
    rows: [],
    total: 2,
    loading: false,
    error: false,
    hasMore: false,
    loadMore: vi.fn(),
    reload: vi.fn()
  } as never;

  it('lists a video’s files from a badge on its tile, without dealing them out as tiles', async () => {
    const rows = [row('v1', 'clip.mp4'), companion('t1', 'clip_v1_catalog', 'v1')];
    const folded = foldCompanions(rows, new Set());
    const onPreview = vi.fn();
    render(
      <ExplorerProvider teamId="team-1" client={{ listFolderTree: vi.fn().mockResolvedValue([]) }}>
        <ContentGrid
          page={page}
          rows={folded.rows}
          companionRows={folded.children}
          onPreview={onPreview}
          client={{ thumbnailUrl: () => null, openSession: async () => null } as never}
        />
      </ExplorerProvider>
    );
    // One tile, and the catalog is not among them.
    expect(document.querySelectorAll('.team-explorer-tile')).toHaveLength(1);
    expect(screen.queryByText('clip_v1_catalog')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'clip.mp4: Its files: 1' }));
    expect(screen.getByText('clip_v1_catalog')).toBeTruthy();
    expect(screen.getByText('Product catalog')).toBeTruthy();
    // Still one tile: the list is on the tile, the grid has not moved.
    expect(document.querySelectorAll('.team-explorer-tile')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Open clip_v1_catalog' }));
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }));
    expect(screen.queryByText('clip_v1_catalog')).toBeNull();
  });
});
