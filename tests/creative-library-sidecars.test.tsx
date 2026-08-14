// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibraryGroupIntent } from '../supabase/functions/_shared/library.js';
import { applyLibraryGroupMutation } from '../supabase/functions/_shared/library.js';
import { VideoTextActions } from '../apps/web/src/team/library/VideoTextActions';

const TEAM_ID = '42000000-0000-4000-8000-000000000001';
const VIDEO_ID = '42000000-0000-4000-8000-000000000002';
const TEXT_ID = '42000000-0000-4000-8000-000000000003';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function capabilities() {
  return {
    canDownload: true,
    canListChildren: true,
    canAddChildren: true,
    canRename: true,
    canMoveItemWithinDrive: true,
    canMoveItemOutOfDrive: true,
    canModifyContent: true,
    canShare: true,
    canTrash: true,
    canUntrash: true
  };
}

function metadata(id: string, trashed: boolean) {
  return {
    id,
    name: id,
    mimeType: 'video/mp4',
    parents: id === 'root' ? [] : ['root'],
    trashed,
    driveId: null,
    resourceKey: null,
    shortcutTargetId: null,
    shortcutTargetResourceKey: null,
    capabilities: capabilities(),
    size: 10,
    modifiedAt: '2026-08-14T10:00:00.000Z',
    version: 'v1',
    checksum: null,
    webViewLink: `https://drive.google.com/file/d/${id}/view`
  };
}

function lifecycleIntent(action: 'trash' | 'restore'): LibraryGroupIntent {
  return {
    intentId: '42000000-0000-4000-8000-000000000010',
    teamId: TEAM_ID,
    operationId: '42000000-0000-4000-8000-000000000011',
    sourceMaterialId: VIDEO_ID,
    action,
    appliedMemberIds: [],
    members: [
      {
        materialId: VIDEO_ID,
        driveFileId: 'video-drive',
        resourceKey: null,
        parentFolderId: 'root',
        role: 'source'
      },
      {
        materialId: TEXT_ID,
        driveFileId: 'text-drive',
        resourceKey: null,
        parentFolderId: 'root',
        role: 'transcript'
      }
    ]
  };
}

describe('Creative Library transcript sidecars', () => {
  it('views and copies only cached full text without starting processing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const onTranscribe = vi.fn();
    const client = {
      listVideoTextVariants: vi.fn().mockResolvedValue({
        sourceVersion: 'v1',
        canProcess: true,
        variants: [
          {
            materialId: TEXT_ID,
            kind: 'original',
            language: 'en',
            ingestState: 'full',
            truncated: false,
            text: 'Cached transcript body',
            updatedAt: '2026-08-14T10:00:00.000Z'
          }
        ]
      })
    };
    render(
      <VideoTextActions
        teamId={TEAM_ID}
        videoId={VIDEO_ID}
        client={client}
        onTranscribe={onTranscribe}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'View text' }));
    expect(screen.getByText('Cached transcript body')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy text' })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Cached transcript body'));
    expect(client.listVideoTextVariants).toHaveBeenCalledTimes(1);
    expect(onTranscribe).not.toHaveBeenCalled();
  });

  it('offers Transcribe, but no Copy action, when no current cached text exists', async () => {
    const onTranscribe = vi.fn();
    render(
      <VideoTextActions
        teamId={TEAM_ID}
        videoId={VIDEO_ID}
        client={{
          listVideoTextVariants: vi.fn().mockResolvedValue({
            sourceVersion: 'v2',
            canProcess: true,
            variants: []
          })
        }}
        onTranscribe={onTranscribe}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Transcribe' }));
    expect(onTranscribe).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Copy text' })).toBeNull();
  });

  it('trashes and restores the video and every current sidecar as one checkpointed group', async () => {
    for (const action of ['trash', 'restore'] as const) {
      const files = new Map([
        ['root', metadata('root', false)],
        ['video-drive', metadata('video-drive', action === 'restore')],
        ['text-drive', metadata('text-drive', action === 'restore')]
      ]);
      const updateFileMetadata = vi.fn(async (input: { fileId: string; trashed?: boolean }) => {
        const current = files.get(input.fileId)!;
        const updated = { ...current, trashed: input.trashed ?? current.trashed };
        files.set(input.fileId, updated);
        return updated;
      });
      const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
      await applyLibraryGroupMutation({
        service: { rpc } as never,
        drive: {
          getFile: vi.fn(async (id: string) => files.get(id)!),
          updateFileMetadata
        } as never,
        rootFolderId: 'root',
        intent: lifecycleIntent(action)
      });
      expect(updateFileMetadata).toHaveBeenCalledTimes(2);
      expect(updateFileMetadata.mock.calls.map(([input]) => input.trashed)).toEqual([
        action === 'trash',
        action === 'trash'
      ]);
      expect(
        rpc.mock.calls.filter(([name]) => name === 'service_checkpoint_material_group_intent')
      ).toHaveLength(2);
    }
  });
});
