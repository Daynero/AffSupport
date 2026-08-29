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
 * One upload, start to finish. The idempotency key is minted here and reused by
 * the resumable transfer and its finalize call, so a retry of an interrupted
 * upload resumes rather than duplicating the file.
 */
export async function uploadTeamFile(input: TeamFileUploadInput) {
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
  if (!session.sessionUri || session.sessionUnavailable) throw new Error('WRONG_STATE');
  return resumableUpload({
    source: input.file,
    sessionUri: session.sessionUri,
    operationId: session.operationId,
    idempotencyKey,
    finalize: teamApi.finalizeUpload
  });
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
