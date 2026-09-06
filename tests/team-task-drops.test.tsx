// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_ROLE_PERMISSIONS, type TeamTaskSummary } from '@video-compressor/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { TaskEditor, type TaskEditorClient } from '../apps/web/src/team/tasks/TaskEditor';

/**
 * Files dropped on a task (011).
 *
 * The attachment list could only ever hold files already in the space, so a
 * screenshot on somebody's desktop meant uploading it somewhere first and
 * finding it again. A drop puts it in one folder — the same one for every
 * task, made on first use — and attaches it where it was dropped.
 */

const TEAM_ID = '11000000-0000-4000-8000-000000000010';
const TASK_ID = '11000000-0000-4000-8000-000000000011';
const DROP_FOLDER = '11000000-0000-4000-8000-0000000000ff';
const STAMP = '2026-09-06T10:00:00.000Z';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function task(): TeamTaskSummary {
  return {
    id: TASK_ID,
    teamId: TEAM_ID,
    title: 'Pro Caps | TR 05/09',
    note: null,
    assigneeId: null,
    assigneeLabelSnapshot: null,
    status: 'todo',
    progressMax: 100,
    progressValue: 0,
    progressManuallySet: false,
    attachmentCount: 0,
    dateOn: null,
    agents: [],
    labels: [],
    createdBy: '11000000-0000-4000-8000-000000000099',
    createdAt: STAMP,
    updatedAt: STAMP,
    completedAt: null
  } satisfies TeamTaskSummary;
}

function client(overrides: Partial<TaskEditorClient> = {}) {
  let uploaded = 0;
  return {
    getTask: vi.fn(async () => ({ task: task(), attachments: [] })),
    updateTask: vi.fn(async () => task()),
    detachTaskMaterial: vi.fn(async () => true),
    attachTaskMaterials: vi.fn(async ({ materialIds }: { materialIds: string[] }) => ({
      attached: materialIds.map(materialId => ({ materialId, position: 0 })),
      alreadyAttached: [],
      rejected: []
    })),
    previewMaterial: vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'pending' })),
    listLandingRenders: vi.fn(async () => []),
    landingRenderImageUrl: vi.fn(() => ''),
    listMaterials: vi.fn(async () => []),
    listTaskLabels: vi.fn(async () => []),
    listAccounts: vi.fn(async () => []),
    attachTaskAgent: vi.fn(),
    detachTaskAgent: vi.fn(),
    issueDownloadGrant: vi.fn(),
    thumbnailUrl: vi.fn(),
    ensureTaskDropFolder: vi.fn(async (_teamId: string, input?: { name: string }) => ({
      folderId: input ? `drive-${input.name}` : 'drive-task-drops',
      materialId: input ? `${DROP_FOLDER.slice(0, -2)}${input.name.length}a` : DROP_FOLDER,
      name: input?.name ?? 'Task attachments',
      created: true
    })),
    uploadFile: vi.fn(async () => {
      uploaded += 1;
      return { materialId: `${TEAM_ID.slice(0, -1)}${uploaded}` };
    }),
    ...overrides
  } as unknown as TaskEditorClient;
}

function wrap(api: TaskEditorClient, role: 'editor' | 'viewer' = 'editor', canEdit = true) {
  localStorage.setItem('wishly.active-team.v1', TEAM_ID);
  localStorage.setItem('language', 'en');
  return render(
    <ToastProvider>
      <TeamProvider
        realtime={false}
        initialTeams={[
          {
            id: TEAM_ID,
            name: 'Media buyers',
            role,
            permissions: DEFAULT_ROLE_PERMISSIONS[role],
            connectionState: 'connected' as const
          }
        ]}
      >
        <TaskEditor
          teamId={TEAM_ID}
          task={task()}
          members={[]}
          canEdit={canEdit}
          client={api}
          onClose={() => {}}
          onChanged={() => {}}
        />
      </TeamProvider>
    </ToastProvider>
  );
}

/** The attachment section is the drop target, so the test aims where a person does. */
function attachmentsSection(): HTMLElement {
  const heading = screen.getByRole('heading', { name: 'Attached files' });
  const section = heading.closest('section');
  if (!section) throw new Error('attachments section missing');
  return section;
}

/** A folder as the browser hands one over: an entry that can be walked. */
function directoryEntry(name: string, children: Array<File | { folder: string; files: File[] }>) {
  return {
    isDirectory: true,
    isFile: false,
    name,
    createReader: () => {
      let served = false;
      return {
        readEntries: (resolve: (entries: unknown[]) => void) => {
          if (served) {
            resolve([]);
            return;
          }
          served = true;
          resolve(
            children.map(child =>
              child instanceof File
                ? {
                    isDirectory: false,
                    isFile: true,
                    name: child.name,
                    file: (ok: (f: File) => void) => ok(child)
                  }
                : directoryEntry(child.folder, child.files)
            )
          );
        }
      };
    }
  };
}

function drop(
  section: HTMLElement,
  files: File[],
  folders: ReturnType<typeof directoryEntry>[] = []
) {
  const dataTransfer = {
    files,
    // A dropped folder arrives as a file with no bytes *and* as a directory
    // entry; only the entry tells them apart, and only the entry can be walked.
    items: [
      ...files.map(file => ({
        getAsFile: () => file,
        webkitGetAsEntry: () => ({ isDirectory: false, name: file.name })
      })),
      ...folders.map(entry => ({ getAsFile: () => null, webkitGetAsEntry: () => entry }))
    ],
    types: ['Files']
  };
  fireEvent.dragEnter(section, { dataTransfer });
  fireEvent.dragOver(section, { dataTransfer });
  fireEvent.drop(section, { dataTransfer });
}

describe('files dropped on a task', () => {
  it('sends them to the space’s one drop folder and attaches each as it lands', async () => {
    const api = client();
    wrap(api);
    await screen.findByRole('heading', { name: 'Attached files' });

    drop(attachmentsSection(), [
      new File(['one'], 'brief.pdf', { type: 'application/pdf' }),
      new File(['two'], 'shot.png', { type: 'image/png' })
    ]);

    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2));
    // One folder for the whole drop, resolved once rather than per file.
    expect(api.ensureTaskDropFolder).toHaveBeenCalledTimes(1);
    expect(api.uploadFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        teamId: TEAM_ID,
        destinationFolderId: DROP_FOLDER,
        file: expect.objectContaining({ name: 'brief.pdf' }),
        // Never a version of anything: a drop is a new file in a drawer.
        versionOfMaterialId: null,
        replaceMaterialId: null
      })
    );
    // Attached where they were dropped — written at once, not staged: the
    // bytes are already in the space, so "will be added when you save" would
    // be a promise about something that has happened.
    await waitFor(() => expect(screen.getByText('brief.pdf')).toBeTruthy());
    expect(screen.getByText('shot.png')).toBeTruthy();
    expect(api.attachTaskMaterials).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/will be added/iu)).toBeNull();
  });

  it('says which file failed and keeps going with the rest', async () => {
    let attempt = 0;
    const api = client({
      uploadFile: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('TOO_LARGE');
        return { materialId: '11000000-0000-4000-8000-000000000042' };
      })
    } as Partial<TaskEditorClient>);
    wrap(api);
    await screen.findByRole('heading', { name: 'Attached files' });

    drop(attachmentsSection(), [
      new File(['one'], 'huge.mov', { type: 'video/quicktime' }),
      new File(['two'], 'small.png', { type: 'image/png' })
    ]);

    await waitFor(() => expect(screen.getByText(/Could not attach huge\.mov/u)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('small.png')).toBeTruthy());
  });

  it('rebuilds a dropped folder in Drive and attaches the folder itself', async () => {
    const api = client();
    wrap(api);
    await screen.findByRole('heading', { name: 'Attached files' });

    // A landing: a page, and an assets folder beside it. It only works whole,
    // so the tree is rebuilt rather than tipped into the drawer.
    drop(
      attachmentsSection(),
      [],
      [
        directoryEntry('landing-page', [
          new File(['<!doctype html>'], 'index.html', { type: 'text/html' }),
          { folder: 'assets', files: [new File(['body{}'], 'app.css', { type: 'text/css' })] }
        ])
      ]
    );

    await waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(2));
    // One Drive folder per directory: the drop folder itself, then the two.
    expect(api.ensureTaskDropFolder).toHaveBeenCalledWith(TEAM_ID, {
      name: 'landing-page',
      parentMaterialId: DROP_FOLDER
    });
    expect(api.ensureTaskDropFolder).toHaveBeenCalledWith(TEAM_ID, {
      name: 'assets',
      parentMaterialId: expect.any(String)
    });
    // The task gets one tile — the folder — not a tile per file inside it.
    await waitFor(() => expect(screen.getByText('landing-page')).toBeTruthy());
    expect(screen.queryByText('app.css')).toBeNull();
  });

  it('takes nothing from a member who may not upload', async () => {
    const api = client();
    wrap(api, 'viewer', false);
    await screen.findByRole('heading', { name: 'Attached files' });

    drop(attachmentsSection(), [new File(['one'], 'brief.pdf', { type: 'application/pdf' })]);

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(api.ensureTaskDropFolder).not.toHaveBeenCalled();
    expect(api.uploadFile).not.toHaveBeenCalled();
  });
});
