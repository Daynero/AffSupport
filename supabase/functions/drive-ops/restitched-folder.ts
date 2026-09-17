/**
 * The one folder every re-stitched copy lands in (024, US26).
 *
 * A copy is machinery: the updater makes one before every round and deletes the one it replaces.
 * Left beside the video, a folder of ten creatives grew ten more heavy files that nobody opens,
 * blinking in and out of Drive every hour — on the phone, in the sync client, in "Recent". They
 * go here instead, and the folder that holds the buyer's own work stays the buyer's own.
 *
 * Found by the mark this application writes into `appProperties`, as the workspace and task-drop
 * folders are: the name is never the identity, so renaming or moving it in Drive loses nothing.
 */

import type { DriveFileMetadata, GoogleDriveClient } from '../_shared/drive.ts';

export const RESTITCHED_FOLDER_MARK = 'soty.restitched';
/** What a person sees in Drive. */
export const RESTITCHED_FOLDER_NAME = 'Restitched';

export type RestitchedFolderDrive = Pick<
  GoogleDriveClient,
  'findFolderByAppProperty' | 'createFolder'
>;

export interface RestitchedFolderResolution {
  folder: DriveFileMetadata;
  created: boolean;
  marker: string;
}

export function restitchedFolderMarker(teamId: string): string {
  return `${teamId}:restitched`;
}

export async function resolveRestitchedFolder(input: {
  teamId: string;
  rootFolderId: string;
  drive: RestitchedFolderDrive;
}): Promise<RestitchedFolderResolution> {
  const marker = restitchedFolderMarker(input.teamId);
  const found = await input.drive.findFolderByAppProperty({
    key: RESTITCHED_FOLDER_MARK,
    value: marker,
    driveId: null
  });
  if (found && !found.trashed) return { folder: found, created: false, marker };

  const created = await input.drive.createFolder({
    name: RESTITCHED_FOLDER_NAME,
    parentId: input.rootFolderId,
    appProperties: { [RESTITCHED_FOLDER_MARK]: marker }
  });
  return { folder: created, created: true, marker };
}
