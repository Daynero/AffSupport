import type { FolderPageClient } from './useFolderPage';
import type { FolderPageCursor, TeamMaterialRow } from '@video-compressor/shared';

export interface WorkspaceCatalogResult {
  materialId: string;
  driveFolderId: string | null;
}

/** Walk the authoritative folder, independent of the visible page or filters. */
async function walkFolder(
  client: FolderPageClient,
  teamId: string,
  parentFolderId: string | null,
  visit: (rows: TeamMaterialRow[]) => boolean
): Promise<void> {
  let after: FolderPageCursor | null = null;
  const cursors = new Set<string>();
  for (let pages = 0; pages < 1_000; pages += 1) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const page = await Promise.race([
      client.listFolderPage(teamId, { parentFolderId, after, limit: 100 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CATALOG_READ_TIMEOUT')), 12_000);
      })
    ]).finally(() => clearTimeout(timer));
    if (visit(page.rows) || page.next === null) return;
    const key = JSON.stringify(page.next);
    if (cursors.has(key)) throw new Error('CATALOG_CURSOR_REPEATED');
    cursors.add(key);
    after = page.next;
  }
  throw new Error('CATALOG_READ_LIMIT');
}

export const catalogNameKey = (name: string) => name.normalize('NFC').toLocaleLowerCase();

export async function findFolderConflicts(
  client: FolderPageClient,
  teamId: string,
  parentFolderId: string | null,
  names: readonly string[]
): Promise<ReadonlyMap<string, string>> {
  const wanted = new Set(names.map(catalogNameKey));
  const found = new Map<string, string>();
  if (!wanted.size) return found;
  await walkFolder(client, teamId, parentFolderId, rows => {
    for (const row of rows) {
      const key = catalogNameKey(row.name);
      if (wanted.has(key)) found.set(key, row.id);
    }
    return found.size === wanted.size;
  });
  return found;
}

/** A successful refresh alone is not evidence that these mutations are visible. */
export async function confirmWorkspaceCatalog(
  client: FolderPageClient,
  teamId: string,
  expected: readonly WorkspaceCatalogResult[]
): Promise<void> {
  const folders = new Map<string | null, Set<string>>();
  for (const item of expected) {
    const ids = folders.get(item.driveFolderId) ?? new Set<string>();
    ids.add(item.materialId);
    folders.set(item.driveFolderId, ids);
  }
  for (const [parent, ids] of folders) {
    await walkFolder(client, teamId, parent, rows => {
      for (const row of rows) ids.delete(row.id);
      return ids.size === 0;
    });
    if (ids.size) throw new Error('CATALOG_POSTCONDITION_FAILED');
  }
}
