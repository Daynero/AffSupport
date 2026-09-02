/**
 * The stitcher's calls into the local app.
 *
 * One line each, through the shared `request`/`requestBody` wrappers so every call inherits
 * the same pairing token, the same private-network handling and the same `assertOk` error
 * shape as every other tool's.
 */

import type {
  AgentSettingsPatch,
  DetectedStitching,
  ImageSlot,
  QueueState,
  SourceProfile,
  StitchDestination,
  StitchPlan,
  StitchSettingsPatch,
  StitcherState
} from '@video-compressor/shared';
import { request, requestBody, uploadForm, uploadImage } from '../api/client';

export interface StitchInspection {
  profile: SourceProfile;
  detected: DetectedStitching;
  plan: StitchPlan;
}

export interface StitchChoice {
  path: string;
  /**
   * A pin, not a filter. Omitted, the slot draws at random from the enabled images exactly as
   * the compressor does; `null` asks for no screen there.
   */
  startImageId?: string | null;
  endImageId?: string | null;
  operation?: 'stitch' | 'restitch' | 'unstitch';
  boundaries?: { startSeconds: number; endSeconds: number };
  /**
   * Carried from the preview into the run, so a random end-screen length is drawn once and
   * the number the user was shown is the one that is produced.
   */
  endDurationSeconds?: number;
}

export function fetchStitcherState(signal?: AbortSignal): Promise<{ state: StitcherState }> {
  return request<{ state: StitcherState }>('/api/stitcher', 'GET', signal);
}

export function inspectStitchSource(choice: StitchChoice): Promise<StitchInspection> {
  return requestBody<StitchInspection>('/api/stitcher/inspect', choice);
}

/** Put files in the list. Nothing runs — the compressor's `add`. */
export function addStitchFiles(paths: string[]): Promise<{
  state: StitcherState;
  refused: { path: string; reason: string }[];
}> {
  return requestBody<{ state: StitcherState; refused: { path: string; reason: string }[] }>(
    '/api/stitcher/files',
    { paths }
  );
}

/** Start the chosen rows — the compressor's "compress selected". */
export function startStitchJobs(
  ids: string[],
  operation: 'stitch' | 'restitch' | 'unstitch'
): Promise<{ state: StitcherState; failures: { id: string; error: string }[] }> {
  return requestBody<{ state: StitcherState; failures: { id: string; error: string }[] }>(
    '/api/stitcher/start',
    { ids, operation }
  );
}

export function startStitch(
  choice: StitchChoice & { destination?: StitchDestination; outputSuffix?: string }
): Promise<{ state: StitcherState }> {
  return requestBody<{ state: StitcherState }>('/api/stitcher/jobs', choice);
}

export function cancelStitch(id: string): Promise<{ state: StitcherState }> {
  return request<{ state: StitcherState }>(
    `/api/stitcher/jobs/${encodeURIComponent(id)}/cancel`,
    'POST'
  );
}

export function updateStitcherSettings(
  patch: StitchSettingsPatch
): Promise<{ state: StitcherState }> {
  return requestBody<{ state: StitcherState }>('/api/stitcher/settings', patch);
}

export function repeatStitch(id: string): Promise<{ state: StitcherState }> {
  return request<{ state: StitcherState }>(
    `/api/stitcher/jobs/${encodeURIComponent(id)}/repeat`,
    'POST'
  );
}

export function removeStitch(id: string): Promise<{ state: StitcherState }> {
  return request<{ state: StitcherState }>(
    `/api/stitcher/jobs/${encodeURIComponent(id)}`,
    'DELETE'
  );
}

export function clearFinishedStitches(): Promise<{ state: StitcherState }> {
  return request<{ state: StitcherState }>('/api/stitcher/jobs/completed', 'DELETE');
}

export function revealStitchOutput(id: string): Promise<{ state: StitcherState }> {
  return request<{ state: StitcherState }>(
    `/api/stitcher/jobs/${encodeURIComponent(id)}/reveal`,
    'POST'
  );
}

export function openStitchOutput(id: string): Promise<{ state: StitcherState }> {
  return request<{ state: StitcherState }>(
    `/api/stitcher/jobs/${encodeURIComponent(id)}/open`,
    'POST'
  );
}

/* ── The compressor's screen library ───────────────────────────────────────
   The stitcher keeps no library of its own: these are the compressor's own
   endpoints, so a photo added here appears there and vice versa. */

export function fetchCompressorState(signal?: AbortSignal): Promise<QueueState> {
  return request<QueueState>('/api/queue', 'GET', signal);
}

export function updateCompressorSettings(patch: AgentSettingsPatch): Promise<QueueState> {
  return requestBody<QueueState>('/api/settings', patch);
}

export function uploadScreenImage(slot: ImageSlot, file: File): Promise<QueueState> {
  return uploadImage(slot, file);
}

export function removeScreenImage(slot: ImageSlot, id: string): Promise<QueueState> {
  return request<QueueState>(`/api/images/${slot}/${encodeURIComponent(id)}`, 'DELETE');
}

/**
 * A video dropped from the file manager.
 *
 * Chrome hands over the file's contents rather than its path, so the agent is asked to find
 * the real file on disk from the same name, size and modification time.
 */
export async function resolveDroppedVideo(file: File): Promise<string[]> {
  const body = new FormData();
  body.append('signature', `${file.name}:${file.size}:${file.lastModified}`);
  body.append('size', String(file.size));
  body.append('lastModified', String(file.lastModified));
  /*
   * The name, not the bytes.
   *
   * This route locates the original on disk from its name, size and modification time; it
   * drains the file part and never looks at it. Sending the file meant pushing sixty
   * megabytes through the loopback for nothing, on the one path where the user is watching
   * and waiting. The part still carries the real filename, which is the half that is read.
   */
  body.append('file', new File([], file.name, { type: file.type }), file.name);
  const { paths } = await uploadForm<{ paths: string[] }>('/api/stitcher/dropped', body);
  return paths;
}

/** The host's own file dialog: the stitcher needs the real path, never a copy. */
export function selectStitchSources(): Promise<{ paths: string[] }> {
  return request<{ paths: string[] }>('/api/stitcher/select', 'POST');
}

export function selectStitchFolder(): Promise<{ path: string | null }> {
  return request<{ path: string | null }>('/api/stitcher/select-folder', 'POST');
}
