// @vitest-environment jsdom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../apps/web/src/components/toast';
import {
  LibraryProcessingProvider,
  useLibraryProcessing
} from '../apps/web/src/team/library/LibraryProcessingProvider';
import { ProcessLibraryDialog } from '../apps/web/src/team/library/ProcessLibraryDialog';
import { BackgroundWorkChip } from '../apps/web/src/team/workspace/BackgroundWorkChip';
import type {
  ProcessLibraryAgent,
  ProcessLibraryClient
} from '../apps/web/src/team/library/process-library-contract';

/**
 * US7 — background work is background.
 *
 * Closing the batch dialog used to cancel the batch: the claim loop lived
 * inside the dialog, so its unmount released the lease (finding B1). The run
 * belongs to the space now, and these assertions are what keep it there.
 */

const TEAM_ID = '43000000-0000-4000-8000-000000000001';
const SOURCE_ID = '43000000-0000-4000-8000-000000000002';
const AGENT_ID = '43000000-0000-4000-8000-000000000005';

afterEach(() => {
  vi.restoreAllMocks();
});

function scan(count: number) {
  return {
    missing: { transcription: count, translation: 0, landingOptimization: 0 },
    scannedAt: '2026-08-20T10:00:00.000Z'
  };
}

function grant(purpose: 'process_input' | 'finalize') {
  return {
    ticket: `opaque-${purpose}-ticket-with-enough-entropy`,
    purpose,
    expiresAt: '2026-08-14T11:00:00.000Z',
    maxRangeBytes: 1024,
    maxUses: 2
  } as const;
}

/** A client whose claim loop is driven one job at a time by the test. */
function makeClient(jobs: number) {
  let remaining = jobs;
  const client = {
    scanLibraryRequirements: vi.fn().mockResolvedValue(scan(jobs)),
    claimLibraryJob: vi.fn().mockImplementation(async () => {
      if (remaining <= 0) throw new Error('NO_WORK');
      remaining -= 1;
      return {
        attemptId: `attempt-${remaining}`,
        requirementId: `requirement-${remaining}`,
        sourceMaterialId: SOURCE_ID,
        kind: 'transcription' as const,
        variant: null,
        sourceVersion: 'version1',
        leaseToken: 'lease-token'
      };
    }),
    getLibraryProcessingContext: vi
      .fn()
      .mockResolvedValue({ sourceName: 'clip.mp4', destinationFolderId: 'folder-1' }),
    startProcess: vi.fn().mockResolvedValue({
      operationId: 'operation-1',
      sourceGrant: grant('process_input'),
      finalizeGrant: grant('finalize')
    }),
    heartbeatLibraryJob: vi.fn().mockResolvedValue(true),
    cancelLibraryJob: vi.fn().mockResolvedValue(true),
    failLibraryJob: vi.fn().mockResolvedValue(true),
    retryFailedLibraryJobs: vi.fn().mockResolvedValue(1),
    finalizeLibraryJob: vi.fn().mockResolvedValue({ state: 'accepted' }),
    cancelOperation: vi.fn().mockResolvedValue(true)
  };
  return client as unknown as ProcessLibraryClient & typeof client;
}

function makeAgent(): ProcessLibraryAgent & { process: ReturnType<typeof vi.fn> } {
  return {
    process: vi.fn().mockResolvedValue({
      state: 'succeeded',
      materialId: '43000000-0000-4000-8000-00000000000a'
    }),
    cancel: vi.fn().mockResolvedValue(true)
  } as never;
}

function Harness({
  client,
  agent,
  showDialog
}: {
  client: ProcessLibraryClient;
  agent: ProcessLibraryAgent;
  showDialog: boolean;
}) {
  return (
    <ToastProvider>
      <LibraryProcessingProvider
        teamId={TEAM_ID}
        sourceMaterialId={SOURCE_ID}
        agentCompatible
        toolContracts={{ teamWorkspace: 1, transcription: 5 }}
        client={client}
        agent={agent}
        agentInstanceId={AGENT_ID}
      >
        <BackgroundWorkChip onOpen={vi.fn()} />
        <Starter />
        {showDialog && (
          <ProcessLibraryDialog sourceMaterialId={SOURCE_ID} agentCompatible onClose={vi.fn()} />
        )}
      </LibraryProcessingProvider>
    </ToastProvider>
  );
}

/** Starts the batch without going through the dialog, so closing it is testable. */
function Starter() {
  const batch = useLibraryProcessing();
  return (
    <button type="button" onClick={() => void batch.start()}>
      start-batch
    </button>
  );
}

describe('the batch outlives its window', () => {
  it('keeps running after the dialog is closed', async () => {
    const client = makeClient(2);
    const agent = makeAgent();
    let release!: () => void;
    // Hold the first job so the dialog can be closed mid-run.
    vi.mocked(agent.process).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () =>
            resolve({
              state: 'succeeded',
              materialId: '43000000-0000-4000-8000-00000000000a'
            } as never);
        })
    );

    const { rerender } = render(<Harness client={client} agent={agent} showDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'start-batch' }));
    await waitFor(() => expect(agent.process).toHaveBeenCalledTimes(1));

    // Close the dialog. Nothing about the run may change.
    rerender(<Harness client={client} agent={agent} showDialog={false} />);
    expect(client.cancelLibraryJob).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(client.finalizeLibraryJob).toHaveBeenCalledTimes(2));
  });

  it('shows progress in the header while it runs, and nothing when it does not', async () => {
    const client = makeClient(1);
    const agent = makeAgent();
    let release!: () => void;
    vi.mocked(agent.process).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () =>
            resolve({
              state: 'succeeded',
              materialId: '43000000-0000-4000-8000-00000000000a'
            } as never);
        })
    );

    render(<Harness client={client} agent={agent} showDialog={false} />);
    const chip = () => screen.queryByRole('button', { name: /Background processing/u });
    expect(chip()).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'start-batch' }));
    expect(
      await screen.findByRole('button', { name: 'Background processing — 0 of 1 done' })
    ).toBeTruthy();

    release();
    await waitFor(() => expect(chip()).toBeNull());
  });
});

describe('the batch says how it ended', () => {
  it('summarizes a clean run', async () => {
    const client = makeClient(1);
    render(<Harness client={client} agent={makeAgent()} showDialog={false} />);

    await userEvent.click(screen.getByRole('button', { name: 'start-batch' }));
    expect(await screen.findByText('Processing finished — 1 file done')).toBeTruthy();
  });

  it('never lets a partial failure read as success, and names what failed', async () => {
    const client = makeClient(1);
    const agent = makeAgent();
    vi.mocked(agent.process).mockRejectedValue(new Error('CORRUPT_OR_PROTECTED'));
    render(<Harness client={client} agent={agent} showDialog={false} />);

    await userEvent.click(screen.getByRole('button', { name: 'start-batch' }));
    expect(await screen.findByText('Processing finished with 1 failure: clip.mp4')).toBeTruthy();
    expect(screen.queryByText(/finished — /u)).toBeNull();
  });

  it('says so when there was nothing to do', async () => {
    const client = makeClient(0);
    render(<Harness client={client} agent={makeAgent()} showDialog={false} />);

    await userEvent.click(screen.getByRole('button', { name: 'start-batch' }));
    expect(await screen.findByText('Nothing left to process')).toBeTruthy();
  });
});

describe('stopping is a decision, not a side effect', () => {
  it('asks before stopping, then releases the attempt', async () => {
    const client = makeClient(2);
    const agent = makeAgent();
    vi.mocked(agent.process).mockImplementation(() => new Promise(() => undefined));

    render(<Harness client={client} agent={agent} showDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'start-batch' }));
    await waitFor(() => expect(agent.process).toHaveBeenCalledTimes(1));

    await userEvent.click(await screen.findByRole('button', { name: 'Stop processing' }));
    expect(await screen.findByText('Stop this batch?')).toBeTruthy();
    // Asking is not doing.
    expect(client.cancelLibraryJob).not.toHaveBeenCalled();

    const dialog = await screen.findByText('Stop this batch?');
    const confirm = dialog.parentElement?.querySelector('button');
    await userEvent.click(confirm as HTMLElement);
    await waitFor(() => expect(client.cancelLibraryJob).toHaveBeenCalledTimes(1));
    // Said once in the dialog and once as a toast; both are the same sentence.
    await waitFor(() => expect(screen.getAllByText('Processing stopped.').length).toBe(2));
  });

  it('releases the lease when the space is left', async () => {
    const client = makeClient(2);
    const agent = makeAgent();
    vi.mocked(agent.process).mockImplementation(() => new Promise(() => undefined));

    const { unmount } = render(<Harness client={client} agent={agent} showDialog={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'start-batch' }));
    await waitFor(() => expect(agent.process).toHaveBeenCalledTimes(1));

    // Leaving team mode is the one thing that still gives the lease back.
    unmount();
    await waitFor(() => expect(client.cancelLibraryJob).toHaveBeenCalledTimes(1));
  });
});
