// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { FolderPage, TeamFolderNode } from '@video-compressor/shared';
import { AGENT_TOOL_CONTRACTS, DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  ExplorerShell,
  type ExplorerShellClient
} from '../apps/web/src/team/explorer/ExplorerShell';
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import { teamApi } from '../apps/web/src/api/team';
import { startTeamAgentProcess } from '../apps/web/src/api/client';
import { uploadTeamFile } from '../apps/web/src/team/catalog/material-actions-client';
import { AgentContextOverride } from '../apps/web/src/AgentContext';
import { fakeAgentValue } from './support/fake-agent';
import { makeTeam } from './team-space-fixtures';

/*
 * A drop with videos in it asks once, in the drop zone, whether they go in as they are or with
 * the stitching cut off (070, owner 2026-11-24). Not remembered: the next drop asks again, with
 * the last answer highlighted so Enter repeats it. Esc calls the drop off.
 */

vi.mock('../apps/web/src/team/catalog/material-actions-client', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../apps/web/src/team/catalog/material-actions-client')>();
  return {
    ...actual,
    uploadTeamFile: vi.fn(async (input: { file: File }) => ({
      state: 'succeeded',
      materialId: `material-${input.file.name}`
    }))
  };
});
vi.mock('../apps/web/src/api/team', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/team')>();
  return {
    ...actual,
    teamApi: {
      ...actual.teamApi,
      startProcess: vi.fn(async () => ({
        operationId: 'trim-operation',
        sourceGrant: { s: 1 },
        finalizeGrant: { f: 1 }
      })),
      cancelOperation: vi.fn(async () => undefined)
    }
  };
});
vi.mock('../apps/web/src/api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/client')>();
  return {
    ...actual,
    startTeamAgentProcess: vi.fn(async () => ({ state: 'succeeded', materialId: 'trimmed' }))
  };
});

const team = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });
const folders: TeamFolderNode[] = [
  {
    id: 'drive-a',
    driveFileId: 'drive-a',
    parentFolderId: null,
    selectionId: null,
    name: 'Creatives',
    indexedAt: '2026-09-25T00:00:00Z',
    childFolderCount: 0,
    childFileCount: 0,
    thumbnailReadyCount: 0
  }
];

function client(): ExplorerShellClient {
  return {
    listFolderTree: vi.fn().mockResolvedValue(folders),
    listFolderPage: vi.fn(async (): Promise<FolderPage> => ({ rows: [], total: 0, next: null })),
    mintThumbnailSession: vi.fn().mockRejectedValue(new Error('unused')),
    thumbnailUrl: () => '',
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn(),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn()
  } as unknown as ExplorerShellClient;
}

function shell(agentReady = true) {
  return (
    <AgentContextOverride
      value={fakeAgentValue(
        agentReady
          ? { toolContracts: AGENT_TOOL_CONTRACTS }
          : {
              connection: 'not_installed_or_not_running',
              connectedOnce: false,
              teamWorkspaceAvailable: false,
              teamWorkspaceAvailability: 'disconnected'
            }
      )}
    >
      <ToastProvider>
        <TeamProvider realtime={false} initialTeams={[team]}>
          <ExplorerShell
            teamId={team.id}
            client={client()}
            query={{ ...emptyTeamRouteQuery(), folderId: 'drive-a', view: 'list' }}
            onQueryChange={vi.fn()}
            onFolderChange={vi.fn()}
            onSearched={vi.fn()}
            onPreview={vi.fn()}
          />
        </TeamProvider>
      </ToastProvider>
    </AgentContextOverride>
  );
}

const video = () => new File(['video'], 'hook.mp4', { type: 'video/mp4' });
const picture = () => new File(['png'], 'cover.png', { type: 'image/png' });

async function drop(...files: File[]) {
  await waitFor(() => expect(document.querySelector('.team-explorer-dropzone')).toBeTruthy());
  fireEvent.drop(document.querySelector('.team-explorer-dropzone')!, {
    dataTransfer: {
      types: ['Files'],
      files,
      items: files.map(file => ({
        kind: 'file',
        webkitGetAsEntry: () => null,
        getAsFile: () => file
      }))
    }
  });
}

const QUESTION = /Videos in this upload: 1/u;

beforeEach(() => localStorage.setItem('wishly.active-team.v1', team.id));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('a drop with videos asks once about them', () => {
  it('asks once for the whole drop, in the drop zone, not in a dialog', async () => {
    render(shell());
    await drop(video(), picture());
    const question = await screen.findByRole('group', { name: QUESTION });
    expect(screen.getAllByRole('group', { name: QUESTION })).toHaveLength(1);
    expect(question.closest('.team-explorer-dropzone')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    // Nothing goes up while the drop waits for its answer.
    expect(uploadTeamFile).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Original' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trim the stitching' })).toBeTruthy();
  });

  it('asks nothing when the drop has no video', async () => {
    render(shell());
    await drop(picture());
    await waitFor(() => expect(uploadTeamFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('group', { name: /Videos in this upload/u })).toBeNull();
  });

  it('asks nothing when the stitching cannot be cut here: the videos go in as they are', async () => {
    render(shell(false));
    await drop(video());
    await waitFor(() => expect(uploadTeamFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('group', { name: /Videos in this upload/u })).toBeNull();
    expect(teamApi.startProcess).not.toHaveBeenCalled();
  });

  it('Enter takes the highlighted last choice and trims only the videos, in place', async () => {
    localStorage.setItem('soty.upload-video-choice.v1', 'trim');
    render(shell());
    await drop(video(), picture());
    await screen.findByRole('group', { name: QUESTION });
    const trim = screen.getByRole('button', { name: 'Trim the stitching' });
    await waitFor(() => expect(document.activeElement).toBe(trim));
    expect(trim.className).toContain('ui-color-primary');
    expect(screen.getByRole('button', { name: 'Original' }).className).not.toContain(
      'ui-color-primary'
    );

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(uploadTeamFile).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('group', { name: QUESTION })).toBeNull();
    await waitFor(() => expect(teamApi.startProcess).toHaveBeenCalledTimes(1));
    expect(teamApi.startProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        materialId: 'material-hook.mp4',
        toolId: 'restitch',
        versionOfMaterialId: 'material-hook.mp4',
        outputName: 'hook.mp4'
      })
    );
    await waitFor(() =>
      expect(startTeamAgentProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: 'restitch',
          options: expect.objectContaining({
            defaults: expect.objectContaining({ operation: 'unstitch', configured: true })
          })
        })
      )
    );
  });

  it('the answer is not a rule: the next drop asks again, with that answer first', async () => {
    render(shell());
    await drop(video());
    await screen.findByRole('group', { name: QUESTION });
    // Nothing chosen before: "original" is the one Enter takes.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Original' }))
    );
    await userEvent.click(screen.getByRole('button', { name: 'Trim the stitching' }));
    await waitFor(() => expect(uploadTeamFile).toHaveBeenCalledTimes(1));

    await drop(video());
    await screen.findByRole('group', { name: QUESTION });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Trim the stitching' })
      )
    );
    await userEvent.click(screen.getByRole('button', { name: 'Original' }));
    await waitFor(() => expect(uploadTeamFile).toHaveBeenCalledTimes(2));
    expect(localStorage.getItem('soty.upload-video-choice.v1')).toBe('original');
  });

  it('Esc calls the whole drop off', async () => {
    render(shell());
    await drop(video(), picture());
    await screen.findByRole('group', { name: QUESTION });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('group', { name: QUESTION })).toBeNull());
    expect(uploadTeamFile).not.toHaveBeenCalled();
    expect(teamApi.startProcess).not.toHaveBeenCalled();
  });
});

describe('a trim written over its upload is not a catalog copy', () => {
  it('the finalize records (and shares) only re-stitches that made a new file', async () => {
    const source = await readFile('supabase/functions/drive-ops/index.ts', 'utf8');
    const record = source.slice(
      source.indexOf('// 023: a re-stitched copy the updater asked for'),
      source.indexOf('await recordRestitchOutput(')
    );
    expect(record).toContain("operation.toolId === 'restitch'");
    expect(record).toContain('!operation.versionOfMaterialId');
  });
});
