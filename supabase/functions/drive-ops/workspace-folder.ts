/**
 * The space's own folder on the connected drive.
 *
 * Nobody is ever asked to make this folder, name it or find it: the button makes it, and every
 * later call finds the same one. It is found by a mark this application writes into the
 * folder's `appProperties` — invisible to every other app, and untouched by a member renaming
 * or moving it. **The name is never the identity.**
 *
 * Resolution, in order: the id we cached → a search for the mark → create it. Each step is
 * cheaper than the one after it, and the last one happens once in a space's life.
 *
 * It lives in its own file so that this order can be tested against a stubbed drive, without a
 * request, a caller or an OAuth token.
 */

import type { DriveFileMetadata, GoogleDriveClient } from '../_shared/drive.ts';

export const WORKSPACE_FOLDER_MARK = 'soty.workspace';
export const WORKSPACE_FOLDER_NAME = 'Soty';

export type WorkspaceFolderDrive = Pick<
  GoogleDriveClient,
  'getFile' | 'findFolderByAppProperty' | 'createFolder'
>;

export interface WorkspaceFolderResolution {
  folderId: string;
  created: boolean;
  name: string;
  marker: string;
}

/** The mark a space writes on its folder. The team's own id: unique, and already at hand. */
export function workspaceFolderMarker(teamId: string): string {
  return teamId;
}

function usable(live: DriveFileMetadata | null, marker: string): boolean {
  return Boolean(
    live &&
      !live.trashed &&
      live.mimeType === 'application/vnd.google-apps.folder' &&
      live.appProperties[WORKSPACE_FOLDER_MARK] === marker
  );
}

export async function resolveWorkspaceFolder(input: {
  teamId: string;
  rootFolderId: string;
  drive: WorkspaceFolderDrive;
  /** What was recorded last time, if anything. */
  cachedFolderId: string | null;
}): Promise<WorkspaceFolderResolution> {
  const marker = workspaceFolderMarker(input.teamId);

  if (input.cachedFolderId) {
    // A folder that was renamed or dragged elsewhere keeps its id and its mark, so this is
    // still the answer — which is why neither costs anything.
    const live = await input.drive.getFile(input.cachedFolderId).catch(() => null);
    if (usable(live, marker) && live) {
      return { folderId: live.id, created: false, name: live.name, marker };
    }
  }

  // The id was stale — trashed, or replaced. The mark still finds the real one wherever the
  // member has since put it.
  const found = await input.drive.findFolderByAppProperty({
    key: WORKSPACE_FOLDER_MARK,
    value: marker,
    driveId: null
  });
  if (found) return { folderId: found.id, created: false, name: found.name, marker };

  const created = await input.drive.createFolder({
    name: WORKSPACE_FOLDER_NAME,
    parentId: input.rootFolderId,
    appProperties: { [WORKSPACE_FOLDER_MARK]: marker }
  });
  return { folderId: created.id, created: true, name: created.name, marker };
}
