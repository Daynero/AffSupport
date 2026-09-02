import { describe, expect, it, vi } from 'vitest';
import type { TeamMaterialSummary } from '../apps/web/src/api/team';
import { scanFolderTree } from '../apps/web/src/team/explorer/folderScan';

const TEAM = '22222222-2222-4222-8222-222222222222';

function file(
  name: string,
  category: TeamMaterialSummary['category'],
  parentFolderId: string
): TeamMaterialSummary {
  return {
    id: `material:${parentFolderId}:${name}`,
    teamId: TEAM,
    providerId: `drive:${name}`,
    parentFolderId,
    name,
    kind: 'file',
    category
  };
}

function folder(name: string, parentFolderId: string): TeamMaterialSummary {
  return {
    id: `material:${name}`,
    teamId: TEAM,
    providerId: name,
    parentFolderId,
    name,
    kind: 'folder',
    category: null
  };
}

/** A library of the shape the owner actually has: folders holding folders. */
const TREE: Record<string, TeamMaterialSummary[]> = {
  root: [folder('geo-a', 'root'), folder('geo-b', 'root'), file('top.mp4', 'video', 'root')],
  'geo-a': [folder('creatives', 'geo-a'), file('a.zip', 'landing', 'geo-a')],
  'geo-b': [file('b1.mp4', 'video', 'geo-b'), file('b.zip', 'landing', 'geo-b')],
  creatives: [file('deep.mp4', 'video', 'creatives'), file('notes.txt', 'transcript', 'creatives')]
};

const client = {
  listMaterials: async (_teamId: string, parentFolderId: string | null) =>
    TREE[parentFolderId ?? 'root'] ?? []
};

describe('scanning a folder for batch processing', () => {
  it('reaches videos and landings in every subfolder', async () => {
    const result = await scanFolderTree({ teamId: TEAM, client, rootFolderId: 'root' });

    expect(result.videos.map(video => video.name).sort()).toEqual([
      'b1.mp4',
      'deep.mp4',
      'top.mp4'
    ]);
    expect(result.landings.map(landing => landing.name).sort()).toEqual(['a.zip', 'b.zip']);
    // Transcripts and other kinds are not work this batch knows how to do.
    expect(result.foldersVisited).toBe(4);
    expect(result.truncated).toBe(false);
  });

  it('keeps each file next to the folder it came from', async () => {
    const result = await scanFolderTree({ teamId: TEAM, client, rootFolderId: 'root' });
    const deep = result.videos.find(video => video.name === 'deep.mp4');

    // The shell sends the transcript to this folder, not to the batch's root.
    expect(deep?.parentFolderId).toBe('creatives');
  });

  it('lists a folder once even when a shortcut points back at it', async () => {
    const listMaterials = vi.fn(async (_teamId: string, parentFolderId: string | null) => {
      if (parentFolderId === 'root') return [folder('loop', 'root')];
      // The subfolder claims the root as its child.
      return [folder('root', 'loop'), file('inside.mp4', 'video', 'loop')];
    });

    const result = await scanFolderTree({
      teamId: TEAM,
      client: { listMaterials },
      rootFolderId: 'root'
    });

    expect(result.videos).toHaveLength(1);
    expect(listMaterials).toHaveBeenCalledTimes(2);
  });

  it('says so when the ceiling stops the walk', async () => {
    const deepTree = {
      listMaterials: async (_teamId: string, parentFolderId: string | null) => [
        folder(`${parentFolderId}-child`, parentFolderId ?? 'root'),
        file(`${parentFolderId}.mp4`, 'video', parentFolderId ?? 'root')
      ]
    };

    const result = await scanFolderTree({
      teamId: TEAM,
      client: deepTree,
      rootFolderId: 'root',
      maxFolders: 3
    });

    expect(result.foldersVisited).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.videos).toHaveLength(3);
  });

  it('stops walking once the dialog is gone', async () => {
    let closed = false;
    const listMaterials = vi.fn(async (_teamId: string, parentFolderId: string | null) => {
      closed = true;
      return [folder(`${parentFolderId}-child`, parentFolderId ?? 'root')];
    });

    const result = await scanFolderTree({
      teamId: TEAM,
      client: { listMaterials },
      rootFolderId: 'root',
      isCancelled: () => closed
    });

    expect(listMaterials).toHaveBeenCalledTimes(1);
    expect(result.foldersVisited).toBe(1);
  });
});
