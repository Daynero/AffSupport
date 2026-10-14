/** Move one existing id to a precise edge of another. Hidden rows stay in place. */
export function moveOrderedId(
  ids: readonly string[],
  sourceId: string,
  targetId: string,
  edge: 'before' | 'after'
): string[] | null {
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return null;
  const next = ids.filter(id => id !== sourceId);
  const target = next.indexOf(targetId);
  next.splice(target + (edge === 'after' ? 1 : 0), 0, sourceId);
  return next.every((id, index) => id === ids[index]) ? null : next;
}
