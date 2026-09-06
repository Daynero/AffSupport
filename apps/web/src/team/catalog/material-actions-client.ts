import type { TeamDownloadGrantResult, TeamFileOperationResult } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { downloadTeamFileWithAgent } from '../../api/client';
import { resumableUpload } from '../drive/resumableUpload';

export interface TeamFileUploadInput {
  teamId: string;
  /** The folder's provider id, or null for the space root. */
  destinationFolderId: string | null;
  file: File;
  conflictMode: 'cancel' | 'keep_both' | 'replace';
  replaceMaterialId: string | null;
  versionOfMaterialId: string | null;
}

/**
 * The file-operation surface the row actions need, kept as an interface so a
 * test can substitute it wholesale without touching the network layer.
 */
export interface MaterialActionsClient {
  uploadFile(input: TeamFileUploadInput): Promise<TeamFileOperationResult>;
  requestDownload(
    teamId: string,
    materialId: string,
    consumer: 'browser' | 'agent'
  ): Promise<TeamDownloadGrantResult>;
  downloadWithAgent(input: {
    transferUrl: string;
    transferGrant: Extract<TeamDownloadGrantResult, { kind: 'agent' }>['grant'];
    fileName: string;
  }): Promise<unknown>;
  renameMaterial(input: {
    teamId: string;
    materialId: string;
    newName: string;
    conflictMode: 'cancel' | 'keep_both';
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
  moveMaterial(input: {
    teamId: string;
    materialId: string;
    /** The folder's provider id, or null for the space root. */
    destinationFolderId: string | null;
    conflictMode: 'cancel' | 'keep_both';
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
  trashMaterial(input: {
    teamId: string;
    materialId: string;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
  restoreMaterial(input: {
    teamId: string;
    materialId: string;
    destinationFolderId?: string | null;
    idempotencyKey: string;
  }): Promise<TeamFileOperationResult>;
}

/**
 * What the provider says it has after an incomplete chunk. Google reports the
 * bytes it holds as `bytes=0-N`; without that header the safest reading is that
 * the chunk landed whole.
 */
function nextOffsetFrom(
  receivedRange: string | null,
  chunk: { offset: number; endExclusive: number }
): number {
  const match = /^bytes=0-(\d+)$/u.exec(receivedRange ?? '');
  if (!match) return chunk.endExclusive;
  const received = Number(match[1]);
  if (!Number.isSafeInteger(received) || received < chunk.offset) return chunk.endExclusive;
  return Math.min(received + 1, chunk.endExclusive);
}

/**
 * One upload, start to finish. The idempotency key is minted here and reused by
 * the resumable transfer and its finalize call, so a retry of an interrupted
 * upload resumes rather than duplicating the file.
 */
export async function uploadTeamFile(
  input: TeamFileUploadInput & {
    /** Bytes the provider has accepted so far, for a visible progress. */
    onProgress?: (sentBytes: number, totalBytes: number) => void;
  }
) {
  const idempotencyKey = crypto.randomUUID();
  const session = await teamApi.startUpload({
    teamId: input.teamId,
    destinationFolderId: input.destinationFolderId,
    name: input.file.name,
    mimeType: input.file.type || 'application/octet-stream',
    sizeBytes: input.file.size,
    conflictMode: input.conflictMode,
    replaceMaterialId: input.replaceMaterialId,
    versionOfMaterialId: input.versionOfMaterialId,
    idempotencyKey
  });
  if (!session.sessionUri || session.sessionUnavailable) {
    /*
     * A code, not a bare `Error`. The mapper reads `code`, so thrown as
     * `new Error('WRONG_STATE')` this arrived as the generic "something went
     * wrong, try again in a moment" — the one sentence that tells a person
     * neither what failed nor what to do about it.
     */
    throw Object.assign(new Error('UPLOAD_SESSION_UNAVAILABLE'), {
      code: 'UPLOAD_SESSION_UNAVAILABLE'
    });
  }
  const sessionUri = session.sessionUri;
  const relayUrl = teamApi.uploadRelayUrl(session.operationId);
  /*
   * A transfer that dies must let the name go.
   *
   * Starting an upload reserves its name for half an hour, and the catalogue
   * row is only written when the transfer finishes. So an upload that gave up
   * mid-way left the worst possible pair behind: a name nobody could use again
   * and a file nobody could see — "it says it already exists and I cannot find
   * it". Cancelling the operation releases the reservation at once. It is
   * best-effort and never replaces the failure being reported: the reason the
   * upload failed is what the person needs to read, and the reservation
   * expires on its own in any case.
   */
  try {
    return await resumableUpload({
      source: input.file,
      onProgress: input.onProgress,
      sessionUri,
      operationId: session.operationId,
      idempotencyKey,
      // The session is opened server-side and carries no browser origin, so the
      // bytes go through the relay rather than straight at the provider.
      sendChunk: async chunk => {
        const outcome = await teamApi.relayUploadChunk({
          relayUrl,
          sessionUri,
          contentRange: `bytes ${chunk.offset}-${chunk.endExclusive - 1}/${chunk.totalBytes}`,
          chunk: chunk.chunk,
          signal: chunk.signal
        });
        if (outcome.complete && outcome.driveFileId) {
          return { complete: true, driveFileId: outcome.driveFileId };
        }
        return { complete: false, nextOffset: nextOffsetFrom(outcome.receivedRange, chunk) };
      },
      finalize: teamApi.finalizeUpload
    });
  } catch (failure) {
    await teamApi.cancelOperation(input.teamId, session.operationId).catch(() => {
      // The reservation times out by itself; nothing here is worth losing the
      // real error over.
    });
    throw failure;
  }
}

export const defaultMaterialActionsClient: MaterialActionsClient = {
  uploadFile: uploadTeamFile,
  requestDownload: (teamId, materialId, consumer) =>
    teamApi.requestDownload(teamId, materialId, consumer),
  downloadWithAgent: downloadTeamFileWithAgent,
  renameMaterial: input => teamApi.renameMaterial(input),
  moveMaterial: input => teamApi.moveMaterial(input),
  trashMaterial: input => teamApi.trashMaterial(input),
  restoreMaterial: input => teamApi.restoreMaterial(input)
};
