import type { TeamBulkTrashIntent } from '@video-compressor/shared';

/** Dispatch a hosted group without letting one provider failure block the rest. */
export async function executeBulkTrash(input: {
  intent: TeamBulkTrashIntent;
  concurrency?: number;
  mark: (materialId: string) => Promise<void>;
  trash: (materialId: string, idempotencyKey: string) => Promise<void>;
  settled: (materialId: string) => void | Promise<void>;
}): Promise<{ attempted: number; transportErrors: number }> {
  const concurrency = Math.max(1, Math.min(6, Math.floor(input.concurrency ?? 6)));
  let cursor = 0;
  let attempted = 0;
  let transportErrors = 0;
  const worker = async () => {
    while (cursor < input.intent.items.length) {
      const item = input.intent.items[cursor++];
      if (!item) continue;
      try {
        await input.mark(item.materialId);
        attempted += 1;
        await input.trash(item.materialId, item.idempotencyKey);
      } catch {
        transportErrors += 1;
      } finally {
        try {
          await input.settled(item.materialId);
        } catch {
          // A receipt refresh can be retried by Realtime; it must not stop the group.
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, input.intent.items.length) }, worker)
  );
  return { attempted, transportErrors };
}
