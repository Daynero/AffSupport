// @vitest-environment jsdom

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogMaterialItem,
  TeamMaterialProvenanceEntry,
  TeamPermissions
} from '@video-compressor/shared';
import { MaterialRowMenu } from '../apps/web/src/team/catalog/MaterialRowMenu.js';
import { ToastProvider } from '../apps/web/src/components/toast.js';
import type { MaterialActionsClient } from '../apps/web/src/team/catalog/material-actions-client.js';
import { TeamTextEditor } from '../apps/web/src/team/catalog/TeamTextEditor.js';
import { OperationStatus } from '../apps/web/src/team/processing/OperationStatus.js';
import {
  ProcessMaterialDialog,
  type ProcessMaterialClient
} from '../apps/web/src/team/processing/ProcessMaterialDialog.js';
import { ProvenancePanel } from '../apps/web/src/team/catalog/ProvenancePanel.js';
import { analytics } from '../apps/web/src/analytics/service.js';

const TEAM_ID = '42000000-0000-4000-8000-000000000001';

function material(overrides: Partial<CatalogMaterialItem> = {}): CatalogMaterialItem {
  return {
    id: 'material-1',
    teamId: TEAM_ID,
    name: 'creative.mp4',
    kind: 'file',
    category: 'video',
    mimeType: 'video/mp4',
    fileExtension: 'mp4',
    classificationVersion: 1,
    classificationSource: 'mime',
    sizeBytes: 1024,
    modifiedAt: '2026-08-01T12:00:00.000Z',
    geo: 'US',
    language: 'en',
    offer: 'Evergreen',
    tags: ['UGC'],
    transcriptIngestState: 'not_applicable',
    transcriptTruncated: false,
    previewState: 'ready',
    lineage: { hasSource: false, hasDerivatives: false, isVersion: false },
    ...overrides
  };
}

function permissions(overrides: Partial<TeamPermissions> = {}): TeamPermissions {
  return {
    view: true,
    download: true,
    upload: false,
    edit: false,
    delete: false,
    process: false,
    manage_members: false,
    manage_metadata: false,
    ...overrides
  };
}

function actionsClient(): MaterialActionsClient {
  return {
    uploadFile: vi.fn().mockResolvedValue({
      operationId: 'upload-operation',
      state: 'succeeded',
      materialId: 'uploaded-material',
      reused: false
    }),
    requestDownload: vi.fn().mockResolvedValue({
      kind: 'browser',
      rangeUrl: 'https://project.supabase.co/download',
      expiresAt: '2026-08-01T12:05:00.000Z',
      disposition: 'attachment'
    }),
    downloadWithAgent: vi.fn().mockResolvedValue({ saved: true }),
    renameMaterial: vi.fn(),
    moveMaterial: vi.fn(),
    trashMaterial: vi.fn(),
    restoreMaterial: vi.fn()
  };
}

beforeEach(() => localStorage.setItem('language', 'en'));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const browseClient = { listMaterials: vi.fn().mockResolvedValue([]) };

/**
 * Waits for a dialog's opening focus move to land.
 *
 * `Modal` places the caret on its initial field in a `requestAnimationFrame`,
 * which in a browser happens long before anyone can type. In jsdom the frame
 * can fall between two of a test's keystrokes, and the focus move then eats the
 * rest of the word — so tests wait for that frame before they start typing.
 */
async function modalFocusSettled() {
  await act(async () => {
    await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
  });
}

/**
 * Renders the row menu and opens it.
 *
 * Opening is a real step now, not test ceremony: the menu mounts its contents
 * only while it is open, which is what keeps a fifty-row page from mounting
 * fifty copies of this state (SC-009).
 */
async function openMenu(element: React.ReactElement) {
  // The row actions report every outcome through the shared toast channel, so
  // the provider is part of what they need to work — not test scaffolding.
  const result = render(<ToastProvider>{element}</ToastProvider>);
  await userEvent.click(screen.getByRole('button', { name: /^Actions for / }));
  return result;
}

describe('team file operations', () => {
  it('requires an explicit upload conflict choice and can keep both without implicit replace', async () => {
    const client = actionsClient();
    vi.mocked(client.uploadFile)
      .mockRejectedValueOnce(new Error('NAME_CONFLICT'))
      .mockResolvedValueOnce({
        operationId: 'upload-operation',
        state: 'succeeded',
        materialId: 'uploaded-material',
        reused: false
      });
    const changed = vi.fn();
    await openMenu(
      <MaterialRowMenu
        teamId={TEAM_ID}
        material={material({
          id: 'folder-1',
          name: 'Uploads',
          kind: 'folder',
          category: null,
          mimeType: 'application/vnd.google-apps.folder',
          fileExtension: null
        })}
        permissions={permissions({ upload: true, edit: true })}
        client={client}
        browseClient={browseClient}
        onChanged={changed}
      />
    );
    const file = new File(['video'], 'creative.mp4', { type: 'video/mp4' });
    await userEvent.upload(screen.getByLabelText('Upload file'), file);
    expect(await screen.findByText('A file with this name already exists.')).toBeTruthy();
    expect(client.uploadFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ conflictMode: 'cancel', replaceMaterialId: null })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Keep both' }));
    await waitFor(() => expect(client.uploadFile).toHaveBeenCalledTimes(2));
    expect(client.uploadFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ conflictMode: 'keep_both', replaceMaterialId: null })
    );
    expect(changed).toHaveBeenCalledOnce();
  });

  it('keeps download, edit, delete, and process permissions independent', async () => {
    const client = actionsClient();
    const { rerender } = await openMenu(
      <MaterialRowMenu
        teamId={TEAM_ID}
        material={material()}
        permissions={permissions()}
        client={client}
        browseClient={browseClient}
        onChanged={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move to trash' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Process' })).toBeNull();

    rerender(
      <ToastProvider>
        <MaterialRowMenu
          teamId={TEAM_ID}
          material={material()}
          permissions={permissions({ edit: true, delete: true, process: true })}
          client={client}
          browseClient={browseClient}
          onChanged={vi.fn()}
        />
      </ToastProvider>
    );
    expect(screen.getByRole('button', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move to trash' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Process' })).toBeTruthy();
  });

  it('hands browser-cutoff downloads to the compatible local agent', async () => {
    const client = actionsClient();
    vi.mocked(client.requestDownload)
      .mockRejectedValueOnce(new Error('AGENT_REQUIRED'))
      .mockResolvedValueOnce({
        kind: 'agent',
        transferUrl: 'https://project.supabase.co/functions/v1/drive-transfer/range',
        grant: {
          ticket: 'opaque-download-ticket-with-enough-entropy',
          purpose: 'download_range',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          maxRangeBytes: 32 * 1024 * 1024,
          maxUses: 8
        }
      });
    await openMenu(
      <MaterialRowMenu
        teamId={TEAM_ID}
        material={material({ sizeBytes: 101 * 1024 * 1024 })}
        permissions={permissions()}
        client={client}
        browseClient={browseClient}
        onChanged={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => expect(client.downloadWithAgent).toHaveBeenCalledOnce());
    expect(client.requestDownload).toHaveBeenNthCalledWith(1, TEAM_ID, 'material-1', 'browser');
    expect(client.requestDownload).toHaveBeenNthCalledWith(2, TEAM_ID, 'material-1', 'agent');
    expect(client.downloadWithAgent).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'creative.mp4' })
    );
  });

  it('emits only bucketed file-attempt analytics from a real action', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const track = vi.spyOn(analytics, 'track');
    const client = actionsClient();
    await openMenu(
      <MaterialRowMenu
        teamId={TEAM_ID}
        material={material({ sizeBytes: 24 * 1024 * 1024 })}
        permissions={permissions()}
        storageKind="shared_drive"
        client={client}
        browseClient={browseClient}
        onChanged={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(track).toHaveBeenCalledWith(
        'team_file_attempt_completed',
        expect.objectContaining({
          action: 'download',
          storage_kind: 'shared_drive',
          size_bucket: 'medium',
          outcome: 'success',
          retryable: false,
          production_completed: true
        })
      )
    );
    const payload = JSON.stringify(track.mock.calls);
    expect(payload).not.toMatch(/material-1|creative\.mp4|team_id|material_id|filename|path/i);
  });

  it('saves complete UTF-8 TXT and offers reload or a separate version on stale identity', async () => {
    const save = vi.fn().mockRejectedValue(new Error('SOURCE_CHANGED'));
    const reload = vi.fn();
    const createVersion = vi.fn();
    render(
      <ToastProvider>
        <TeamTextEditor
          material={material({
            name: 'copy.txt',
            category: 'transcript',
            mimeType: 'text/plain',
            fileExtension: 'txt'
          })}
          initialText="Привіт"
          expectedDriveVersion="7"
          expectedChecksum="check-7"
          onSave={save}
          onReload={reload}
          onCreateVersion={createVersion}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    const editor = screen.getByRole('textbox', { name: 'Text file contents' });
    await modalFocusSettled();
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Повний UTF-8 текст 🌻');
    await userEvent.click(screen.getByRole('button', { name: 'Save text' }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Повний UTF-8 текст 🌻',
        expectedDriveVersion: '7',
        expectedChecksum: 'check-7'
      })
    );
    expect(await screen.findByText('This file changed in Drive.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save as separate version' }));
    expect(reload).toHaveBeenCalledOnce();
    expect(createVersion).toHaveBeenCalledWith('Повний UTF-8 текст 🌻');
  });

  it('combines local progress with authoritative state and exposes cancel/retry', async () => {
    const cancel = vi.fn();
    const retry = vi.fn();
    const { rerender } = render(
      <OperationStatus
        operation={{
          id: 'operation-1',
          teamId: TEAM_ID,
          kind: 'process',
          state: 'running',
          stage: 'processing',
          progress: 35,
          sourceMaterialId: 'material-1',
          resultMaterialId: null,
          errorCode: null,
          retryable: false,
          createdAt: '2026-08-01T12:00:00.000Z',
          updatedAt: '2026-08-01T12:00:01.000Z'
        }}
        localProgress={{ stage: 'uploading', progress: 72 }}
        onCancel={cancel}
        onRetry={retry}
      />
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('72');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel operation' }));
    expect(cancel).toHaveBeenCalledOnce();

    rerender(
      <OperationStatus
        operation={{
          id: 'operation-1',
          teamId: TEAM_ID,
          kind: 'process',
          state: 'failed',
          stage: 'uploading',
          progress: 72,
          sourceMaterialId: 'material-1',
          resultMaterialId: null,
          errorCode: 'DRIVE_UNAVAILABLE',
          retryable: true,
          createdAt: '2026-08-01T12:00:00.000Z',
          updatedAt: '2026-08-01T12:00:02.000Z'
        }}
        localProgress={null}
        onCancel={cancel}
        onRetry={retry}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Retry operation' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('blocks an old agent and starts a compatible process with explicit destination/name', async () => {
    const client: ProcessMaterialClient = {
      start: vi.fn().mockResolvedValue({
        operationId: 'process-operation',
        state: 'running',
        sourceGrant: {
          ticket: 'opaque-source-ticket-with-enough-entropy',
          purpose: 'process_input',
          expiresAt: '2026-08-01T12:05:00.000Z',
          maxRangeBytes: 33_554_432,
          maxUses: 8
        },
        finalizeGrant: {
          ticket: 'opaque-finalize-ticket-with-enough-entropy',
          purpose: 'finalize',
          expiresAt: '2026-08-01T12:05:00.000Z',
          maxRangeBytes: 33_554_432,
          maxUses: 2
        },
        agentContractVersion: 1
      })
    };
    const { rerender } = render(
      <ToastProvider>
        <ProcessMaterialDialog
          teamId={TEAM_ID}
          material={material()}
          destinationFolderId="folder-1"
          browseClient={browseClient}
          agentCompatible={false}
          toolContracts={{}}
          client={client}
          onStarted={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    expect(screen.getByText('Update Soty to process these files.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Start processing' }) as HTMLButtonElement).disabled
    ).toBe(true);

    rerender(
      <ToastProvider>
        <ProcessMaterialDialog
          teamId={TEAM_ID}
          material={material()}
          destinationFolderId="folder-1"
          browseClient={browseClient}
          agentCompatible
          toolContracts={{ compressor: 3 }}
          client={client}
          onStarted={vi.fn()}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    // The dialog puts the caret in the output name on open; wait for that to
    // land before typing, or the focus move arrives mid-word.
    await modalFocusSettled();
    await userEvent.clear(screen.getByLabelText('Output name'));
    await userEvent.type(screen.getByLabelText('Output name'), 'creative-optimized.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    expect(client.start).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationFolderId: 'folder-1',
        outputName: 'creative-optimized.mp4',
        conflictMode: 'cancel',
        toolId: 'compressor'
      })
    );
  });

  it('shows durable provenance snapshots, version branches, and inherited metadata', async () => {
    const entries: TeamMaterialProvenanceEntry[] = [
      {
        linkId: 'link-1',
        relation: 'processed_from',
        sourceMaterialId: 'source-1',
        derivativeMaterialId: 'material-1',
        sourceNameSnapshot: 'original-name.mp4',
        sourceName: 'renamed-source.mp4',
        sourceLifecycle: 'active',
        derivativeName: 'creative.mp4',
        derivativeLifecycle: 'active',
        toolId: 'compressor',
        toolContractVersion: 3,
        createdAt: '2026-08-01T12:00:00.000Z'
      },
      {
        linkId: 'link-2',
        relation: 'version_of',
        sourceMaterialId: 'source-1',
        derivativeMaterialId: 'version-2',
        sourceNameSnapshot: 'original-name.mp4',
        sourceName: 'renamed-source.mp4',
        sourceLifecycle: 'active',
        derivativeName: 'creative-v2.mp4',
        derivativeLifecycle: 'active',
        toolId: null,
        toolContractVersion: null,
        createdAt: '2026-08-01T12:01:00.000Z'
      }
    ];
    const navigate = vi.fn();
    render(
      <ProvenancePanel
        materialId="material-1"
        entries={entries}
        inheritedMetadata={{ geo: 'US', language: 'en', offer: 'Evergreen', tags: ['UGC'] }}
        onNavigate={navigate}
      />
    );
    expect(screen.getAllByText('original-name.mp4')).toHaveLength(2);
    expect(screen.getByText('Current name: renamed-source.mp4')).toBeTruthy();
    expect(screen.getByText('Version branch')).toBeTruthy();
    expect(screen.getByText(/US · en · Evergreen · UGC/u)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open source original-name.mp4' }));
    expect(navigate).toHaveBeenCalledWith('source-1');
  });
});
