/** Bounded, content-free timings for one accepted catalog attempt. */
export const CATALOG_TIMING_STAGES = [
  'image_contract',
  'video_context',
  'settings',
  'catalog_lookup',
  'drive_client',
  'video_proof',
  'destination',
  'resource_selection',
  'row_recipe',
  'name_conflicts',
  'source_link',
  'operation_start',
  'operation_running',
  'sheet_rows',
  'image_validation',
  'xlsx_build',
  'sheet_upload',
  'sheet_write',
  'permission_read',
  'permission_write',
  'intent_binding',
  'catalog_finalize',
  'catalog_link',
  'image_finalize',
  'checkpoint'
] as const;
export type CatalogTimingStage = (typeof CATALOG_TIMING_STAGES)[number];
export interface CatalogTimingSnapshot {
  attempt: number;
  steps: Partial<Record<CatalogTimingStage, { calls: number; total_ms: number }>>;
}
export function catalogTimings(attempt: number, now: () => number = () => performance.now()) {
  const steps: CatalogTimingSnapshot['steps'] = {};
  return {
    async measure<T>(stage: CatalogTimingStage, run: () => Promise<T>): Promise<T> {
      const start = now();
      try {
        return await run();
      } finally {
        const prior = steps[stage] ?? { calls: 0, total_ms: 0 };
        steps[stage] = {
          calls: Math.min(10000, prior.calls + 1),
          total_ms: Math.min(86400000, prior.total_ms + Math.max(0, Math.round(now() - start)))
        };
      }
    },
    snapshot(currentAttempt = attempt): CatalogTimingSnapshot {
      return structuredClone({ attempt: currentAttempt, steps });
    }
  };
}
/** Only named async boundaries are measured; arguments/results never enter the receipt. */
export function timeCatalogMethods<T extends object>(
  target: T,
  timings: ReturnType<typeof catalogTimings>,
  stages: Partial<Record<keyof T, CatalogTimingStage>>
): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      const stage = stages[key as keyof T];
      if (typeof value !== 'function') return value;
      // Preserve private-field receivers on real GoogleDriveClient methods.
      if (!stage) return value.bind(object);
      return (...args: unknown[]) =>
        timings.measure(stage, () => Reflect.apply(value, object, args) as Promise<unknown>);
    }
  });
}
