import { moveMaterialWithTail, type MoveTailClient, type TailMaterial } from '../materials/tail';

export interface MoveItem extends TailMaterial {
  sourceFolderId?: string | null;
}

export interface MoveProgress {
  completed: number;
  failed: number;
  total: number;
  /** A single move has no useful fraction until its response arrives. */
  progress: number | 'indeterminate';
}

export interface MoveOutcome extends MoveProgress {
  error: unknown | null;
  affectedFolderIds: Array<string | null>;
}

/** Shared move path for paste, drop and the material menu. Server permissions,
 * ancestry and cycle checks remain authoritative in moveMaterial. */
export async function moveWorkspaceMaterials(input: {
  teamId: string;
  items: readonly MoveItem[];
  destinationFolderId: string | null;
  conflictMode: 'cancel' | 'keep_both';
  client: MoveTailClient;
  onProgress?: (progress: MoveProgress) => void;
  onInvalidated?: (folderIds: Array<string | null>) => void;
}): Promise<MoveOutcome> {
  const affected = new Set<string | null>();
  let completed = 0;
  let failed = 0;
  let error: unknown | null = null;
  const total = input.items.length;
  const progress = (): MoveProgress => ({
    completed,
    failed,
    total,
    progress:
      total <= 1 && completed === 0
        ? 'indeterminate'
        : total > 0
          ? Math.round((completed / total) * 100)
          : 'indeterminate'
  });
  input.onProgress?.(progress());
  for (const item of input.items) {
    try {
      const result = await moveMaterialWithTail({
        teamId: input.teamId,
        material: item,
        destinationFolderId: input.destinationFolderId,
        conflictMode: input.conflictMode,
        client: input.client
      });
      if (result.state !== 'succeeded')
        throw Object.assign(new Error('MOVE_NOT_COMPLETE'), { code: 'MOVE_NOT_COMPLETE' });
      completed += 1;
      affected.add(item.sourceFolderId ?? null);
      affected.add(input.destinationFolderId);
      input.onInvalidated?.([...affected]);
    } catch (cause) {
      failed += 1;
      error = cause;
      input.onProgress?.(progress());
      break;
    }
    input.onProgress?.(progress());
  }
  return { ...progress(), error, affectedFolderIds: [...affected] };
}
