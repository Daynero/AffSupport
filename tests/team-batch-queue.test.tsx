// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '@video-compressor/shared';
import type { FolderPage, TeamMaterialRow } from '@video-compressor/shared';
import { ToastProvider } from '../apps/web/src/components/toast';
import { TeamProvider } from '../apps/web/src/team/TeamContext';
import {
  ExplorerShell,
  type ExplorerShellClient
} from '../apps/web/src/team/explorer/ExplorerShell';
import { emptyTeamRouteQuery } from '../apps/web/src/team/routes';
import { clearThumbnailSessions } from '../apps/web/src/team/explorer/useThumbnailSession';
import type { MaterialActionsClient } from '../apps/web/src/team/catalog/material-actions-client';
import { makeTeam } from './team-space-fixtures';

/**
 * The team batch queue: what it starts, what it holds, and what it names.
 *
 * Pausing (owner brief, 2026-09-02).
 *
 * Two halves, and the panel has to be honest about both: nothing new starts,
 * and the file already in flight is suspended too when the local app can do
 * that. A pause that only stopped the queue would leave the machine at full
 * load for the next twenty minutes, which is not what anyone pressed it for.
 */

const shared = vi.hoisted(() => ({
  started: [] as string[],
  pauses: [] as Array<{ operationId: string; paused: boolean }>,
  /** Lets a test end the agent's half of the run it is holding. */
  finish: null as (() => void) | null,
  /** Whether the local app admits to holding the running file. */
  holds: true,
  operations: 0,
  canceled: [] as string[],
  renamed: [] as Array<{ materialId: string; newName: string; conflictMode: string }>,
  /** Makes the agent's half of the run fail instead of hanging. */
  failStart: false
}));

vi.mock('../apps/web/src/api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/client')>();
  return {
    ...actual,
    startTeamAgentProcess: vi.fn(async (input: { operationId: string }) => {
      shared.started.push(input.operationId);
      if (shared.failStart) throw new Error('PROCESS_FAILED');
      await new Promise<void>(resolve => {
        shared.finish = resolve;
      });
      return {
        operationId: input.operationId,
        state: 'succeeded',
        materialId: `result-${input.operationId}`,
        reused: false
      };
    }),
    pauseTeamAgentProcess: vi.fn(async (operationId: string, paused: boolean) => {
      shared.pauses.push({ operationId, paused });
      return paused ? shared.holds : true;
    })
  };
});

vi.mock('../apps/web/src/api/team', async importOriginal => {
  const actual = await importOriginal<typeof import('../apps/web/src/api/team')>();
  const grant = {
    ticket: 'opaque-ticket-with-enough-entropy',
    purpose: 'process_input',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxRangeBytes: 1024,
    maxUses: 4
  };
  return {
    ...actual,
    teamApi: {
      ...actual.teamApi,
      startProcess: vi.fn(async () => {
        shared.operations += 1;
        return {
          operationId: `op-${shared.operations}`,
          sourceGrant: grant,
          finalizeGrant: { ...grant, purpose: 'finalize' }
        };
      }),
      cancelOperation: vi.fn(async (_team: string, operationId: string) => {
        shared.canceled.push(operationId);
        return {
          operationId,
          state: 'canceled',
          stage: 'canceled',
          progress: 0,
          errorCode: null,
          retryable: false,
          resultMaterialId: null,
          updatedAt: new Date().toISOString()
        };
      }),
      getOperation: vi.fn(async (_team: string, operationId: string) => ({
        operationId,
        state: 'running',
        stage: 'processing',
        progress: 30,
        errorCode: null,
        retryable: false,
        resultMaterialId: null,
        updatedAt: new Date().toISOString()
      })),
      listVideoTextVariants: vi.fn(async (_team: string, videoId: string) => ({
        videoId,
        canProcess: true,
        variants: []
      })),
      getTranscriptCompanion: vi.fn(async () => null),
      getTranscriptDeletePref: vi.fn(async () => 'ask' as const)
    }
  };
});

const TEAM = makeTeam({ permissions: DEFAULT_ROLE_PERMISSIONS.admin, role: 'admin' });

afterEach(() => {
  cleanup();
  clearThumbnailSessions();
  localStorage.clear();
  shared.started.length = 0;
  shared.pauses.length = 0;
  shared.finish = null;
  shared.holds = true;
  shared.operations = 0;
  shared.canceled.length = 0;
  shared.renamed.length = 0;
  shared.failStart = false;
  vi.clearAllMocks();
});

function video(index: number): TeamMaterialRow {
  return {
    id: `id-${index}`,
    teamId: TEAM.id,
    name: `clip-${index}.mp4`,
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    sizeBytes: 100,
    kind: 'video',
    driveFileId: `drive-${index}`,
    parentFolderId: 'root',
    modifiedAt: null,
    driveVersion: '1',
    previewState: 'ready',
    thumbnailReady: false
  };
}

function makeClient(rows: TeamMaterialRow[]): ExplorerShellClient {
  return {
    listFolderTree: vi.fn().mockResolvedValue([]),
    listFolderPage: vi.fn(async (): Promise<FolderPage> => ({
      rows,
      total: rows.length,
      next: null
    })),
    mintThumbnailSession: vi.fn().mockRejectedValue(new Error('no session in this test')),
    thumbnailUrl: () => '',
    listMaterials: vi.fn().mockResolvedValue([]),
    searchCatalog: vi.fn(),
    getCatalogVocabulary: vi
      .fn()
      .mockResolvedValue({ geo: [], languages: [], offers: [], tags: [] }),
    updateMaterialMetadata: vi.fn()
  } as unknown as ExplorerShellClient;
}

/** Records what the queue asks of the file actions, and agrees to all of it. */
const actionsClient = {
  renameMaterial: vi.fn(
    async (input: { materialId: string; newName: string; conflictMode: string }) => {
      shared.renamed.push({
        materialId: input.materialId,
        newName: input.newName,
        conflictMode: input.conflictMode
      });
      return {
        operationId: 'rename',
        state: 'succeeded',
        materialId: input.materialId,
        reused: false
      };
    }
  ),
  trashMaterial: vi.fn(async () => undefined)
} as unknown as MaterialActionsClient;

function renderShell(rows: TeamMaterialRow[]) {
  // The space the person is in comes from the device, and the batch only exists
  // for someone allowed to process files.
  localStorage.setItem('wishly.active-team.v1', TEAM.id);
  render(
    <ToastProvider>
      <TeamProvider realtime={false} initialTeams={[TEAM]}>
        <ExplorerShell
          teamId={TEAM.id}
          client={makeClient(rows)}
          query={{ ...emptyTeamRouteQuery(), view: 'list' }}
          onQueryChange={vi.fn()}
          onFolderChange={vi.fn()}
          onSearched={vi.fn()}
          onPreview={vi.fn()}
          actionsClient={actionsClient}
        />
      </TeamProvider>
    </ToastProvider>
  );
}

/** Selects a row and starts its transcription from the side card. */
async function transcribe(name: string) {
  const row = await screen.findByText(name);
  fireEvent.click(row);
  const button = await screen.findByRole('button', { name: 'Transcribe' });
  fireEvent.click(button);
}

describe('pausing the team batch', () => {
  it('holds the queue and the file in flight, then lets both go', async () => {
    renderShell([video(1), video(2)]);
    await transcribe('clip-1.mp4');
    await transcribe('clip-2.mp4');
    await waitFor(() => expect(shared.started).toEqual(['op-1']));

    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(shared.pauses).toEqual([{ operationId: 'op-1', paused: true }]));
    await screen.findByText('Paused — the file in flight is suspended too');

    // The first run ends while the batch is held: the second must stay where it is.
    shared.finish?.();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(shared.started).toEqual(['op-1']);
    await screen.findByText('Paused — 1 waiting');

    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(shared.started).toEqual(['op-1', 'op-2']));
  });

  it('says the current file is finishing when the local app cannot hold it', async () => {
    // An older agent, a transfer rather than an encode: the queue is still
    // paused, but the panel must not promise a quiet machine.
    shared.holds = false;
    renderShell([video(1), video(2)]);
    await transcribe('clip-1.mp4');
    await transcribe('clip-2.mp4');
    await waitFor(() => expect(shared.started).toEqual(['op-1']));

    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await screen.findByText('Paused — the file in flight is finishing first');
    expect(shared.started).toEqual(['op-1']);
  });

  it('closes the operation of an item that failed on the local app', async () => {
    // Left running, it would hold its output name reserved for good and the
    // next attempt at the same file would be refused for conflicting with a run
    // that is not happening.
    shared.failStart = true;
    renderShell([video(1)]);
    await transcribe('clip-1.mp4');

    await waitFor(() => expect(shared.canceled).toEqual(['op-1']));
  });

  it('lets the current file go when the rest of the queue is dropped', async () => {
    // "Stop after the current one" needs a current one that is still moving.
    renderShell([video(1), video(2)]);
    await transcribe('clip-1.mp4');
    await transcribe('clip-2.mp4');
    await waitFor(() => expect(shared.started).toEqual(['op-1']));

    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(shared.pauses).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop after current' }));

    await waitFor(() =>
      expect(shared.pauses.at(-1)).toEqual({ operationId: 'op-1', paused: false })
    );
    shared.finish?.();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull());
    expect(shared.started).toEqual(['op-1']);
  });
});

describe('what the batch names its output', () => {
  it("gives a transcript its video's name, even on a repeat", async () => {
    // A repeat is written while the transcript it replaces is still there, so
    // the conflict rule hands it "clip-1 (2).txt" and the old one is retired
    // moments later — leaving a parenthesis on the file for good, one more with
    // every run. The canonical name is asked for once the name is free.
    renderShell([video(1)]);
    await transcribe('clip-1.mp4');
    await waitFor(() => expect(shared.started).toEqual(['op-1']));

    shared.finish?.();

    await waitFor(() =>
      expect(shared.renamed).toEqual([
        {
          materialId: 'result-op-1',
          newName: 'clip-1.txt',
          // Never a duplicate: if something live still holds the name, the
          // rename is refused and the output keeps the one it landed with.
          conflictMode: 'cancel'
        }
      ])
    );
  });
});
