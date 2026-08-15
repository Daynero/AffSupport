// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskAttachmentSummary } from '@video-compressor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  attachTaskMaterialsInChunks,
  decodeTaskMaterialDrag,
  TaskAttachmentPicker
} from '../apps/web/src/team/tasks/TaskAttachmentPicker';
import {
  TaskAttachmentTile,
  taskVideoPreviewTimeSeconds
} from '../apps/web/src/team/tasks/TaskAttachmentTile';
import { TaskEditor } from '../apps/web/src/team/tasks/TaskEditor';
import { TaskSpace, type TaskSpaceClient } from '../apps/web/src/team/tasks/TaskSpace';

const TEAM_ID = '31000000-0000-4000-8000-000000000001';
const ASSET_ID = '31000000-0000-4000-8000-000000000002';
const TASK_ID = '31000000-0000-4000-8000-000000000003';
const SECOND_ASSET_ID = '31000000-0000-4000-8000-000000000006';

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
    requestDownload: vi.fn().mockResolvedValue({
      kind: 'browser',
      rangeUrl: 'https://example.test/download',
      expiresAt: '2026-08-14T11:00:00.000Z',
      disposition: 'attachment'
    }),
    shareLibraryMaterial: vi.fn().mockResolvedValue({
      state: 'ready',
      url: 'https://drive.google.com/file/d/shared/view',
      public: true,
      permissionChanged: false
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

  it('does not regenerate an existing preview when its attachment object is refreshed', async () => {
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
    const api = client();
    const { rerender } = render(
      <TaskAttachmentTile teamId={TEAM_ID} attachment={attachment} client={api} />
    );
    await screen.findByLabelText('Video preview for launch.mp4 at one second');
    rerender(
      <TaskAttachmentTile teamId={TEAM_ID} attachment={{ ...attachment }} client={api} />
    );
    await waitFor(() => expect(api.previewMaterial).toHaveBeenCalledTimes(1));
  });

  it('opens, downloads and copies a share-ready Drive link for an attachment', async () => {
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
    const api = client();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(<TaskAttachmentTile teamId={TEAM_ID} attachment={attachment} client={api} />);

    await screen.findByLabelText('Video preview for launch.mp4 at one second');
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(api.requestDownload).toHaveBeenCalledWith(TEAM_ID, ASSET_ID, 'browser')
    );
    expect(anchorClick).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() =>
      expect(api.shareLibraryMaterial).toHaveBeenCalledWith(
        expect.objectContaining({
          teamId: TEAM_ID,
          materialId: ASSET_ID,
          allowIfRestricted: true,
          rememberChoice: false
        })
      )
    );
    expect(writeText).toHaveBeenCalledWith('https://drive.google.com/file/d/shared/view');
  });

  it('keeps the attachment count after an inline progress update', async () => {
    localStorage.setItem('wishly.active-team.v1', TEAM_ID);
    const api = client();
    api.listTasks = vi.fn().mockResolvedValue([task()]);
    // update_team_task returns a team_tasks row, so its RPC shape has no
    // derived attachment_count field.
    api.updateTask = vi.fn().mockResolvedValue({ ...task(), progressValue: 1, attachmentCount: 0 });
    const team = {
      id: TEAM_ID,
      name: 'Creative team',
      role: 'editor' as const,
      permissions: DEFAULT_ROLE_PERMISSIONS.editor,
      connectionState: 'connected' as const
    };
    render(
      <TeamProvider initialTeams={[team]} realtime={false}>
        <TaskSpace teamId={TEAM_ID} client={api} />
      </TeamProvider>
    );

    await screen.findByText('1 attachments');
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Progress scale' }), {
      key: 'ArrowRight'
    });
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledOnce());
    expect(screen.getByText('1 attachments')).toBeTruthy();
  });

  it('stages attached media locally and drops it when the editor is closed without saving', async () => {
    const api = client();
    api.listMaterials = vi.fn().mockResolvedValue([
      {
        id: SECOND_ASSET_ID,
        teamId: TEAM_ID,
        providerId: 'drive-new-image',
        parentFolderId: 'drive-root',
        name: 'new-image.png',
        kind: 'file',
        category: 'image',
        previewState: 'ready'
      }
    ]);
    const onClose = vi.fn();
    render(
      <TaskEditor
        teamId={TEAM_ID}
        task={task()}
        members={[]}
        canEdit
        client={api}
        onClose={onClose}
        onChanged={vi.fn()}
      />
    );

    await screen.findByText('launch.mp4');
    fireEvent.click(screen.getByRole('button', { name: /Attach media/ }));
    fireEvent.click(await screen.findByRole('button', { name: /new-image\.png/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to task (1)' }));

    expect(await screen.findByText('Will be added on save')).toBeTruthy();
    expect(api.attachTaskMaterials).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('heading', { name: 'You have unsaved changes' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close without saving' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(api.attachTaskMaterials).not.toHaveBeenCalled();
    expect(api.detachTaskMaterial).not.toHaveBeenCalled();
  });

  it('sends staged media to the server only when saving the task', async () => {
    const api = client();
    api.listMaterials = vi.fn().mockResolvedValue([
      {
        id: SECOND_ASSET_ID,
        teamId: TEAM_ID,
        providerId: 'drive-new-image',
        parentFolderId: 'drive-root',
        name: 'new-image.png',
        kind: 'file',
        category: 'image',
        previewState: 'ready'
      }
    ]);
    const onClose = vi.fn();
    render(
      <TaskEditor
        teamId={TEAM_ID}
        task={task()}
        members={[]}
        canEdit
        client={api}
        onClose={onClose}
        onChanged={vi.fn()}
      />
    );

    await screen.findByText('launch.mp4');
    fireEvent.click(screen.getByRole('button', { name: /Attach media/ }));
    fireEvent.click(await screen.findByRole('button', { name: /new-image\.png/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to task (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }));

    await waitFor(() =>
      expect(api.attachTaskMaterials).toHaveBeenCalledWith({
        teamId: TEAM_ID,
        taskId: TASK_ID,
        materialIds: [SECOND_ASSET_ID]
      })
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('saves status immediately without treating it as an unsaved editor change', async () => {
    const api = client();
    api.updateTask = vi.fn().mockResolvedValue({ ...task(), status: 'in_progress' });
    const onClose = vi.fn();
    render(
      <TaskEditor
        teamId={TEAM_ID}
        task={task()}
        members={[]}
        canEdit
        client={api}
        onClose={onClose}
        onChanged={vi.fn()}
      />
    );

    await screen.findByText('launch.mp4');
    fireEvent.click(screen.getByRole('button', { name: 'In progress' }));
    await waitFor(() =>
      expect(api.updateTask).toHaveBeenCalledWith(
        TEAM_ID,
        TASK_ID,
        expect.objectContaining({ status: 'in_progress' })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'You have unsaved changes' })).toBeNull();
  });

  it('browses nested team folders before staging media for a task', async () => {
    const api = client();
    api.listMaterials = vi.fn((_: string, parentId: string | null) => {
      if (parentId === null) {
        return Promise.resolve([
          {
            id: '31000000-0000-4000-8000-000000000007',
            teamId: TEAM_ID,
            providerId: 'drive-folder-campaigns',
            parentFolderId: 'drive-root',
            name: 'Campaigns',
            kind: 'folder' as const,
            category: null,
            previewState: 'ready'
          }
        ]);
      }
      return Promise.resolve([
        {
          id: SECOND_ASSET_ID,
          teamId: TEAM_ID,
          providerId: 'drive-new-image',
          parentFolderId: 'drive-folder-campaigns',
          name: 'new-image.png',
          kind: 'file' as const,
          category: 'image' as const,
          previewState: 'ready'
        }
      ]);
    });
    const onAdd = vi.fn();
    render(
      <TaskAttachmentPicker
        teamId={TEAM_ID}
        client={api}
        attachedMaterialIds={new Set()}
        onAdd={onAdd}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Attach media/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Campaigns/ }));
    await waitFor(() =>
      expect(api.listMaterials).toHaveBeenCalledWith(TEAM_ID, 'drive-folder-campaigns')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(api.listMaterials).toHaveBeenLastCalledWith(TEAM_ID, null));

    fireEvent.click(screen.getByRole('button', { name: /Campaigns/ }));
    fireEvent.click(await screen.findByRole('button', { name: /new-image\.png/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to task (1)' }));

    expect(onAdd).toHaveBeenCalledWith([
      expect.objectContaining({ id: SECOND_ASSET_ID, name: 'new-image.png' })
    ]);
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
