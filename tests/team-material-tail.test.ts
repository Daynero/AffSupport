import { afterEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  /** The transcript the catalog reports for a video, or none. */
  companion: null as { id: string; name: string } | null,
  linked: [] as Array<{ videoId: string; companionId: string }>
}));

vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    getTranscriptCompanion: vi.fn(async () => shared.companion),
    linkTranscriptCompanion: vi.fn(async (_team: string, videoId: string, companionId: string) => {
      shared.linked.push({ videoId, companionId });
      return true;
    })
  }
}));

const {
  copyMaterialWithTail,
  moveMaterialWithTail,
  renameMaterialWithTail,
  trashMaterialWithTail,
  transcriptNameFor
} = await import('../apps/web/src/team/materials/tail');

/**
 * One mechanism for every file operation (owner, 2026-09-02).
 *
 * A video owns a transcript. Before this, the row menu's rename and move
 * carried it and everything else — a drag, a paste, a copy, a delete — did
 * not, so the two files drifted apart depending on which surface was used.
 */

const TEAM = 'team-1';
const VIDEO = { id: 'video-1', name: 'clip.mp4', category: 'video' };

function client() {
  return {
    copyMaterial: vi.fn(async (input: { materialId: string }) => ({
      operationId: `copy:${input.materialId}`,
      state: 'succeeded' as const,
      materialId: `copy-of-${input.materialId}`,
      reused: false
    })),
    moveMaterial: vi.fn(async (input: { materialId: string }) => ({
      operationId: `move:${input.materialId}`,
      state: 'succeeded' as const,
      materialId: input.materialId,
      reused: false
    })),
    renameMaterial: vi.fn(async (input: { materialId: string }) => ({
      operationId: `rename:${input.materialId}`,
      state: 'succeeded' as const,
      materialId: input.materialId,
      reused: false
    })),
    trashMaterial: vi.fn(async () => undefined)
  };
}

afterEach(() => {
  shared.companion = null;
  shared.linked.length = 0;
  vi.clearAllMocks();
});

describe('a material and what belongs to it', () => {
  it('gives a copied video its own transcript, linked to the copy', async () => {
    // Copied rather than shared: re-transcribing the copy has to replace the
    // copy's text and leave the original's alone.
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    const api = client();

    const result = await copyMaterialWithTail({
      teamId: TEAM,
      material: VIDEO,
      destinationFolderId: 'folder-2',
      client: api
    });

    expect(result.materialId).toBe('copy-of-video-1');
    expect(api.copyMaterial.mock.calls.map(([input]) => input.materialId)).toEqual([
      'video-1',
      'txt-1'
    ]);
    expect(shared.linked).toEqual([{ videoId: 'copy-of-video-1', companionId: 'copy-of-txt-1' }]);
  });

  it('copies a file with no tail without asking for one', async () => {
    const api = client();
    await copyMaterialWithTail({
      teamId: TEAM,
      material: { id: 'pic-1', name: 'shot.png', category: 'image' },
      destinationFolderId: null,
      client: api
    });
    expect(api.copyMaterial).toHaveBeenCalledTimes(1);
    expect(shared.linked).toEqual([]);
  });

  it('keeps the video copied when its transcript could not be', async () => {
    // The video is the thing that was asked for; a missing text is visible and
    // one click from being made again.
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    const api = client();
    api.copyMaterial.mockImplementationOnce(async () => ({
      operationId: 'copy:video-1',
      state: 'succeeded' as const,
      materialId: 'copy-of-video-1',
      reused: false
    }));
    api.copyMaterial.mockImplementationOnce(async () => {
      throw new Error('NAME_CONFLICT');
    });

    await expect(
      copyMaterialWithTail({
        teamId: TEAM,
        material: VIDEO,
        destinationFolderId: null,
        client: api
      })
    ).resolves.toMatchObject({ materialId: 'copy-of-video-1' });
    expect(shared.linked).toEqual([]);
  });

  it('moves the transcript to the same folder', async () => {
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    const api = client();

    await moveMaterialWithTail({
      teamId: TEAM,
      material: VIDEO,
      destinationFolderId: 'folder-2',
      client: api
    });

    expect(api.moveMaterial.mock.calls.map(([input]) => input.materialId)).toEqual([
      'video-1',
      'txt-1'
    ]);
    expect(api.moveMaterial.mock.calls[1]![0].destinationFolderId).toBe('folder-2');
  });

  it('renames the transcript after the video', async () => {
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    const api = client();

    await renameMaterialWithTail({
      teamId: TEAM,
      material: VIDEO,
      newName: 'final cut.mp4',
      client: api
    });

    expect(api.renameMaterial.mock.calls[1]![0]).toMatchObject({
      materialId: 'txt-1',
      newName: 'final cut.txt'
    });
    expect(transcriptNameFor('final cut.mp4')).toBe('final cut.txt');
  });

  it('trashes the transcript with the video, without asking', async () => {
    // 012 asked first, in case the text was shared. It never is.
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    const api = client();

    await trashMaterialWithTail({ teamId: TEAM, material: VIDEO, client: api });

    expect(api.trashMaterial.mock.calls.map(([input]) => input.materialId)).toEqual([
      'video-1',
      'txt-1'
    ]);
  });

  it('still performs the operation when the tail cannot be read', async () => {
    const { teamApi } = await import('../apps/web/src/api/team');
    vi.mocked(teamApi.getTranscriptCompanion).mockRejectedValueOnce(new Error('DRIVE_UNAVAILABLE'));
    const api = client();

    await moveMaterialWithTail({
      teamId: TEAM,
      material: VIDEO,
      destinationFolderId: null,
      client: api
    });

    expect(api.moveMaterial).toHaveBeenCalledTimes(1);
  });
});
