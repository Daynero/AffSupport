import { afterEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  /** The transcript the catalog reports for the source video, or none. */
  companion: null as { id: string; name: string } | null,
  /** What `find_reusable_transcript` answers. */
  reusable: null as { id: string; name: string; videoId: string } | null,
  linked: [] as Array<{ videoId: string; companionId: string }>
}));

vi.mock('../apps/web/src/api/team', () => ({
  teamApi: {
    getTranscriptCompanion: vi.fn(async () => shared.companion),
    listProductCatalogs: vi.fn(async () => []),
    findReusableTranscript: vi.fn(async () => shared.reusable),
    linkTranscriptCompanion: vi.fn(async (_team: string, videoId: string, companionId: string) => {
      shared.linked.push({ videoId, companionId });
      return true;
    })
  }
}));

const { carryTranscriptAfterProcess, reuseTranscriptFor } =
  await import('../apps/web/src/team/materials/tail');

/**
 * Feature 012: a transcript follows the video into what is made from it (T010), and a video
 * whose audio was already transcribed elsewhere in the space gets a copy of that text rather
 * than a second whisper run (FR-T2). Seen on production 2026-10-10: compressing
 * `claude-test-speech-video.mp4` to `claude-test-speech-video_1.mp4` left the copy without text.
 */

const TEAM = 'team-1';
const SOURCE = { id: 'video-1', name: 'claude-test-speech-video.mp4', category: 'video' };

function client() {
  return {
    copyMaterial: vi.fn(
      async (input: { materialId: string; destinationFolderId: string | null }) => ({
        operationId: `copy:${input.materialId}`,
        state: 'succeeded' as const,
        materialId: `copy-of-${input.materialId}`,
        reused: false
      })
    ),
    renameMaterial: vi.fn(async (input: { materialId: string; newName: string }) => ({
      operationId: `rename:${input.materialId}`,
      state: 'succeeded' as const,
      materialId: input.materialId,
      reused: false
    }))
  };
}

afterEach(() => {
  shared.companion = null;
  shared.reusable = null;
  shared.linked.length = 0;
  vi.clearAllMocks();
});

describe('a compressed copy takes the transcript along (012, T010)', () => {
  it('copies the transcript beside the result, names it after the result, and links it', async () => {
    shared.companion = { id: 'txt-1', name: 'claude-test-speech-video.txt' };
    const api = client();

    const carried = await carryTranscriptAfterProcess({
      teamId: TEAM,
      toolId: 'compressor',
      source: SOURCE,
      result: { materialId: 'video-2', name: 'claude-test-speech-video_1.mp4' },
      destinationFolderId: 'folder-a',
      client: api
    });

    expect(carried).toBe('copy-of-txt-1');
    expect(api.copyMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ materialId: 'txt-1', destinationFolderId: 'folder-a' })
    );
    expect(api.renameMaterial).toHaveBeenCalledWith(
      expect.objectContaining({
        materialId: 'copy-of-txt-1',
        newName: 'claude-test-speech-video_1.txt',
        conflictMode: 'keep_both'
      })
    );
    expect(shared.linked).toEqual([{ videoId: 'video-2', companionId: 'copy-of-txt-1' }]);
  });

  it('does the same for an embed, which also writes a new video', async () => {
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    const api = client();
    await carryTranscriptAfterProcess({
      teamId: TEAM,
      toolId: 'imageEmbedding',
      source: SOURCE,
      result: { materialId: 'video-3', name: 'clip-embed.mp4' },
      destinationFolderId: null,
      client: api
    });
    expect(shared.linked).toEqual([{ videoId: 'video-3', companionId: 'copy-of-txt-1' }]);
  });

  it('leaves an overwrite alone: the companion never left the material', async () => {
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    const api = client();
    const carried = await carryTranscriptAfterProcess({
      teamId: TEAM,
      toolId: 'compressor',
      source: SOURCE,
      result: { materialId: SOURCE.id, name: SOURCE.name },
      versionOf: SOURCE.id,
      destinationFolderId: null,
      client: api
    });
    expect(carried).toBeNull();
    expect(api.copyMaterial).not.toHaveBeenCalled();
  });

  it('does nothing for a transcription, or for a source without a transcript', async () => {
    const api = client();
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    await carryTranscriptAfterProcess({
      teamId: TEAM,
      toolId: 'transcription',
      source: SOURCE,
      result: { materialId: 'txt-9', name: 'clip.txt' },
      destinationFolderId: null,
      client: api
    });
    shared.companion = null;
    await carryTranscriptAfterProcess({
      teamId: TEAM,
      toolId: 'compressor',
      source: SOURCE,
      result: { materialId: 'video-2', name: 'clip_1.mp4' },
      destinationFolderId: null,
      client: api
    });
    expect(api.copyMaterial).not.toHaveBeenCalled();
    expect(shared.linked).toEqual([]);
  });

  it('keeps the compression when the transcript copy fails', async () => {
    shared.companion = { id: 'txt-1', name: 'clip.txt' };
    const api = client();
    api.copyMaterial.mockRejectedValueOnce(new Error('DRIVE_UNAVAILABLE'));
    await expect(
      carryTranscriptAfterProcess({
        teamId: TEAM,
        toolId: 'compressor',
        source: SOURCE,
        result: { materialId: 'video-2', name: 'clip_1.mp4' },
        destinationFolderId: null,
        client: api
      })
    ).resolves.toBeNull();
  });
});

describe('the same audio is not transcribed twice (012, FR-T2)', () => {
  it('copies the transcript another video holds, named after this video', async () => {
    shared.reusable = { id: 'txt-7', name: 'original.txt', videoId: 'video-7' };
    const api = client();
    const reused = await reuseTranscriptFor({
      teamId: TEAM,
      video: { id: 'video-8', name: 'reupload.mp4' },
      destinationFolderId: 'folder-b',
      client: api
    });
    expect(reused).toBe('copy-of-txt-7');
    expect(api.renameMaterial).toHaveBeenCalledWith(
      expect.objectContaining({ newName: 'reupload.txt' })
    );
    expect(shared.linked).toEqual([{ videoId: 'video-8', companionId: 'copy-of-txt-7' }]);
  });

  it('answers null when there is nothing to reuse, so the caller transcribes', async () => {
    const api = client();
    await expect(
      reuseTranscriptFor({
        teamId: TEAM,
        video: { id: 'video-8', name: 'new.mp4' },
        destinationFolderId: null,
        client: api
      })
    ).resolves.toBeNull();
    expect(api.copyMaterial).not.toHaveBeenCalled();
  });
});
