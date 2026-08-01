import type { DriveFileMetadata } from '../_shared/drive.ts';

export interface InitialSyncJobSlice {
  jobId: string;
  connectionId: string;
  rootFolderId: string;
  folderQueue: string[];
  pageToken: string | null;
}

export interface InitialSyncDependencies {
  listChildren: (input: {
    parentId: string;
    pageToken: string | null;
  }) => Promise<{ files: DriveFileMetadata[]; nextPageToken: string | null }>;
  upsertPage: (input: {
    jobId: string;
    connectionId: string;
    parentId: string;
    files: DriveFileMetadata[];
  }) => Promise<unknown>;
  checkpoint: (input: {
    jobId: string;
    folderQueue: string[];
    pageToken: string | null;
    state: 'scanning' | 'replaying';
  }) => Promise<unknown>;
  enqueueChangeReplay: (input: { jobId: string; connectionId: string }) => Promise<unknown>;
}

export async function runInitialSyncSlice(
  job: InitialSyncJobSlice,
  dependencies: InitialSyncDependencies
): Promise<{ visible: number; checkpointed: true; state: 'scanning' | 'replaying' }> {
  const parentId = job.folderQueue[0] ?? job.rootFolderId;
  const page = await dependencies.listChildren({ parentId, pageToken: job.pageToken });
  await dependencies.upsertPage({
    jobId: job.jobId,
    connectionId: job.connectionId,
    parentId,
    files: page.files
  });

  const childFolders = page.files
    .filter(
      file =>
        !file.trashed &&
        file.mimeType === 'application/vnd.google-apps.folder' &&
        !file.shortcutTargetId
    )
    .map(file => file.id);
  const remaining = job.folderQueue.length > 0 ? job.folderQueue.slice(1) : [];
  const folderQueue = page.nextPageToken
    ? [parentId, ...remaining]
    : [...remaining, ...childFolders];
  const state = folderQueue.length === 0 ? 'replaying' : 'scanning';
  await dependencies.checkpoint({
    jobId: job.jobId,
    folderQueue,
    pageToken: page.nextPageToken,
    state
  });
  if (state === 'replaying') {
    await dependencies.enqueueChangeReplay({ jobId: job.jobId, connectionId: job.connectionId });
  }
  return { visible: page.files.length, checkpointed: true, state };
}
