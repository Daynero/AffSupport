import { teamMaterialTagRank, type TeamMaterialRow } from '@video-compressor/shared';
import type { CreativeRank } from '../ranks/creativeRanks';

export type SortKey = 'name' | 'kind' | 'modified' | 'size' | 'tag' | 'rank';

/** The order a column starts in when it is first chosen (070): dates and sizes newest and
 *  largest first, as Finder's do; names and kinds from A. */
export function firstDirection(key: SortKey): SortDirection {
  return key === 'modified' || key === 'size' || key === 'rank' ? 'desc' : 'asc';
}

/** A press on a column's header (070, FR-005): the same column turns, another one starts. */
export function sortByColumn(current: ExplorerSort, key: SortKey): ExplorerSort {
  return current.key === key
    ? { ...current, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { ...current, key, direction: firstDirection(key) };
}
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

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Names in the reader's own order — the tree and the list must agree on it. */
export const compareNames = (a: string, b: string): number => nameCollator.compare(a, b);

/**
 * Orders the rows a page has loaded (011): folders first when asked, then by
 * name or modified date. Client-side over the current page — enough while a
 * folder fits a page; a large folder's full-order sort is a server concern
 * tracked separately.
 */
export function sortRows(
  rows: readonly TeamMaterialRow[],
  sort: ExplorerSort,
  ranks: ReadonlyMap<string, CreativeRank> = new Map(),
  /** A kind's name in the reader's language: by kind is by what the reader sees, as Finder's is. */
  kindName: (kind: TeamMaterialRow['kind']) => string = kind => kind
): TeamMaterialRow[] {
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
    if (sort.key === 'kind' && a.kind !== b.kind) {
      return compareNames(kindName(a.kind), kindName(b.kind)) * factor;
    }
    /* By size (070), like by tag: what has no size — a folder, a file Drive never measured —
       goes last whichever way, rather than reading as the smallest thing in the folder. */
    if (sort.key === 'size') {
      const as = a.kind === 'folder' ? null : (a.sizeBytes ?? null);
      const bs = b.kind === 'folder' ? null : (b.sizeBytes ?? null);
      if ((as === null) !== (bs === null)) return as === null ? 1 : -1;
      if (as !== null && bs !== null && as !== bs) return (as - bs) * factor;
    }
    /* By tag, the untagged rows go last whichever way the direction points:
       "no tag" is the absence of a value, not the far end of the scale, and a
       descending sort that opened with fifty blank files answered nothing. */
    if (sort.key === 'tag') {
      const at = teamMaterialTagRank(a.tagColor);
      const bt = teamMaterialTagRank(b.tagColor);
      const untagged = teamMaterialTagRank(null);
      if (at !== bt) {
        if (at === untagged) return 1;
        if (bt === untagged) return -1;
        return (at - bt) * factor;
      }
    }
    /* By rank (059), like by tag: never-launched creatives and everything that carries no rank
       (folders, documents) go last either way — they have no rank to order by. Same league credit: the more recent
       launch first in the descending order. */
    if (sort.key === 'rank') {
      const ar = ranks.get(a.id);
      const br = ranks.get(b.id);
      const ac = ar?.rankCredit ?? 0;
      const bc = br?.rankCredit ?? 0;
      if ((ac === 0) !== (bc === 0)) return ac === 0 ? 1 : -1;
      if (ac !== bc) return (ac - bc) * factor;
      const at = ar?.lastLaunchedAt ? Date.parse(ar.lastLaunchedAt) : 0;
      const bt = br?.lastLaunchedAt ? Date.parse(br.lastLaunchedAt) : 0;
      if (at !== bt) return (at - bt) * factor;
    }
    return compareNames(a.name, b.name) * factor;
  };
  return [...rows].sort(compare);
}

export function readRememberedSort(): ExplorerSort {
  try {
    const raw = localStorage.getItem('soty.team.explorer.sort');
    if (!raw) return DEFAULT_SORT;
    const parsed = JSON.parse(raw) as Partial<ExplorerSort>;
    return {
      key:
        parsed.key === 'kind' ||
        parsed.key === 'modified' ||
        parsed.key === 'size' ||
        parsed.key === 'tag' ||
        parsed.key === 'rank'
          ? parsed.key
          : 'name',
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

const VIEW_KEY = 'soty.team.explorer.view';

/** List or grid, as this browser last left it — remembered beside the order (070, moved here
 *  from `ExplorerShell` to keep that file under its 800 lines). */
export function readRememberedView(): 'list' | 'grid' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export function rememberView(view: 'list' | 'grid'): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // A browser that refuses storage still gets the address.
  }
}
