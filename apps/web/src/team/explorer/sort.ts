import type { TeamMaterialRow } from '@video-compressor/shared';

export type SortKey = 'name' | 'modified';
export type SortDirection = 'asc' | 'desc';

export interface ExplorerSort {
  key: SortKey;
  direction: SortDirection;
  /** Folders grouped above files (Google Drive's default) or mixed in. */
  foldersSeparate: boolean;
}

export const DEFAULT_SORT: ExplorerSort = {
  key: 'name',
  direction: 'asc',
  foldersSeparate: true
};

/**
 * Orders the rows a page has loaded (011): folders first when asked, then by
 * name or modified date. Client-side over the current page — enough while a
 * folder fits a page; a large folder's full-order sort is a server concern
 * tracked separately.
 */
export function sortRows(rows: readonly TeamMaterialRow[], sort: ExplorerSort): TeamMaterialRow[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const factor = sort.direction === 'asc' ? 1 : -1;
  const compare = (a: TeamMaterialRow, b: TeamMaterialRow): number => {
    if (sort.foldersSeparate) {
      const af = a.kind === 'folder' ? 0 : 1;
      const bf = b.kind === 'folder' ? 0 : 1;
      if (af !== bf) return af - bf;
    }
    if (sort.key === 'modified') {
      const at = a.modifiedAt ? Date.parse(a.modifiedAt) : 0;
      const bt = b.modifiedAt ? Date.parse(b.modifiedAt) : 0;
      if (at !== bt) return (at - bt) * factor;
    }
    return collator.compare(a.name, b.name) * factor;
  };
  return [...rows].sort(compare);
}

export function readRememberedSort(): ExplorerSort {
  try {
    const raw = localStorage.getItem('soty.team.explorer.sort');
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw) as Partial<ExplorerSort>;
    return {
      key: parsed.key === 'modified' ? 'modified' : 'name',
      direction: parsed.direction === 'desc' ? 'desc' : 'asc',
      foldersSeparate: parsed.foldersSeparate !== false
    };
  } catch {
    return DEFAULT_SORT;
  }
}

export function rememberSort(sort: ExplorerSort): void {
  try {
    localStorage.setItem('soty.team.explorer.sort', JSON.stringify(sort));
  } catch {
    // A browser that refuses storage keeps the default next time.
  }
}
