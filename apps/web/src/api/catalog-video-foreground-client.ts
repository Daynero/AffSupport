// client/entitlement touch localStorage and location at module load; load them on first use
// so importing the team API (and every node-environment test of it) stays side-effect free.
type EnsureEntitlement = typeof import('./entitlement').ensureAgentEntitlement;
import {
  privateCacheActor,
  privateCacheEpoch,
  registerPrivateCache
} from '../team/private-cache-scope';
import {
  createCatalogForegroundCoordinator,
  admitCatalogForeground,
  type CatalogForegroundBinding,
  type CatalogForegroundExecutor
} from './catalog-video-foreground';

const coordinator = createCatalogForegroundCoordinator({
  capability: async () =>
    (await import('./client')).request('/api/team/catalog-video/foreground/capabilities'),
  entitlement: async (...args: Parameters<EnsureEntitlement>) =>
    (await import('./entitlement')).ensureAgentEntitlement(...args),
  local: async (path, body, signal) =>
    (await import('./client')).requestBody(path, body, 'POST', signal),
  actor: privateCacheActor,
  epoch: privateCacheEpoch,
  enabled: () => true
});

const admissionPreparations = new Map<string, Promise<CatalogForegroundExecutor | undefined>>();
registerPrivateCache(() => admissionPreparations.clear());
export const catalogForeground = {
  attach: coordinator.attach,
  admit<T>(
    binding: CatalogForegroundBinding,
    run: (executor: CatalogForegroundExecutor | undefined) => Promise<T>,
    signal?: AbortSignal,
    prepared?: CatalogForegroundExecutor
  ) {
    const current = catalogForegroundScope(signal);
    const key = JSON.stringify([privateCacheActor(), privateCacheEpoch(), binding]);
    let preparation = admissionPreparations.get(key);
    if (!preparation) {
      if (admissionPreparations.size >= 128) throw Error('PROCESS_RESULT_UNCERTAIN');
      preparation = prepared ? Promise.resolve(prepared) : coordinator.prepare(binding, signal);
      admissionPreparations.set(key, preparation);
      // Retain even a failed optional preparation: an uncertain canonical POST
      // must replay the same omitted proof, never adopt a different payload.
      void preparation.catch(() => {});
    }
    return admitCatalogForeground({
      prepare: () => preparation!,
      admit: run,
      current
    }).then(result => {
      if (admissionPreparations.get(key) === preparation) admissionPreparations.delete(key);
      return result;
    });
  }
};

/** Seal the caller before async admission/readback; a replacement account cannot attach its reply. */
export function catalogForegroundScope(signal?: AbortSignal) {
  const actor = privateCacheActor(),
    epoch = privateCacheEpoch();
  return () => {
    if (signal?.aborted) throw Error('PROCESS_CANCELED');
    if (privateCacheActor() !== actor || privateCacheEpoch() !== epoch)
      throw Error('PERMISSION_DENIED');
  };
}
