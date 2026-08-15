import type { MaterialCategory } from '@video-compressor/shared';

export const TASK_MATERIAL_DRAG_TYPE = 'application/x-soty-team-material-ids';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * A drag carries just enough display data to stage an attachment locally.
 * It deliberately contains no Drive path, grant, or file content.
 */
export interface TaskMaterialDragItem {
  id: string;
  name: string;
  category: MaterialCategory | null;
  previewState?: string;
}

function parseDragPayload(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length >= 1 && parsed.length <= 10_000 ? parsed : [];
  } catch {
    return [];
  }
}

export function encodeTaskMaterialDrag(items: readonly TaskMaterialDragItem[]): string {
  return JSON.stringify(
    items.map(item => ({
      id: item.id,
      name: item.name,
      category: item.category,
      previewState: item.previewState
    }))
  );
}

/** Supports the legacy ID-only payload as well as the current local-draft payload. */
export function decodeTaskMaterialDrag(value: string): string[] {
  const ids = parseDragPayload(value)
    .map(item =>
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? (item as { id?: unknown }).id
          : null
    )
    .filter((id): id is string => typeof id === 'string' && UUID.test(id));
  return [...new Set(ids)];
}

export function decodeTaskMaterialDragItems(value: string): TaskMaterialDragItem[] {
  const items: TaskMaterialDragItem[] = [];
  const seen = new Set<string>();
  for (const candidate of parseDragPayload(value)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as {
      id?: unknown;
      name?: unknown;
      category?: unknown;
      previewState?: unknown;
    };
    if (
      typeof item.id !== 'string' ||
      !UUID.test(item.id) ||
      typeof item.name !== 'string' ||
      item.name.trim().length < 1 ||
      (item.category !== null && item.category !== undefined && typeof item.category !== 'string') ||
      seen.has(item.id)
    ) {
      continue;
    }
    seen.add(item.id);
    items.push({
      id: item.id,
      name: item.name,
      category: (item.category ?? null) as MaterialCategory | null,
      previewState: typeof item.previewState === 'string' ? item.previewState : undefined
    });
  }
  return items;
}
