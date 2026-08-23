// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessLibraryDialog } from '../apps/web/src/team/library/ProcessLibraryDialog';
import { LibraryProcessingProvider } from '../apps/web/src/team/library/LibraryProcessingProvider';
import {
  stableLibraryAgentInstanceId,
  type ProcessLibraryAgent,
  type ProcessLibraryClient
} from '../apps/web/src/team/library/process-library-contract';
import { ToastProvider } from '../apps/web/src/components/toast';

const TEAM_ID = '43000000-0000-4000-8000-000000000001';
const SOURCE_ID = '43000000-0000-4000-8000-000000000002';
const REQUIREMENT_ID = '43000000-0000-4000-8000-000000000003';
const ATTEMPT_ID = '43000000-0000-4000-8000-000000000004';
const AGENT_ID = '43000000-0000-4000-8000-000000000005';
const RESULT_ID = '43000000-0000-4000-8000-000000000006';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function grant(purpose: 'process_input' | 'finalize') {
  return {
    ticket: `opaque-${purpose}-ticket-with-enough-entropy`,
    purpose,
    expiresAt: '2026-08-14T11:00:00.000Z',
    maxRangeBytes: 1024,
    maxUses: 2
  } as const;
}

describe('Process Library confirmation UI', () => {
  it('keeps a stable opaque agent id without regenerating it', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    };
    expect(stableLibraryAgentInstanceId(storage, () => AGENT_ID)).toBe(AGENT_ID);
    expect(stableLibraryAgentInstanceId(storage, () => RESULT_ID)).toBe(AGENT_ID);
  });

  it('scans without heavy work, then processes the source only after confirmation', async () => {
    const claimLibraryJob = vi
      .fn()
      .mockResolvedValueOnce({
        teamId: TEAM_ID,
        requirementId: REQUIREMENT_ID,
        attemptId: ATTEMPT_ID,
        sourceMaterialId: SOURCE_ID,
        sourceVersion: 'version-1',
        kind: 'transcription',
        variant: 'original',
        leaseToken: 'lease-token-with-enough-entropy-123',
        leaseExpiresAt: '2026-08-14T11:00:00.000Z'
      })
      .mockRejectedValueOnce(new Error('NO_WORK'));
    const client: ProcessLibraryClient = {
      scanLibraryRequirements: vi.fn().mockResolvedValue({
        created: { transcription: 1, translation: 0, landingOptimization: 0 },
        missing: { transcription: 1, translation: 0, landingOptimization: 0 },
        ready: 0,
        started: false
      }),
      claimLibraryJob,
      getLibraryProcessingContext: vi.fn().mockResolvedValue({
        sourceMaterialId: SOURCE_ID,
        sourceName: 'clip.mp4',
        category: 'video',
        destinationFolderId: 'drive-folder-material'
      }),
      startProcess: vi.fn().mockResolvedValue({
        operationId: 'operation-1',
        state: 'pending',
        sourceGrant: grant('process_input'),
        finalizeGrant: grant('finalize'),
        agentContractVersion: 1
      }),
      heartbeatLibraryJob: vi.fn().mockResolvedValue({}),
      cancelLibraryJob: vi.fn().mockResolvedValue(true),
      failLibraryJob: vi.fn().mockResolvedValue(true),
      retryFailedLibraryJobs: vi.fn().mockResolvedValue(1),
      finalizeLibraryJob: vi.fn().mockResolvedValue({
        state: 'accepted',
        resultId: REQUIREMENT_ID,
        materialId: RESULT_ID
      }),
      cancelOperation: vi.fn().mockResolvedValue({})
    };
    const agent: ProcessLibraryAgent = {
      process: vi.fn().mockResolvedValue({
        operationId: 'operation-1',
        state: 'succeeded',
        materialId: RESULT_ID,
        reused: false
      }),
      cancel: vi.fn().mockResolvedValue(true)
    };
    const changed = vi.fn();
    // The run belongs to the space now, so the provider is what the dialog
    // views — closing the dialog no longer touches the work.
    render(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialId={SOURCE_ID}
          agentCompatible
          toolContracts={{ teamWorkspace: 1, transcription: 5 }}
          client={client}
          agent={agent}
          agentInstanceId={AGENT_ID}
          onChanged={changed}
        >
          <ProcessLibraryDialog sourceMaterialId={SOURCE_ID} agentCompatible onClose={vi.fn()} />
        </LibraryProcessingProvider>
      </ToastProvider>
    );

    expect(
      await screen.findByText('1 jobs are ready. Processing starts only after confirmation.')
    ).toBeTruthy();
    expect(client.scanLibraryRequirements).toHaveBeenCalledWith(TEAM_ID, 'en', SOURCE_ID);
    expect(client.startProcess).not.toHaveBeenCalled();
    expect(agent.process).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    await waitFor(() => expect(client.finalizeLibraryJob).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(client.startProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        materialId: SOURCE_ID,
        outputName: 'clip.transcript.version1.txt'
      })
    );
    expect(claimLibraryJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sourceMaterialId: SOURCE_ID })
    );
  });
});
