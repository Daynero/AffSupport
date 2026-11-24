import { useCallback, useRef } from 'react';
import {
  classifyMaterial,
  DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
  toolContractCompatible,
  type TeamPermissions,
  type TeamRestitchDefaults
} from '@video-compressor/shared';
import { useOptionalAgent } from '../../AgentContext';
import type { AgentQueue, AgentQueueItem } from './useAgentQueue';

/**
 * What happens to the videos in a drop (070, owner 2026-11-24): kept as they are, or put in
 * the space with the stitching cut off.
 *
 * Asked once per drop, never per file, and never remembered as an answer — every drop asks
 * again, because a creative already stitched and one fresh from the editor arrive the same
 * way. Only the last choice is kept, to stand first so Enter takes it.
 */
export type UploadVideoChoice = 'original' | 'trim';

const LAST_CHOICE_KEY = 'soty.upload-video-choice.v1';

export function lastVideoChoice(): UploadVideoChoice {
  try {
    return localStorage.getItem(LAST_CHOICE_KEY) === 'trim' ? 'trim' : 'original';
  } catch {
    return 'original';
  }
}

export function rememberVideoChoice(choice: UploadVideoChoice): void {
  try {
    localStorage.setItem(LAST_CHOICE_KEY, choice);
  } catch {
    // A browser that refuses storage highlights "original" every time; nothing else changes.
  }
}

/** By the same classifier the space files materials with, so "video" means one thing. */
export function isVideoUpload(name: string, mimeType: string | null | undefined): boolean {
  const extension = name.includes('.') ? (name.split('.').pop() ?? null) : null;
  return (
    classifyMaterial({ kind: 'file', mimeType: mimeType || null, fileExtension: extension })
      .category === 'video'
  );
}

/**
 * The space's re-stitch with the one operation that needs no photograph: «Прибрати зашивку»,
 * the stitcher's `unstitch`, which cuts the start and end screens a video was stitched with.
 * Nothing here is the space's own setting — removing needs none of them — so a space that has
 * never set up re-stitching can still trim.
 */
export function unstitchDefaults(): TeamRestitchDefaults {
  return {
    operation: 'unstitch',
    startImageIds: [],
    endImageIds: [],
    fitMode: 'cover',
    finalDurationMode: 'random-30-40',
    customFinalDurationSeconds: DEFAULT_CUSTOM_FINAL_IMAGE_DURATION_SECONDS,
    configured: true,
    sourceMode: 'legacy',
    updatedAt: new Date(0).toISOString(),
    updatedBy: null
  };
}

/**
 * One queue job per uploaded video: the trimmed file is written over the upload as its new
 * version (013's overwrite), so the space holds one file — trimmed — and Drive keeps the
 * original as the previous version. A video with nothing to cut fails its job and stays as
 * it was uploaded.
 */
export function trimJobs(
  videos: ReadonlyArray<{ materialId: string; name: string; folderId: string | null }>
): AgentQueueItem[] {
  return videos.map(video => ({
    id: video.materialId,
    name: video.name,
    folderId: video.folderId,
    tool: 'restitch' as const,
    outputName: video.name,
    versionOf: video.materialId,
    options: { defaults: unstitchDefaults(), prepared: null }
  }));
}

/**
 * Whether this explorer can cut a drop's stitching, and where the trims go: the person may
 * process here and the local app can run the re-stitch. Otherwise there is one answer, and
 * the drop asks nothing.
 */
export function useUploadTrimming(
  permissions: TeamPermissions | null,
  queue: Pick<AgentQueue, 'enqueue'>
): { canTrim: boolean; onTrimVideos: (jobs: AgentQueueItem[]) => void } {
  const agent = useOptionalAgent();
  /* The queue's enqueue is remade every render; a drop that finishes later reaches the queue
     as it is then, not as it was when the files were dropped. */
  const enqueue = useRef(queue.enqueue);
  enqueue.current = queue.enqueue;
  const onTrimVideos = useCallback((jobs: AgentQueueItem[]) => enqueue.current(jobs), []);
  return {
    canTrim:
      Boolean(permissions?.process) &&
      agent?.teamWorkspaceAvailable === true &&
      toolContractCompatible('stitcher', agent.toolContracts ?? {}),
    onTrimVideos
  };
}
