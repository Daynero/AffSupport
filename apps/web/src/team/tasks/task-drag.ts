export const TASK_MATERIAL_DRAG_TYPE = 'application/x-soty-team-material-ids';

export function decodeTaskMaterialDrag(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10_000) return [];
    const ids = parsed.filter(
      (item): item is string =>
        typeof item === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(item)
    );
    return [...new Set(ids)];
  } catch {
    return [];
  }
}
