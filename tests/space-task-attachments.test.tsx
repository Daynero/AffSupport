// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 057 T030 (web half) — task attachments in an R2 space (T031). The drop folder is an ordinary
 * folder at the root, found by name or made with `create_folder` + `ensure`, and a dropped
 * folder's subfolders are made under it the same way; nothing reaches `drive-ops`. The Drive
 * link is not offered, since an R2 space has none (Soty links come with T069). A Drive space
 * keeps all of it as it was.
 */

const transport = vi.hoisted(() => ({
  calls: [] as { name: string; body: Record<string, unknown> }[]
}));

vi.mock('../apps/web/src/lib/config', async importOriginal => ({
  ...(await importOriginal<typeof import('../apps/web/src/lib/config')>()),
  siteChannel: () => 'next'
}));
vi.mock('../apps/web/src/lib/supabase', async importOriginal => {
  const client = {
    functions: {
      invoke: async (name: string, options: { body?: Record<string, unknown> }) => {
        const body = options.body ?? {};
        transport.calls.push({ name, body });
        if (name === 'space-storage/materials/mutate')
          return {
            data: {
              ok: true,
              value: {
                materials: [
                  {
                    id: body.name === 'Sub' ? SUB : DROPS,
                    teamId: R2_TEAM,
                    parentMaterialId: body.parentMaterialId ?? ROOT,
                    name: body.name,
                    kind: 'folder',
                    lifecycle: 'active',
                    materialRevision: '1',
                    contentId: null,
                    sizeBytes: null,
                    mimeType: null
                  }
                ],
                contentRevision: '3',
                created: false
              }
            },
            error: null
          };
        if (name === 'drive-ops/ensure-task-drop-folder')
          return {
            data: {
              ok: true,
              value: { folderId: 'drive-drops', materialId: DROPS, name: 'Drops', created: false }
            },
            error: null
          };
        throw new Error(`unexpected function ${name}`);
      }
    },
    rpc: async (name: string) => {
      if (name !== 'list_my_teams_v2') throw new Error(`unexpected rpc ${name}`);
      return {
        data: [
          { ...SPACE, id: DRIVE_TEAM, connection_state: 'connected', storage_backend: 'drive' },
          {
            ...SPACE,
            id: R2_TEAM,
            connection_state: 'none',
            storage_backend: 'r2',
            storage_root_material_id: ROOT
          }
        ],
        error: null
      };
    }
  };
  return {
    ...(await importOriginal<typeof import('../apps/web/src/lib/supabase')>()),
    withFreshSession: <T,>(run: () => PromiseLike<T>) => run(),
    requireSupabaseClient: () => client,
    getSupabaseClient: () => client
  };
});

import {
  DEFAULT_ROLE_PERMISSIONS,
  SPACE_TASK_DROP_FOLDER_NAME,
  type TeamTaskAttachmentSummary
} from '@video-compressor/shared';
import { teamApi, type TeamContextSnapshot } from '../apps/web/src/api/team';
import { clearSpaceStorageCaches } from '../apps/web/src/api/space-storage';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import { CopyDriveLinkButton } from '../apps/web/src/team/library/CopyDriveLinkButton';
import {
  TaskAttachmentTile,
  type TaskAttachmentPreviewClient
} from '../apps/web/src/team/tasks/TaskAttachmentTile';

const id = (n: number) => `05730000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DRIVE_TEAM = id(1);
const R2_TEAM = id(2);
const ROOT = id(3);
const DROPS = id(4);
const SUB = id(5);
const MATERIAL = id(6);
const TASK = id(7);
const SPACE = {
  name: 'Space',
  role: 'editor',
  permissions: DEFAULT_ROLE_PERMISSIONS.editor
};

const snapshot = (teamId: string): TeamContextSnapshot => ({
  id: teamId,
  name: 'Space',
  role: 'editor',
  permissions: DEFAULT_ROLE_PERMISSIONS.editor,
  connectionState: teamId === R2_TEAM ? 'none' : 'connected',
  storageBackend: teamId === R2_TEAM ? 'r2' : 'drive'
});

const wrap = (teamId: string, ui: React.ReactElement) => (
  <ToastProvider>
    <TeamProvider initialTeams={[snapshot(teamId)]} realtime={false}>
      {ui}
    </TeamProvider>
  </ToastProvider>
);

const attachment: TeamTaskAttachmentSummary = {
  id: id(8),
  taskId: TASK,
  materialId: MATERIAL,
  name: 'banner.png',
  category: 'image',
  availability: 'ready',
  previewState: 'ready',
  position: 0,
  driveVersion: null
};

function tileClient(): TaskAttachmentPreviewClient {
  return {
    previewMaterial: vi.fn().mockResolvedValue({
      kind: 'media',
      rangeUrl: 'https://files-beta.soty.pp.ua/t/x/o/y?g=grant',
      mimeType: 'image/png',
      expiresAt: '2099-01-01T00:00:00.000Z'
    }),
    listLandingRenders: vi.fn().mockResolvedValue([]),
    landingRenderImageUrl: vi.fn().mockReturnValue('https://example.test/landing.webp'),
    requestDownload: vi.fn(),
    shareLibraryMaterial: vi.fn()
  };
}

beforeEach(() => {
  localStorage.setItem('language', 'en');
  transport.calls.length = 0;
  clearSpaceStorageCaches();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the task drop folder', () => {
  it('in an R2 space is ensured at the root with create_folder, never through drive-ops', async () => {
    await teamApi.listTeams();
    const drops = await teamApi.ensureTaskDropFolder(R2_TEAM);
    expect(drops).toEqual({
      folderId: DROPS,
      materialId: DROPS,
      name: SPACE_TASK_DROP_FOLDER_NAME,
      created: false
    });
    // A dropped folder's subfolder: made (or found) under the folder it was dropped into.
    await teamApi.ensureTaskDropFolder(R2_TEAM, { name: 'Sub', parentMaterialId: DROPS });
    // A name without a parent lands inside the drops.
    await teamApi.ensureTaskDropFolder(R2_TEAM, { name: 'Sub' });
    expect(transport.calls).toEqual([
      {
        name: 'space-storage/materials/mutate',
        body: {
          teamId: R2_TEAM,
          action: 'create_folder',
          parentMaterialId: ROOT,
          name: SPACE_TASK_DROP_FOLDER_NAME,
          ensure: true
        }
      },
      {
        name: 'space-storage/materials/mutate',
        body: {
          teamId: R2_TEAM,
          action: 'create_folder',
          parentMaterialId: DROPS,
          name: 'Sub',
          ensure: true
        }
      },
      {
        name: 'space-storage/materials/mutate',
        body: {
          teamId: R2_TEAM,
          action: 'create_folder',
          parentMaterialId: ROOT,
          name: SPACE_TASK_DROP_FOLDER_NAME,
          ensure: true
        }
      },
      {
        name: 'space-storage/materials/mutate',
        body: {
          teamId: R2_TEAM,
          action: 'create_folder',
          parentMaterialId: DROPS,
          name: 'Sub',
          ensure: true
        }
      }
    ]);
  });

  it('in a Drive space still goes through drive-ops', async () => {
    await teamApi.listTeams();
    await teamApi.ensureTaskDropFolder(DRIVE_TEAM);
    expect(transport.calls).toEqual([
      { name: 'drive-ops/ensure-task-drop-folder', body: { teamId: DRIVE_TEAM } }
    ]);
  });
});

describe('the Drive link', () => {
  it('is not offered on an R2 attachment, inline or in its menu', async () => {
    const client = tileClient();
    render(
      wrap(R2_TEAM, <TaskAttachmentTile teamId={R2_TEAM} attachment={attachment} client={client} />)
    );
    await waitFor(() => expect(client.previewMaterial).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: /^Actions for/ }));
    expect(await screen.findByRole('menuitem', { name: 'Download' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Copy link' })).toBeNull();
  });

  it('is offered on a Drive attachment, as before', async () => {
    const client = tileClient();
    render(
      wrap(
        DRIVE_TEAM,
        <TaskAttachmentTile teamId={DRIVE_TEAM} attachment={attachment} client={client} />
      )
    );
    expect(await screen.findByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it('CopyDriveLinkButton renders nothing in an R2 space and the button in a Drive space', () => {
    const client = { shareLibraryMaterial: vi.fn() };
    const r2 = render(
      wrap(
        R2_TEAM,
        <CopyDriveLinkButton teamId={R2_TEAM} materialId={MATERIAL} name="a.png" client={client} />
      )
    );
    expect(screen.queryByRole('button', { name: 'Copy Drive link for a.png' })).toBeNull();
    r2.unmount();
    render(
      wrap(
        DRIVE_TEAM,
        <CopyDriveLinkButton
          teamId={DRIVE_TEAM}
          materialId={MATERIAL}
          name="a.png"
          client={client}
        />
      )
    );
    expect(screen.getByRole('button', { name: 'Copy Drive link for a.png' })).toBeTruthy();
  });
});
