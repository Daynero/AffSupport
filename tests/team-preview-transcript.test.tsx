// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryVideoTextVariants, TeamMaterialRow } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { PreviewPane } from '../apps/web/src/team/explorer/PreviewPane';
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

function renderPane(variants: LibraryVideoTextVariants, onTranscribe = vi.fn()) {
  vi.spyOn(teamApi, 'listVideoTextVariants').mockResolvedValue(variants);
  const client = {
    mintThumbnailSession: vi.fn().mockResolvedValue({ endpoint: '', token: '', expiresAt: '' }),
    thumbnailUrl: () => '',
    listFolderTree: vi.fn().mockResolvedValue([])
  } as never;
  render(
    <ToastProvider>
      <ExplorerProvider teamId="t-1" client={client} folderId={null}>
        <PreviewPane row={video} client={client} onTranscribe={onTranscribe} />
      </ExplorerProvider>
    </ToastProvider>
  );
  return { onTranscribe };
}

describe('PreviewPane transcript block (012, T016/T017)', () => {
  it('offers Transcribe when the video has no text yet', async () => {
    const { onTranscribe } = renderPane({ sourceVersion: '1', variants: [], canProcess: true });
    const button = await screen.findByRole('button', { name: 'Transcribe' });
    button.click();
    await waitFor(() =>
      expect(onTranscribe).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-1' }))
    );
  });

  it('surfaces view/copy for the transcript and its translation, plus re-transcribe', async () => {
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
          kind: 'translation',
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
    expect(screen.getByRole('button', { name: 'Re-transcribe' })).toBeTruthy();
    // A selector lets you pick the original or the translation.
    expect(screen.getByRole('option', { name: 'Original transcript' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'uk translation' })).toBeTruthy();
  });
});
