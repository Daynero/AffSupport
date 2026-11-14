/**
 * The one folder everything dropped on a task lands in.
 *
 * A drawer, not a filing system: a screenshot pasted into a task belongs to
 * that task and nowhere else, and asking which folder it goes in is a question
 * with no useful answer. So every drop from every task goes to the same place
 * in the space's root, and the task's own attachment list is what gives it
 * meaning.
 *
 * Found by the mark this application writes into `appProperties`, exactly as
 * the workspace folder is (see `workspace-folder.ts`): the name is never the
 * identity, so renaming or moving it in Drive loses nothing.
 */

import {
  proveLiveAncestry,
  type DriveFileMetadata,
  type GoogleDriveClient
} from '../_shared/drive.ts';
import { TeamFunctionError } from '../_shared/errors.ts';

export const TASK_DROP_FOLDER_MARK = 'soty.task-drops';
/** What a person sees in Drive. Plain, and says who put it there. */
export const TASK_DROP_FOLDER_NAME = 'Task attachments';

export type TaskDropFolderDrive = Pick<
  GoogleDriveClient,
  'findFolderByAppProperty' | 'createFolder' | 'getFile'
>;

export interface TaskDropFolderResolution {
  folder: DriveFileMetadata;
  created: boolean;
  marker: string;
}

/** The mark: the space's own id, which is unique and already at hand. */
export function taskDropFolderMarker(teamId: string): string {
  return `${teamId}:task-drops`;
}

export async function resolveTaskDropFolder(input: {
  teamId: string;
  rootFolderId: string;
  workspaceRootFolderId: string;
  drive: TaskDropFolderDrive;
}): Promise<TaskDropFolderResolution> {
  const marker = taskDropFolderMarker(input.teamId);
  const found = await input.drive.findFolderByAppProperty({
    key: TASK_DROP_FOLDER_MARK,
    value: marker,
    parentId: input.rootFolderId
  });
  if (found && !found.trashed) return { folder: found, created: false, marker };

  // The old team-only marker may still exist in a previously connected root.
  // Keep renamed/moved legacy folders only after proving current ancestry;
  // never move a folder from outside this connection back into the space.
  const legacy = await input.drive.findFolderByAppProperty({
    key: TASK_DROP_FOLDER_MARK,
    value: marker,
    driveId: null
  });
  if (legacy && !legacy.trashed) {
    try {
      const verified = await proveLiveAncestry({
        client: input.drive,
        fileId: legacy.id,
        rootFolderId: input.workspaceRootFolderId
      });
      return { folder: verified, created: false, marker };
    } catch (error) {
      if (
        !(error instanceof TeamFunctionError) ||
        !['ROOT_ESCAPE', 'NOT_FOUND'].includes(error.code)
      )
        throw error;
    }
  }

  const created = await input.drive.createFolder({
    name: TASK_DROP_FOLDER_NAME,
    parentId: input.rootFolderId,
    appProperties: { [TASK_DROP_FOLDER_MARK]: marker }
  });
  return { folder: created, created: true, marker };
}
