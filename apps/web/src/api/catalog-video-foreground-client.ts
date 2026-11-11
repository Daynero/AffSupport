// client/entitlement touch localStorage and location at module load; load them on first use
// so importing the team API (and every node-environment test of it) stays side-effect free.
type EnsureEntitlement = typeof import('./entitlement').ensureAgentEntitlement;
import {
  privateCacheActor,
  privateCacheActorEpoch,
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
    epoch = privateCacheActorEpoch();
  return () => {
    if (signal?.aborted) throw Error('PROCESS_CANCELED');
    if (privateCacheActor() !== actor || privateCacheActorEpoch() !== epoch)
      throw Error('PERMISSION_DENIED');
  };
}

/**
 * Whether a failed local attach means the agent on this computer could not be
 * reached at all — no connection, a timeout, a proxy answering in its place, or
 * no pairing — rather than an agent that answered and refused.
 */
function agentUnreachableFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'PairingRequiredError') return true;
  if (error instanceof SyntaxError || error instanceof TypeError) return true;
  if (error.message === 'CONNECTION_FAILED' || error.message === 'TIMEOUT') return true;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 500;
}

/**
 * Hands a server answer to the local agent without letting the agent decide the
 * answer. The server read is the truth: an agent that is down, restarting or
 * refusing must not turn a valid progress read into "something went wrong" —
 * that hid the agent-silent notice and the Cancel beside it (1.4.3). Only a
 * caller that was replaced or aborted still throws.
 */
export async function attachCatalogForeground<T>(
  teamId: string,
  result: T,
  current: () => void,
  signal?: AbortSignal
): Promise<T> {
  current();
  try {
    await catalogForeground.attach(teamId, result, signal);
  } catch (error) {
    current();
    if (
      agentUnreachableFailure(error) &&
      result &&
      typeof result === 'object' &&
      (result as { outcome?: unknown }).outcome === 'preparing_video'
    )
      return { ...result, agentUnreachable: true as const };
    return result;
  }
  current();
  return result;
}
