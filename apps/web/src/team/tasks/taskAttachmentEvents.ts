/**
 * "This task's attachments changed", said across the space (024, FR-078).
 *
 * A run started from a task finishes in the space's queue, long after the
 * editor that asked for it may have closed — or while it is still open, in
 * which case the new file has to appear on it without a reload. The queue
 * does not know whether an editor is listening, and should not; it says what
 * happened, and whoever is showing that task re-reads.
 */
const EVENT = 'soty:task-attachments-changed';

export function announceTaskAttachmentsChanged(taskId: string): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { taskId } }));
}

export function onTaskAttachmentsChanged(taskId: string, listener: () => void): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<{ taskId: string }>).detail?.taskId === taskId) listener();
  };
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/** Any task's attachments — for a file that wants to know which tasks it is on. */
export function onAnyTaskAttachmentsChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
