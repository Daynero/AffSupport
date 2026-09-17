import type { TeamMaterialRow } from '@video-compressor/shared';

/**
 * A file that belongs to another file, folded under it (024, US25).
 *
 * A video makes a transcript and one catalog per variation, and all of them landed in the folder
 * as equals: ten creatives read as thirty files, and the grid of thumbnails was broken up by grey
 * document icons. They are attachments of their video, so the folder shows the video with a count
 * and opens them on a press.
 *
 * Folding happens only where the video is on the same page: a companion whose video is filtered
 * out, on a later page, or deleted stands on its own, because a file that cannot be reached any
 * other way must never be hidden.
 *
 * The field is not in the shared package's row type yet (it cannot change without a desktop
 * release), so it is read from the row as the server sends it.
 */
export const companionOf = (row: TeamMaterialRow): string | null => {
  const value = (row as { companionOf?: unknown }).companionOf;
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export interface FoldedRows {
  /** The rows to show, in order, with any opened companions after their video. */
  rows: TeamMaterialRow[];
  /** How many companions each video holds, for the count on its tile. */
  counts: Map<string, number>;
}

/**
 * The listing with companions folded away — and put back under their video when it is open.
 */
export function foldCompanions(
  rows: readonly TeamMaterialRow[],
  opened: ReadonlySet<string>
): FoldedRows {
  const present = new Set(rows.map(row => row.id));
  const children = new Map<string, TeamMaterialRow[]>();
  const top: TeamMaterialRow[] = [];
  for (const row of rows) {
    const parent = companionOf(row);
    if (parent && present.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(row);
      children.set(parent, list);
      continue;
    }
    top.push(row);
  }
  const counts = new Map<string, number>();
  for (const [parent, list] of children) counts.set(parent, list.length);
  const folded: TeamMaterialRow[] = [];
  for (const row of top) {
    folded.push(row);
    if (opened.has(row.id)) folded.push(...(children.get(row.id) ?? []));
  }
  return { rows: folded, counts };
}
