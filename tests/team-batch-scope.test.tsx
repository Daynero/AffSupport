// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessLibraryDialog } from '../apps/web/src/team/library/ProcessLibraryDialog';
import { LibraryProcessingProvider } from '../apps/web/src/team/library/LibraryProcessingProvider';
import type {
  ProcessLibraryAgent,
  ProcessLibraryClient
} from '../apps/web/src/team/library/process-library-contract';
import { ToastProvider } from '../apps/web/src/components/toast';

const TEAM_ID = '44000000-0000-4000-8000-000000000001';
const FIRST = '44000000-0000-4000-8000-000000000002';
const SECOND = '44000000-0000-4000-8000-000000000003';
const THIRD = '44000000-0000-4000-8000-000000000004';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * One batch window, three scopes.
 *
 * The explorer used to have two of these — a folder one and a "Creative
 * Library" one — that named the same work differently and disagreed about how
 * much of it there was. And a selection of two or more could not be processed
 * at all: the scope was a single id, so the button that offered it was cut back
 * to one file.
 */
function stubClient(): ProcessLibraryClient {
  return {
    scanLibraryRequirements: vi.fn().mockResolvedValue({
      created: { transcription: 0, translation: 0, landingOptimization: 0 },
      missing: { transcription: 2, translation: 0, landingOptimization: 0 },
      ready: 0,
      started: false
    }),
    claimLibraryJob: vi.fn().mockRejectedValue(new Error('NO_WORK')),
    getLibraryProcessingContext: vi.fn(),
    startProcess: vi.fn(),
    heartbeatLibraryJob: vi.fn(),
    cancelLibraryJob: vi.fn(),
    failLibraryJob: vi.fn(),
    retryFailedLibraryJobs: vi.fn().mockResolvedValue(0),
    finalizeLibraryJob: vi.fn(),
    cancelOperation: vi.fn()
  };
}

const agent: ProcessLibraryAgent = {
  process: vi.fn(),
  cancel: vi.fn().mockResolvedValue(true)
};

function mount(
  client: ProcessLibraryClient,
  sources: string[],
  scope: React.ComponentProps<typeof ProcessLibraryDialog>['scope']
) {
  return render(
    <ToastProvider>
      <LibraryProcessingProvider
        teamId={TEAM_ID}
        sourceMaterialIds={sources}
        scope={scope}
        agentCompatible
        toolContracts={{ teamWorkspace: 1, transcription: 5 }}
        client={client}
        agent={agent}
        agentInstanceId={THIRD}
      >
        <ProcessLibraryDialog scope={scope} agentCompatible onClose={vi.fn()} />
      </LibraryProcessingProvider>
    </ToastProvider>
  );
}

describe('the batch window and its scope', () => {
  it('scans a chosen set in one question and claims against the whole set', async () => {
    const client = stubClient();
    mount(client, [FIRST, SECOND], { kind: 'selection', count: 2 });

    await waitFor(() =>
      expect(client.scanLibraryRequirements).toHaveBeenCalledWith(
        TEAM_ID,
        'en',
        [FIRST, SECOND],
        false
      )
    );
    expect(client.scanLibraryRequirements).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Processing: 2 selected' })).toBeTruthy();
    expect(screen.getByText('The 2 files you picked')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Start processing' }));
    await waitFor(() => expect(client.claimLibraryJob).toHaveBeenCalled());
    expect(client.claimLibraryJob).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMaterialIds: [FIRST, SECOND] })
    );
  });

  it('says what was left out when part of a selection cannot be processed', async () => {
    const client = stubClient();
    mount(client, [FIRST, SECOND], { kind: 'selection', count: 2, picked: 5 });
    await waitFor(() => expect(client.scanLibraryRequirements).toHaveBeenCalled());
    expect(
      screen.getByText(
        'You picked 5; 2 of them can be processed — the rest are not videos or landings.'
      )
    ).toBeTruthy();
  });

  it('counts the folders walked and the files found', async () => {
    const client = stubClient();
    mount(client, [FIRST], { kind: 'folder', name: 'spy joints', folders: 6, files: 24 });
    await waitFor(() => expect(client.scanLibraryRequirements).toHaveBeenCalled());
    expect(
      screen.getByText(
        'Folder “spy joints”, subfolders included — 6 subfolders, 24 videos and landings'
      )
    ).toBeTruthy();
  });

  it('shows only the work this computer will claim, and names the rest', async () => {
    const client = stubClient();
    (client.scanLibraryRequirements as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: { transcription: 0, translation: 0, landingOptimization: 0 },
      missing: { transcription: 2, translation: 0, landingOptimization: 4 },
      ready: 0,
      started: false
    });
    render(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[FIRST]}
          scope={{ kind: 'selection', count: 1 }}
          agentCompatible
          // No landing tool on this device, so its four landing jobs are not
          // this batch's to promise.
          toolContracts={{ teamWorkspace: 1, transcription: 5 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog
            scope={{ kind: 'selection', count: 1 }}
            agentCompatible
            onClose={vi.fn()}
          />
        </LibraryProcessingProvider>
      </ToastProvider>
    );
    // Two, not six: the number over Start is the number the loop can claim.
    expect(
      await screen.findByText('2 jobs are ready. Processing starts only after confirmation.')
    ).toBeTruthy();
    expect(screen.queryByText('Landing optimizations')).toBeNull();
    expect(
      screen.getByText(
        'This computer does not do this work: Landing optimizations — 4. Update the agent or run it elsewhere.'
      )
    ).toBeTruthy();
  });

  it('names a folder scope by its folder and the whole space by the space', async () => {
    const folderClient = stubClient();
    const folder = mount(folderClient, [FIRST], { kind: 'folder', name: 'spy joints' });
    await waitFor(() => expect(folderClient.scanLibraryRequirements).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: 'Processing: folder “spy joints”' })).toBeTruthy();
    folder.unmount();

    const spaceClient = stubClient();
    mount(spaceClient, [], { kind: 'space' });
    await waitFor(() =>
      expect(spaceClient.scanLibraryRequirements).toHaveBeenCalledWith(TEAM_ID, 'en', [], false)
    );
    expect(screen.getByRole('heading', { name: 'Processing: the whole space' })).toBeTruthy();
    expect(screen.getByText('Everything this space holds')).toBeTruthy();
  });

  it('keeps the running batch in view when a different scope is asked for', async () => {
    const client = stubClient();
    // A claim that never resolves keeps the batch in `running`, which is the
    // state the old window mislabelled.
    (client.claimLibraryJob as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const view = render(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[]}
          scope={{ kind: 'space' }}
          agentCompatible
          toolContracts={{ teamWorkspace: 1, transcription: 5 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog scope={{ kind: 'space' }} agentCompatible onClose={vi.fn()} />
        </LibraryProcessingProvider>
      </ToastProvider>
    );
    await waitFor(() => expect(client.scanLibraryRequirements).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Start processing' }));
    await screen.findByText('Stop processing');

    // The shell now asks for a different scope while that run is in flight.
    view.rerender(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[FIRST, SECOND]}
          scope={{ kind: 'selection', count: 2 }}
          agentCompatible
          toolContracts={{ teamWorkspace: 1, transcription: 5 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog
            scope={{ kind: 'selection', count: 2 }}
            agentCompatible
            onClose={vi.fn()}
          />
        </LibraryProcessingProvider>
      </ToastProvider>
    );

    // The title still belongs to the run that is happening...
    expect(screen.getByRole('heading', { name: 'Processing: the whole space' })).toBeTruthy();
    // ...and the request that was put aside is said out loud.
    expect(
      screen.getByText(
        'A batch is already running; the 2 files you picked can start once it finishes.'
      )
    ).toBeTruthy();
  });

  it('reads the running batch when telling which counts to show', async () => {
    const client = stubClient();
    (client.scanLibraryRequirements as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: { transcription: 0, translation: 0, landingOptimization: 0 },
      // A space batch shows all three tiles, zeroes included: there the zero is
      // the answer to a question that was asked.
      missing: { transcription: 3, translation: 0, landingOptimization: 0 },
      ready: 0,
      started: false
    });
    (client.claimLibraryJob as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    const view = render(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[]}
          scope={{ kind: 'space' }}
          agentCompatible
          toolContracts={{ teamWorkspace: 1, transcription: 5, landingOptimizer: 2 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog scope={{ kind: 'space' }} agentCompatible onClose={vi.fn()} />
        </LibraryProcessingProvider>
      </ToastProvider>
    );
    await waitFor(() => expect(client.scanLibraryRequirements).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Start processing' }));
    await screen.findByText('Stop processing');
    expect(screen.getAllByRole('group', { name: 'Missing processing jobs' })).toHaveLength(1);
    expect(screen.getByText('Translations')).toBeTruthy();

    // Asking for a narrower scope mid-run must not quietly drop the running
    // batch's own zero-count tiles.
    view.rerender(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[FIRST]}
          scope={{ kind: 'selection', count: 1 }}
          agentCompatible
          toolContracts={{ teamWorkspace: 1, transcription: 5, landingOptimizer: 2 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog
            scope={{ kind: 'selection', count: 1 }}
            agentCompatible
            onClose={vi.fn()}
          />
        </LibraryProcessingProvider>
      </ToastProvider>
    );
    expect(screen.getByText('Translations')).toBeTruthy();
  });

  it('renames itself when the same files are asked for under a different name', async () => {
    const client = stubClient();
    const view = render(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[FIRST, SECOND]}
          scope={{ kind: 'folder', name: 'spy joints' }}
          agentCompatible
          toolContracts={{ teamWorkspace: 1, transcription: 5 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog
            scope={{ kind: 'folder', name: 'spy joints' }}
            agentCompatible
            onClose={vi.fn()}
          />
        </LibraryProcessingProvider>
      </ToastProvider>
    );
    await waitFor(() => expect(client.scanLibraryRequirements).toHaveBeenCalled());
    expect(screen.getByRole('heading', { name: 'Processing: folder “spy joints”' })).toBeTruthy();

    // The same two files, hand-picked this time: identical work, different name.
    view.rerender(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[FIRST, SECOND]}
          scope={{ kind: 'selection', count: 2 }}
          agentCompatible
          toolContracts={{ teamWorkspace: 1, transcription: 5 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog
            scope={{ kind: 'selection', count: 2 }}
            agentCompatible
            onClose={vi.fn()}
          />
        </LibraryProcessingProvider>
      </ToastProvider>
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Processing: 2 selected' })).toBeTruthy()
    );
  });

  it('never calls work it cannot do "already processed"', async () => {
    const client = stubClient();
    (client.scanLibraryRequirements as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: { transcription: 0, translation: 0, landingOptimization: 0 },
      missing: { transcription: 20, translation: 0, landingOptimization: 4 },
      ready: 0,
      started: false
    });
    render(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[FIRST]}
          scope={{ kind: 'folder', name: 'spy joints', folders: 5, files: 24, videos: 20 }}
          agentCompatible
          // No landing tool: the four landing jobs are not this device's to run.
          toolContracts={{ teamWorkspace: 1, transcription: 5 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog
            scope={{ kind: 'folder', name: 'spy joints', folders: 5, files: 24, videos: 20 }}
            agentCompatible
            onClose={vi.fn()}
          />
        </LibraryProcessingProvider>
      </ToastProvider>
    );
    // Twenty videos, twenty transcriptions wanted: none of them is done, and the
    // four landings this computer cannot touch must not be counted as done
    // either — they are named on their own line instead.
    expect(await screen.findByText(/20 jobs are ready/u)).toBeTruthy();
    expect(screen.queryByText(/already have a transcript/u)).toBeNull();
    expect(
      screen.getByText(
        'This computer does not do this work: Landing optimizations — 4. Update the agent or run it elsewhere.'
      )
    ).toBeTruthy();
  });

  it('counts the videos that already have a transcript, in videos', async () => {
    const client = stubClient();
    (client.scanLibraryRequirements as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: { transcription: 0, translation: 0, landingOptimization: 0 },
      // Two of the twenty-four videos are transcribed, and one of those has a
      // translation waiting: jobs and files stop being the same number here.
      missing: { transcription: 22, translation: 1, landingOptimization: 0 },
      ready: 0,
      started: false
    });
    render(
      <ToastProvider>
        <LibraryProcessingProvider
          teamId={TEAM_ID}
          sourceMaterialIds={[FIRST]}
          scope={{ kind: 'folder', name: 'spy joints', folders: 5, files: 24, videos: 24 }}
          agentCompatible
          toolContracts={{ teamWorkspace: 1, transcription: 5 }}
          client={client}
          agent={agent}
          agentInstanceId={THIRD}
        >
          <ProcessLibraryDialog
            scope={{ kind: 'folder', name: 'spy joints', folders: 5, files: 24, videos: 24 }}
            agentCompatible
            onClose={vi.fn()}
          />
        </LibraryProcessingProvider>
      </ToastProvider>
    );
    expect(
      await screen.findByText(/2 of the videos already have a transcript — those are skipped\./u)
    ).toBeTruthy();
  });

  it('counts on open and only enqueues when Start is pressed', async () => {
    const client = stubClient();
    mount(client, [FIRST], { kind: 'selection', count: 1 });
    await waitFor(() => expect(client.scanLibraryRequirements).toHaveBeenCalled());
    // Opening the window used to write a requirement row for every job it
    // counted — for the whole space, claimable by anyone — while saying that
    // processing starts only after confirmation.
    expect(client.scanLibraryRequirements).toHaveBeenCalledWith(TEAM_ID, 'en', [FIRST], false);
    expect(client.scanLibraryRequirements).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Start processing' }));
    await waitFor(() =>
      expect(client.scanLibraryRequirements).toHaveBeenCalledWith(TEAM_ID, 'en', [FIRST], true)
    );
  });
});
