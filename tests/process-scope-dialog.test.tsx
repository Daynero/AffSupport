// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderSubtree, TeamMaterialSummary } from '../apps/web/src/api/team';
import { ToastProvider } from '../apps/web/src/components/toast';
import { LibraryProcessingProvider } from '../apps/web/src/team/library/LibraryProcessingProvider';
import type {
  LibraryBatchScope,
  ProcessLibraryAgent,
  ProcessLibraryClient
} from '../apps/web/src/team/library/process-library-contract';
import { ProcessScopeDialog } from '../apps/web/src/team/processing/ProcessScopeDialog';
import {
  BATCH_SCOPE_LIMIT,
  resolveSelection,
  resolveSubtree,
  scopesOf,
  type ProcessOrigin,
  type ScopeFile
} from '../apps/web/src/team/processing/processScope';

const TEAM = '45000000-0000-4000-8000-000000000001';
const AGENT_INSTANCE = '45000000-0000-4000-8000-000000000009';
const FOLDER = { driveFileId: 'drive-folder', name: 'spy joints' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function file(index: number, category = 'video'): ScopeFile {
  return { id: `file-${index}`, name: `clip-${index}.mp4`, category };
}

function summary(index: number, category: 'video' | 'landing' = 'video'): TeamMaterialSummary {
  return {
    id: `${category}-${index}`,
    teamId: TEAM,
    providerId: `drive-${category}-${index}`,
    parentFolderId: FOLDER.driveFileId,
    name: `${category}-${index}`,
    kind: 'file',
    category
  } as TeamMaterialSummary;
}

function subtree(partial: Partial<FolderSubtree>): FolderSubtree {
  return { videos: [], landings: [], foldersVisited: 1, truncated: false, ...partial };
}

function stubClient(): ProcessLibraryClient {
  return {
    scanLibraryRequirements: vi.fn().mockResolvedValue({
      created: { transcription: 0, landingOptimization: 0 },
      missing: { transcription: 2, landingOptimization: 0 },
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
    cancelOperation: vi.fn(),
    findMaterialByName: vi.fn().mockResolvedValue(null)
  };
}

const agent: ProcessLibraryAgent = { process: vi.fn(), cancel: vi.fn().mockResolvedValue(true) };

/** The workspace shell's part: it keeps what the batch is about and lets the dialog point it. */
function Shell({
  origin,
  library,
  walk
}: {
  origin: ProcessOrigin;
  library: ProcessLibraryClient;
  walk: ReturnType<typeof vi.fn>;
}) {
  const [sources, setSources] = useState<string[]>([]);
  const [scope, setScope] = useState<LibraryBatchScope>({ kind: 'space' });
  return (
    <LibraryProcessingProvider
      teamId={TEAM}
      sourceMaterialIds={sources}
      scope={scope}
      agentAvailability="ready"
      toolContracts={{ teamWorkspace: 1, transcription: 6 }}
      client={library}
      agent={agent}
      agentInstanceId={AGENT_INSTANCE}
    >
      <ProcessScopeDialog
        teamId={TEAM}
        origin={origin}
        client={{ listFolderSubtree: walk as never, listFolderTree: vi.fn() } as never}
        scope={scope}
        onScope={(ids, next) => {
          setSources(ids);
          setScope(next);
        }}
        onClose={vi.fn()}
      />
    </LibraryProcessingProvider>
  );
}

function open(origin: ProcessOrigin, walkResult: FolderSubtree = subtree({})) {
  const library = stubClient();
  const walk = vi.fn().mockResolvedValue(walkResult);
  render(
    <ToastProvider>
      <Shell origin={origin} library={library} walk={walk} />
    </ToastProvider>
  );
  return { library, walk };
}

describe('the scopes a door offers (070, T061)', () => {
  it('opens on the scope of the door it came from, narrowest first', () => {
    const selection = [file(1), file(2)];
    expect(
      scopesOf({ intent: 'process', initial: 'selection', selection, folder: FOLDER, space: true })
    ).toEqual(['selection', 'folder', 'space']);
    expect(scopesOf({ intent: 'process', initial: 'space', space: true })).toEqual(['space']);
    // Compression has no "whole space": it runs file by file on this computer.
    expect(
      scopesOf({ intent: 'compress', initial: 'folder', folder: FOLDER, selection, space: true })
    ).toEqual(['selection', 'folder']);
  });

  it('counts only what the batch can take, and says how many were picked', () => {
    const result = resolveSelection({ intent: 'process', initial: 'selection', picked: 3 }, [
      file(1),
      file(2, 'landing'),
      file(3, 'image')
    ]);
    expect(result).toMatchObject({
      state: 'ready',
      ids: ['file-1', 'file-2'],
      library: { kind: 'selection', count: 2, picked: 3 }
    });
  });

  it('refuses a selection over the limit before anything starts', () => {
    const many = Array.from({ length: BATCH_SCOPE_LIMIT + 1 }, (_, index) => file(index));
    expect(resolveSelection({ intent: 'process', initial: 'selection' }, many)).toEqual({
      state: 'too-many',
      count: BATCH_SCOPE_LIMIT + 1
    });
    // Compression is not a batch on the server: it is not bounded.
    expect(resolveSelection({ intent: 'compress', initial: 'selection' }, many).state).toBe(
      'ready'
    );
  });

  it('never hands over an empty folder — the server reads no ids as the whole space', () => {
    expect(resolveSubtree('process', FOLDER, subtree({ foldersVisited: 4 }))).toEqual({
      state: 'empty',
      reason: 'folder',
      foldersVisited: 4
    });
    // A read that stopped at its ceiling has not seen the folder: not "empty".
    expect(
      resolveSubtree('process', FOLDER, subtree({ foldersVisited: 500, truncated: true }))
    ).toEqual({ state: 'too-deep', foldersVisited: 500 });
  });

  it('refuses an over-large folder even when the read was cut short', () => {
    const videos = Array.from({ length: 600 }, (_, index) => summary(index));
    expect(
      resolveSubtree('process', FOLDER, subtree({ videos, foldersVisited: 500, truncated: true }))
    ).toEqual({ state: 'too-many', count: 600 });
  });

  it('offers what a cut-short read did reach, and says it was cut short', () => {
    const result = resolveSubtree(
      'process',
      FOLDER,
      subtree({
        videos: [summary(1)],
        landings: [summary(2, 'landing')],
        foldersVisited: 7,
        truncated: true
      })
    );
    expect(result).toMatchObject({
      state: 'ready',
      ids: ['video-1', 'landing-2'],
      truncatedAfter: 7,
      library: { kind: 'folder', name: 'spy joints', folders: 6, files: 2, videos: 1 }
    });
  });
});

describe('the one processing dialog (070, T061–T063)', () => {
  it('from the selection bar: opens on the files in hand and scans exactly those', async () => {
    const { library, walk } = open({
      intent: 'process',
      initial: 'selection',
      selection: [file(1), file(2)],
      folder: FOLDER,
      space: true
    });
    const group = screen.getByRole('radiogroup', { name: 'What to process' });
    expect(within(group).getByRole('radio', { name: /Selected files · 2/u })).toHaveProperty(
      'checked',
      true
    );
    await waitFor(() =>
      expect(library.scanLibraryRequirements).toHaveBeenCalledWith(
        TEAM,
        'en',
        ['file-1', 'file-2'],
        false
      )
    );
    // Never a scan of the whole space on the way to the selection.
    expect(library.scanLibraryRequirements).toHaveBeenCalledTimes(1);
    expect(walk).not.toHaveBeenCalled();

    // Start runs the batch over the same set — the claim names it.
    fireEvent.click(await screen.findByRole('button', { name: /^Start · \d+$/u }));
    await waitFor(() =>
      expect(library.claimLibraryJob).toHaveBeenCalledWith(
        expect.objectContaining({ sourceMaterialIds: ['file-1', 'file-2'] })
      )
    );
  });

  it('from a folder: reads the folder once, then scans what it found', async () => {
    const { library, walk } = open(
      { intent: 'process', initial: 'folder', folder: FOLDER, space: true },
      subtree({ videos: [summary(1)], landings: [summary(2, 'landing')], foldersVisited: 3 })
    );
    await waitFor(() =>
      expect(library.scanLibraryRequirements).toHaveBeenCalledWith(
        TEAM,
        'en',
        ['video-1', 'landing-2'],
        false
      )
    );
    expect(walk).toHaveBeenCalledTimes(1);
    expect(walk).toHaveBeenCalledWith(TEAM, FOLDER.driveFileId);
    expect(
      screen.getByText(
        'Folder “spy joints”, subfolders included — 2 subfolders, 2 videos and landings'
      )
    ).toBeTruthy();
  });

  it('from the space menu: the whole space, with nothing else to choose', async () => {
    const { library } = open({ intent: 'process', initial: 'space', space: true });
    expect(screen.queryByRole('radiogroup', { name: 'What to process' })).toBeNull();
    await waitFor(() =>
      expect(library.scanLibraryRequirements).toHaveBeenCalledWith(TEAM, 'en', [], false)
    );
  });

  it('says the limit before Start, and keeps Start off with the reason beside it', async () => {
    const videos = Array.from({ length: 600 }, (_, index) => summary(index));
    const { library } = open(
      { intent: 'process', initial: 'folder', folder: FOLDER, space: true },
      subtree({ videos, foldersVisited: 2 })
    );
    expect(
      await screen.findByText(
        '600 files here — more than one batch can take (500). Run the subfolders one at a time, or the whole space.'
      )
    ).toBeTruthy();
    const start = screen.getByRole('button', { name: 'Start processing' });
    expect(start).toHaveProperty('disabled', true);
    expect(start.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Too many files for one batch.')).toBeTruthy();
    expect(library.scanLibraryRequirements).not.toHaveBeenCalled();
    expect(library.claimLibraryJob).not.toHaveBeenCalled();
  });

  it('keeps Start off for an empty scope, and never asks the server about the whole space instead', async () => {
    const { library } = open(
      { intent: 'process', initial: 'folder', folder: FOLDER, space: true },
      subtree({ foldersVisited: 3 })
    );
    expect(await screen.findByText('Nothing to process here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start processing' })).toHaveProperty(
      'disabled',
      true
    );
    expect(library.scanLibraryRequirements).not.toHaveBeenCalled();
  });

  it('switches scope inside the window and counts the new one', async () => {
    const { library } = open({
      intent: 'process',
      initial: 'selection',
      selection: [file(1)],
      space: true
    });
    await waitFor(() => expect(library.scanLibraryRequirements).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('radio', { name: /The whole space/u }));
    await waitFor(() =>
      expect(library.scanLibraryRequirements).toHaveBeenLastCalledWith(TEAM, 'en', [], false)
    );
    expect(screen.getByRole('heading', { name: 'Processing: the whole space' })).toBeTruthy();
  });
});

describe('the one compression dialog (070, T062)', () => {
  it('opens on the file it came from and offers its folder beside it', async () => {
    const onCompress = vi.fn();
    const walk = vi.fn().mockResolvedValue(subtree({ videos: [summary(1), summary(2)] }));
    render(
      <ToastProvider>
        <ProcessScopeDialog
          teamId={TEAM}
          origin={{
            intent: 'compress',
            initial: 'selection',
            selection: [{ ...file(9), parentFolderId: FOLDER.driveFileId }],
            folder: FOLDER
          }}
          client={{ listFolderSubtree: walk, listFolderTree: vi.fn() } as never}
          onCompress={onCompress}
          onClose={vi.fn()}
        />
      </ToastProvider>
    );
    expect(screen.getByRole('radio', { name: /This file/u })).toHaveProperty('checked', true);
    expect(walk).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /This folder/u }));
    fireEvent.click(await screen.findByRole('button', { name: /Compress \(2\)/u }));
    expect(onCompress).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ id: 'video-1', folderId: FOLDER.driveFileId }),
          expect.objectContaining({ id: 'video-2' })
        ]
      })
    );
  });
});
