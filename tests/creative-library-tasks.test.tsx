// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskAttachmentSummary } from '@video-compressor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  attachTaskMaterialsInChunks,
  decodeTaskMaterialDrag
} from '../apps/web/src/team/tasks/TaskAttachmentPicker';
import {
  TaskAttachmentTile,
  taskVideoPreviewTimeSeconds
} from '../apps/web/src/team/tasks/TaskAttachmentTile';
import { TaskSpace, type TaskSpaceClient } from '../apps/web/src/team/tasks/TaskSpace';

const TEAM_ID = '31000000-0000-4000-8000-000000000001';
const ASSET_ID = '31000000-0000-4000-8000-000000000002';
const TASK_ID = '31000000-0000-4000-8000-000000000003';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function task() {
  return {
    id: TASK_ID,
    teamId: TEAM_ID,
    title: 'Task: launch.mp4',
    note: null,
    assigneeId: null,
    assigneeLabelSnapshot: null,
    status: 'todo' as const,
    progressMax: 100,
    progressValue: 0,
    progressManuallySet: false,
    attachmentCount: 1,
    createdBy: '31000000-0000-4000-8000-000000000004',
    createdAt: '2026-08-14T10:00:00.000Z',
    updatedAt: '2026-08-14T10:00:00.000Z',
    completedAt: null
  };
}

function client(): TaskSpaceClient {
  return {
    listTasks: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue(task()),
    updateTask: vi.fn().mockResolvedValue(task()),
    getTask: vi.fn().mockResolvedValue({
      task: task(),
      attachments: [
        {
          id: '31000000-0000-4000-8000-000000000005',
          taskId: TASK_ID,
          materialId: ASSET_ID,
          name: 'launch.mp4',
          category: 'video',
          availability: 'ready',
          previewState: 'ready',
          position: 0
        }
      ]
    }),
    detachTaskMaterial: vi.fn().mockResolvedValue(true),
    attachTaskMaterials: vi.fn().mockResolvedValue({
      attached: [],
      alreadyAttached: [],
      rejected: []
    }),
    searchCatalog: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      activeFilters: {},
      facets: { geo: [], language: [], offer: [], category: [] },
      catalogFreshness: { state: 'ready', lastSyncedAt: null }
    }),
    getCatalogVocabulary: vi.fn().mockResolvedValue({
      geo: [],
      languages: [],
      offers: [],
      tags: []
    }),
    previewMaterial: vi.fn().mockResolvedValue({
      kind: 'media',
      rangeUrl: 'https://example.test/video',
      mimeType: 'video/mp4',
      expiresAt: '2026-08-14T11:00:00.000Z'
    }),
    listLandingRenders: vi.fn().mockResolvedValue([]),
    landingRenderImageUrl: vi.fn().mockReturnValue('https://example.test/landing.webp'),
    listMaterials: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([])
  };
}

describe('Creative Library task workflows', () => {
  it('chunks an unlimited UI attachment selection into idempotent batches of 100', async () => {
    const attachTaskMaterials = vi.fn(async ({ materialIds }: { materialIds: string[] }) => ({
      attached: materialIds,
      alreadyAttached: [],
      rejected: []
    }));
    const ids = Array.from(
      { length: 250 },
      (_, index) => `31000000-0000-4000-8000-${String(index).padStart(12, '0')}`
    );
    const result = await attachTaskMaterialsInChunks({
      client: { attachTaskMaterials },
      teamId: TEAM_ID,
      taskId: TASK_ID,
      materialIds: [...ids, ids[0]]
    });
    expect(attachTaskMaterials).toHaveBeenCalledTimes(3);
    expect(result.attached).toHaveLength(250);
  });

  it('accepts only unique UUIDs from the private multi-drag payload', () => {
    expect(decodeTaskMaterialDrag(JSON.stringify([ASSET_ID, ASSET_ID, 'secret-path']))).toEqual([
      ASSET_ID
    ]);
    expect(decodeTaskMaterialDrag('{broken')).toEqual([]);
  });

  it('keeps a video tile hidden until the exact one-second seek completes', async () => {
    const attachment: TeamTaskAttachmentSummary = {
      id: '31000000-0000-4000-8000-000000000005',
      taskId: TASK_ID,
      materialId: ASSET_ID,
      name: 'launch.mp4',
      category: 'video',
      availability: 'ready',
      previewState: 'ready',
      position: 0
    };
    render(<TaskAttachmentTile teamId={TEAM_ID} attachment={attachment} client={client()} />);
    const element = (await screen.findByLabelText(
      'Video preview for launch.mp4 at one second'
    )) as HTMLVideoElement;
    Object.defineProperty(element, 'duration', { configurable: true, value: 12 });
    fireEvent.loadedMetadata(element);
    expect(element.currentTime).toBe(1);
    expect(element.classList.contains('is-ready')).toBe(false);
    fireEvent.seeked(element);
    expect(element.classList.contains('is-ready')).toBe(true);
    expect(element.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(taskVideoPreviewTimeSeconds(0.6)).toBe(0.6);
  });

  it('does not leave a broken attachment preview in a loading state', async () => {
    const attachment: TeamTaskAttachmentSummary = {
      id: '31000000-0000-4000-8000-000000000005',
      taskId: TASK_ID,
      materialId: ASSET_ID,
      name: 'launch.mp4',
      category: 'video',
      availability: 'ready',
      previewState: 'ready',
      position: 0
    };
    render(<TaskAttachmentTile teamId={TEAM_ID} attachment={attachment} client={client()} />);
    const element = (await screen.findByLabelText(
      'Video preview for launch.mp4 at one second'
    )) as HTMLVideoElement;
    fireEvent.error(element);

    expect(await screen.findByText('Preview unavailable')).toBeTruthy();
    expect(screen.queryByLabelText('Video preview for launch.mp4 at one second')).toBeNull();
  });

  it('creates a task from an asset reference and opens it immediately', async () => {
    localStorage.setItem('wishly.active-team.v1', TEAM_ID);
    const api = client();
    const team = {
      id: TEAM_ID,
      name: 'Creative team',
      role: 'editor' as const,
      permissions: DEFAULT_ROLE_PERMISSIONS.editor,
      connectionState: 'connected' as const
    };
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <TaskSpace
          teamId={TEAM_ID}
          client={api}
          createFromAsset={{
            id: ASSET_ID,
            teamId: TEAM_ID,
            name: 'launch.mp4',
            category: 'video',
            mimeType: 'video/mp4',
            fileExtension: 'mp4',
            sizeBytes: 10,
            lifecycle: 'active',
            sourceVersion: '1',
            stage: 'library',
            offer: 'Summer',
            language: 'uk',
            type: 'Video',
            placementState: 'ready',
            languageDecisionSource: 'manual',
            thumbnailState: 'ready',
            thumbnailTimeMs: 1_000,
            createdAt: '2026-08-14T10:00:00.000Z'
          }}
        />
      </TeamProvider>
    );
    await waitFor(() =>
      expect(api.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: TEAM_ID, initialMaterialId: ASSET_ID })
      )
    );
    expect(await screen.findByRole('heading', { name: 'Task details' })).toBeTruthy();
  });
});
