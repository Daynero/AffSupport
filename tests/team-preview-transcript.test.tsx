// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamMaterialRow } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { ExplorerProvider } from '../apps/web/src/team/explorer/ExplorerProvider';
import { PreviewPane } from '../apps/web/src/team/explorer/PreviewPane';

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
  companion: Awaited<
    ReturnType<NonNullable<Parameters<typeof PreviewPane>[0]['getTranscriptCompanion']>>
  >,
  onTranscribe = vi.fn()
) {
  const client = {
    mintThumbnailSession: vi.fn().mockResolvedValue({ endpoint: '', token: '', expiresAt: '' }),
    thumbnailUrl: () => '',
    listFolderTree: vi.fn().mockResolvedValue([])
  } as never;
  render(
    <ToastProvider>
      <ExplorerProvider teamId="t-1" client={client} folderId={null}>
        <PreviewPane
          row={video}
          client={client}
          onTranscribe={onTranscribe}
          getTranscriptCompanion={vi.fn().mockResolvedValue(companion)}
        />
      </ExplorerProvider>
    </ToastProvider>
  );
  return { onTranscribe };
}

describe('PreviewPane transcript block (012, T016)', () => {
  it('offers Transcribe when the video has no companion', async () => {
    const { onTranscribe } = renderPane(null);
    const button = await screen.findByRole('button', { name: 'Transcribe' });
    button.click();
    await waitFor(() =>
      expect(onTranscribe).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-1' }))
    );
  });

  it('offers Re-transcribe once a companion exists', async () => {
    renderPane({ id: 'c-1', name: 'clip.txt', ingestState: 'full', hasText: true });
    expect(await screen.findByRole('button', { name: 'Re-transcribe' })).toBeTruthy();
  });
});
