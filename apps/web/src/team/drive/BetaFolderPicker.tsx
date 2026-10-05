import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { teamApi, type DriveFolderPage, type TeamMaterialSummary } from '../../api/team';
import { configuredEnvironment } from '../../lib/config';
import { FolderPicker } from '../catalog/FolderPicker';
import type { PickFolders, PickerDocument } from '../storage/loadPicker';

export interface BetaFolderClient {
  listFolders?: (
    teamId: string,
    parentId?: string,
    pageToken?: string | null
  ) => Promise<DriveFolderPage>;
}

/** Reuse the app's tree chooser with live Drive folders, before a catalog exists. */
export function useBetaFolderPicker(teamId: string, client: BetaFolderClient) {
  const [title, setTitle] = useState<string | null>(null);
  const pending = useRef<((folders: PickerDocument[] | null) => void) | null>(null);
  const resources = useRef(new Map<string, string | null>());
  const listFolders = client.listFolders ?? teamApi.listFolders;
  const browser = useMemo(
    () => ({
      listMaterials: async (
        id: string,
        parentId: string | null
      ): Promise<TeamMaterialSummary[]> => {
        const result: TeamMaterialSummary[] = [];
        let pageToken: string | null = null;
        do {
          const page = await listFolders(id, parentId ?? 'root', pageToken);
          for (const folder of page.folders) {
            resources.current.set(folder.id, folder.resourceKey ?? null);
            result.push({
              id: folder.id,
              providerId: folder.id,
              teamId: id,
              name: folder.name,
              kind: 'folder',
              category: null
            });
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
        return result;
      }
    }),
    [listFolders]
  );
  const finish = useCallback((folders: PickerDocument[] | null) => {
    pending.current?.(folders);
    pending.current = null;
    setTitle(null);
  }, []);
  useEffect(
    () => () => {
      pending.current?.(null);
      pending.current = null;
    },
    []
  );
  const pickFolders: PickFolders = useCallback(
    input =>
      new Promise(resolve => {
        pending.current?.(null);
        pending.current = resolve;
        resources.current.clear();
        setTitle(input.title);
      }),
    []
  );
  return {
    enabled: configuredEnvironment() === 'beta',
    pickFolders,
    dialog:
      title === null ? null : (
        <FolderPicker
          teamId={teamId}
          client={browser}
          title={title}
          nested
          onClose={() => finish(null)}
          onSelect={folder =>
            finish([
              {
                ...folder,
                mimeType: 'application/vnd.google-apps.folder',
                resourceKey: resources.current.get(folder.id) ?? null
              }
            ])
          }
        />
      )
  };
}
