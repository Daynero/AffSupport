// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderPage, TeamMaterialRow, ThumbnailSession } from '@video-compressor/shared';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { ContentGrid, type ContentGridClient } from '../apps/web/src/team/explorer/ContentGrid';
import { clearThumbnailSessions } from '../apps/web/src/team/explorer/useThumbnailSession';

/**
 * Feature 011 (T041): tiles show the prepared thumbnail through the team's
 * one session, the landing render's first segment, or the kind and its
 * reason — and the session is minted once for the whole grid.
 */

afterEach(() => {
  cleanup();
  clearThumbnailSessions();
  vi.restoreAllMocks();
});

const TEAM = 'team-1';
const SESSION: ThumbnailSession = {
  token: 'session-token',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  teamId: TEAM,
  endpoint: 'https://p.supabase.co/functions/v1/drive-transfer/thumbnail'
};

function row(index: number, overrides: Partial<TeamMaterialRow> = {}): TeamMaterialRow {
  return {
    id: `id-${index}`,
    teamId: TEAM,
    name: `file-${index}.png`,
    category: 'image',
    mimeType: 'image/png',
    fileExtension: 'png',
    sizeBytes: 2048,
    kind: 'image',
    driveFileId: `drive-${index}`,
    parentFolderId: 'root',
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'ready',
    thumbnailReady: true,
    ...overrides
  };
}

function makeClient(
  rows: TeamMaterialRow[],
  overrides: Partial<ContentGridClient> = {}
): ContentGridClient {
  return {
    listFolderPage: vi.fn(async (): Promise<FolderPage> => ({
      rows,
      total: rows.length,
      next: null
    })),
    mintThumbnailSession: vi.fn().mockResolvedValue(SESSION),
    thumbnailUrl: (session, materialId) =>
      `${session.endpoint}?material=${materialId}&session=${session.token}`,
    listLandingRenders: vi.fn().mockResolvedValue([]),
    landingRenderImageUrl: artifact => `https://render/${artifact.materialId}/0`,
    ...overrides
  };
}

function renderGrid(client: ContentGridClient) {
  return render(
    <ExplorerProvider teamId={TEAM} client={{ listFolderTree: vi.fn().mockResolvedValue([]) }}>
      <ContentGrid client={client} />
    </ExplorerProvider>
  );
}

describe('ContentGrid', () => {
  it('shows prepared thumbnails through one session, and a kind icon with a reason otherwise', async () => {
    const client = makeClient([
      row(1),
      row(2, { kind: 'video', category: 'video', mimeType: 'video/mp4', name: 'clip.mp4' }),
      row(3, {
        thumbnailReady: false,
        previewState: 'unavailable',
        previewReason: 'protected',
        name: 'locked.png'
      }),
      row(4, { thumbnailReady: false, previewState: 'pending', name: 'later.png' }),
      row(5, {
        kind: 'document',
        category: null,
        mimeType: 'application/vnd.google-apps.document',
        name: 'Brief',
        thumbnailReady: false,
        previewState: 'not_applicable'
      })
    ]);
    const { container } = renderGrid(client);
    await screen.findByText('Items: 5');
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(2));
    const images = [...container.querySelectorAll('img')].map(img => img.getAttribute('src'));
    expect(images).toEqual([
      `${SESSION.endpoint}?material=id-1&session=session-token`,
      `${SESSION.endpoint}?material=id-2&session=session-token`
    ]);
    expect(client.mintThumbnailSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/would not hand over a thumbnail/)).toBeTruthy();
    expect(screen.getByText('Opens in Google Drive, not in Soty.')).toBeTruthy();
    expect(container.querySelectorAll('img[loading="lazy"]')).toHaveLength(2);
  });

  it('uses the first render segment for a ready landing and names the other states', async () => {
    const client = makeClient(
      [
        row(1, {
          kind: 'landing',
          category: 'landing',
          mimeType: 'application/zip',
          name: 'lp.zip',
          thumbnailReady: false,
          previewState: 'not_applicable',
          landingRender: { state: 'ready' }
        }),
        row(2, {
          kind: 'landing',
          category: 'landing',
          mimeType: 'application/zip',
          name: 'lp2.zip',
          thumbnailReady: false,
          previewState: 'not_applicable',
          landingRender: { state: 'rendering' }
        }),
        row(3, {
          kind: 'landing',
          category: 'landing',
          mimeType: 'application/zip',
          name: 'lp3.zip',
          thumbnailReady: false,
          previewState: 'not_applicable',
          landingRender: { state: 'none' }
        })
      ],
      {
        listLandingRenders: vi.fn().mockResolvedValue([
          {
            materialId: 'id-1',
            state: 'ready',
            sourceVersion: '1',
            fingerprint: 'f'.repeat(64),
            preset: 'default',
            artifact: {
              materialId: 'id-1',
              sourceVersion: '1',
              fingerprint: 'f'.repeat(64),
              preset: 'default',
              segmentCount: 2,
              artifactToken: 'tok'
            }
          }
        ])
      }
    );
    const { container } = renderGrid(client);
    await screen.findByText('Items: 3');
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toBe('https://render/id-1/0')
    );
    expect(client.listLandingRenders).toHaveBeenCalledWith(TEAM, ['id-1'], 'default');
    expect(screen.getByText('Preparing the landing preview…')).toBeTruthy();
    expect(screen.getByText(/prepared when a local Soty app is open/)).toBeTruthy();
  });

  it('falls back to the kind icon when a thumbnail fails to load', async () => {
    const client = makeClient([row(1)]);
    const { container } = renderGrid(client);
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    container.querySelector('img')!.dispatchEvent(new Event('error'));
    await waitFor(() => expect(container.querySelector('img')).toBeNull());
    expect(container.querySelector('.team-explorer-tile-icon')).toBeTruthy();
  });
});
