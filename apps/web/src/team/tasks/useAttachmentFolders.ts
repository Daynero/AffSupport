import { useEffect, useState } from 'react';
import type { TeamFolderNode } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { folderPathLabel, indexFolders } from '../explorer/folderPath';

export interface AttachmentFoldersClient {
  listTaskAttachmentFolders?: (
    teamId: string,
    taskId: string
  ) => Promise<Map<string, string | null>>;
  listFolderTree?: (teamId: string) => Promise<TeamFolderNode[]>;
}

/**
 * Where a task's files live, as paths (024): read once per set of attachments, so same-named
 * files on one task say which folder each came from, and the picker can open where they are.
 */
export function useAttachmentFolders({
  teamId,
  taskId,
  materialKey,
  rootLabel,
  client
}: {
  teamId: string;
  taskId: string;
  /** Changes when the attached files change. */
  materialKey: string;
  rootLabel: string;
  client: AttachmentFoldersClient;
}) {
  const [parents, setParents] = useState<Map<string, string | null>>(new Map());
  const [tree, setTree] = useState<TeamFolderNode[]>([]);

  useEffect(() => {
    let active = true;
    const listParents = client.listTaskAttachmentFolders ?? teamApi.listTaskAttachmentFolders;
    void listParents(teamId, taskId)
      .then(value => {
        if (active) setParents(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, materialKey, taskId, teamId]);

  useEffect(() => {
    let active = true;
    const listTree = client.listFolderTree ?? teamApi.listFolderTree;
    void listTree(teamId)
      .then(value => {
        if (active) setTree(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, teamId]);

  const folders = indexFolders(tree);
  return {
    folders,
    parentOf: (materialId: string) => parents.get(materialId),
    pathOf: (materialId: string) =>
      parents.has(materialId) ? folderPathLabel(parents.get(materialId), folders, rootLabel) : null,
    /** The folders from the top down to a file's own, for the picker's trail. */
    trailOf: (materialId: string): { id: string; name: string }[] => {
      const trail: { id: string; name: string }[] = [];
      const seen = new Set<string>();
      let at = parents.get(materialId) ? folders.get(parents.get(materialId)!) : undefined;
      while (at && !seen.has(at.driveFileId)) {
        seen.add(at.driveFileId);
        trail.unshift({ id: at.driveFileId, name: at.name });
        at = at.parentFolderId ? folders.get(at.parentFolderId) : undefined;
      }
      return trail;
    }
  };
}
