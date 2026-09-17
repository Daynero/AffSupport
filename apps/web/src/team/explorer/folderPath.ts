/**
 * Where a file lives, said the way a person would (024): "Creo / Launches / GlucoSoft".
 *
 * Three files called Gs2_2.mp4 in three folders read as one file three times in a search result,
 * a picker and an attachment tile, and choosing the wrong one sends the wrong creative to a
 * launch. The folder path is what tells them apart.
 */
export interface FolderPathNode {
  driveFileId: string;
  parentFolderId: string | null;
  name: string;
}

export function indexFolders<T extends FolderPathNode>(nodes: readonly T[]): Map<string, T> {
  return new Map(nodes.map(node => [node.driveFileId, node]));
}

/** The folder names from the top down to `parentDriveId`, or `rootLabel` at the root. */
export function folderPathLabel(
  parentDriveId: string | null | undefined,
  folders: ReadonlyMap<string, FolderPathNode>,
  rootLabel: string
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let at = parentDriveId ? folders.get(parentDriveId) : undefined;
  while (at && !seen.has(at.driveFileId)) {
    seen.add(at.driveFileId);
    names.unshift(at.name);
    at = at.parentFolderId ? folders.get(at.parentFolderId) : undefined;
  }
  return names.length > 0 ? names.join(' / ') : rootLabel;
}
