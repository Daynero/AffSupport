// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryVideoTextVariants, TeamMaterialRow } from '@video-compressor/shared';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { ToastProvider } from '../apps/web/src/components/toast';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { PreviewPane, type PreviewPaneClient } from '../apps/web/src/team/explorer/PreviewPane';
import { teamApi } from '../apps/web/src/api/team';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const video = {
  id: 'v-1',
  teamId: 't-1',
  name: 'clip.mp4',
  category: 'video',
  kind: 'video',
  driveFileId: 'd-1',
  parentFolderId: 'root',
  sizeBytes: 1000,
  modifiedAt: null,
  driveVersion: '1',
  previewState: 'ready',
  thumbnailReady: false
} as unknown as TeamMaterialRow;

function renderPane(
  variants: LibraryVideoTextVariants,
  onTranscribe = vi.fn(),
  material = video,
  overrides: Partial<PreviewPaneClient> = {}
) {
  vi.spyOn(teamApi, 'listVideoTextVariants').mockResolvedValue(variants);
  const client = {
    mintThumbnailSession: vi.fn().mockResolvedValue({ endpoint: '', token: '', expiresAt: '' }),
    thumbnailUrl: () => '',
    listFolderTree: vi.fn().mockResolvedValue([]),
    ...overrides
  } as never;
  const view = render(
    // The pane offers the file's actions now, and those are the space's to
    // permit — so it needs the space around it, exactly as it has in the app.
    <ToastProvider>
      <TeamProvider
        realtime={false}
        initialTeams={[
          {
            id: 't-1',
            name: 'Space',
            role: 'editor',
            permissions: DEFAULT_ROLE_PERMISSIONS.editor,
            connectionState: 'connected' as const
          }
        ]}
      >
        <ExplorerProvider teamId="t-1" client={client} folderId={null}>
          <PreviewPane
            row={material}
            client={client}
            browseClient={client}
            onChanged={() => {}}
            onTranscribe={onTranscribe}
          />
        </ExplorerProvider>
      </TeamProvider>
    </ToastProvider>
  );
  return { onTranscribe, view };
}

it('uses only the ready render pointer for the selected landing preview', async () => {
  const artifact = {
    materialId: 'landing-1',
    sourceVersion: '1',
    fingerprint: 'synthetic',
    preset: 'default',
    segmentCount: 1,
    artifactToken: 'synthetic-token'
  };
  const list = vi.fn().mockResolvedValue([
    {
      materialId: 'landing-1',
      state: 'ready',
      sourceVersion: '1',
      fingerprint: 'synthetic',
      preset: 'default',
      artifact
    }
  ]);
  const imageUrl = vi.fn().mockReturnValue('https://preview.invalid/landing.webp');
  const landing = {
    ...video,
    id: 'landing-1',
    kind: 'landing',
    category: 'landing',
    landingRender: { state: 'ready' }
  } as unknown as TeamMaterialRow;
  const { view } = renderPane(
    { sourceVersion: '1', variants: [], canProcess: false },
    vi.fn(),
    landing,
    { listLandingRenders: list, landingRenderImageUrl: imageUrl }
  );
  await waitFor(() =>
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
      'https://preview.invalid/landing.webp'
    )
  );
  expect(list).toHaveBeenCalledWith('t-1', ['landing-1'], 'default');
  expect(imageUrl).toHaveBeenCalledWith(artifact, 0);
});

describe('PreviewPane transcript block (012, T016/T017)', () => {
  it('offers Transcribe when the video has no text yet', async () => {
    const { onTranscribe } = renderPane({ sourceVersion: '1', variants: [], canProcess: true });
    const button = await screen.findByRole('button', { name: 'Transcribe' });
    button.click();
    await waitFor(() =>
      expect(onTranscribe).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-1' }))
    );
  });

  it('uses only original text even when a legacy response includes translation', async () => {
    renderPane({
      sourceVersion: '1',
      canProcess: true,
      variants: [
        {
          materialId: 'c-orig',
          kind: 'original',
          language: 'en',
          ingestState: 'full',
          truncated: false,
          text: 'hello',
          updatedAt: new Date().toISOString()
        },
        {
          materialId: 'c-uk',
          kind: 'translation' as never,
          language: 'uk',
          ingestState: 'full',
          truncated: false,
          text: 'привіт',
          updatedAt: new Date().toISOString()
        }
      ]
    });
    expect(await screen.findByRole('button', { name: 'View text' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeTruthy();
    // Short on screen in the narrow pane, named in full for a screen reader (024).
    expect(screen.getByRole('button', { name: 'Redo the transcript' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'uk translation' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'View text' }));
    expect(screen.getByRole('dialog').textContent).toContain('hello');
    expect(screen.getByRole('dialog').textContent).not.toContain('привіт');
  });
});
