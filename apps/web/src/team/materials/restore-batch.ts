import { requireCompletedFileOperation } from './file-operation-outcome';
/** An Undo keeps one intent per item, including after a lost reply or partial
 * completion. The original actor owns every dispatch and visible result. */
export function createRestoreBatch(input: {
  materialIds: readonly string[];
  restore(materialId: string, requestKey: string): Promise<unknown>;
  current(): boolean;
  completed(): void;
  failed(cause: unknown): void;
  newKey?: () => string;
}) {
  const keys = new Map(
    [...new Set(input.materialIds)].map(id => [id, (input.newKey ?? (() => crypto.randomUUID()))()])
  );
  const confirmed = new Set<string>();
  let pending: Promise<boolean> | null = null,
    delivered = false;
  const run = (): Promise<boolean> => {
    if (pending) return pending;
    if (delivered || !input.current()) return Promise.resolve(delivered);
    pending = Promise.resolve().then(async () => {
      try {
        for (const [id, key] of keys) {
          if (!input.current()) return false;
          if (confirmed.has(id)) continue;
          const receipt = requireCompletedFileOperation(await input.restore(id, key));
          if (receipt.materialId !== id) throw Error('INVALID_RESPONSE');
          if (!input.current()) return false;
          confirmed.add(id);
        }
        if (!input.current()) return false;
        delivered = true;
        input.completed();
        return true;
      } catch (cause) {
        if (input.current()) input.failed(cause);
        return false;
      } finally {
        pending = null;
      }
    });
    return pending;
  };
  return { run };
}
