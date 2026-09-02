import type { TeamMaterialSummary } from '../../api/team';

/**
 * Everything inside a folder, subfolders included (owner brief, 2026-09-02).
 *
 * "Process this folder" used to read one level: a folder holding nothing but
 * subfolders — the usual shape of a creative library — reported "nothing inside
 * needs processing". The walk is breadth-first through the same listing the
 * explorer uses, so a video buried three levels down is transcribed and a
 * landing beside it gets its cached screens.
 */
export interface FolderScanClient {
  listMaterials: (teamId: string, parentFolderId: string | null) => Promise<TeamMaterialSummary[]>;
}

export interface FolderScanResult {
  videos: TeamMaterialSummary[];
  landings: TeamMaterialSummary[];
  /** How many folders were listed, the starting folder included. */
  foldersVisited: number;
  /** True when the ceiling stopped the walk before the tree ran out. */
  truncated: boolean;
}

/**
 * A ceiling rather than a promise of completeness: a Drive root can hold tens of
 * thousands of folders, and one listing per folder is one round trip. Reaching
 * it is reported, never silently pretended away.
 */
export const FOLDER_SCAN_MAX_FOLDERS = 500;

export async function scanFolderTree(input: {
  teamId: string;
  client: FolderScanClient;
  /** Provider (Drive) id of the folder to start from. */
  rootFolderId: string;
  /** Checked between listings so a closed dialog stops the walk. */
  isCancelled?: () => boolean;
  /** Reports folders listed so far, so the dialog can count out loud. */
  onProgress?: (foldersVisited: number) => void;
  maxFolders?: number;
}): Promise<FolderScanResult> {
  const { teamId, client, rootFolderId, isCancelled, onProgress } = input;
  const maxFolders = input.maxFolders ?? FOLDER_SCAN_MAX_FOLDERS;
  const videos: TeamMaterialSummary[] = [];
  const landings: TeamMaterialSummary[] = [];
  // A shortcut can point back up the tree; listing a folder twice would double
  // every file inside it.
  const seen = new Set<string>([rootFolderId]);
  const queue: string[] = [rootFolderId];
  let foldersVisited = 0;
  let truncated = false;

  while (queue.length > 0) {
    if (isCancelled?.()) break;
    if (foldersVisited >= maxFolders) {
      truncated = true;
      break;
    }
    const folderId = queue.shift() as string;
    const items = await client.listMaterials(teamId, folderId);
    foldersVisited += 1;
    onProgress?.(foldersVisited);
    for (const item of items) {
      if (item.kind === 'folder') {
        // Only a folder the listing can be repeated for is worth queueing;
        // without a provider id there is nothing to ask the catalog about.
        const childId = item.providerId;
        if (childId && !seen.has(childId)) {
          seen.add(childId);
          queue.push(childId);
        }
        continue;
      }
      if (item.kind !== 'file') continue;
      if (item.category === 'video') videos.push(item);
      else if (item.category === 'landing') landings.push(item);
    }
  }

  return { videos, landings, foldersVisited, truncated: truncated || queue.length > 0 };
}
