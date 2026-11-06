import { TeamApiError } from '../../api/team';
import { privateCacheActor, privateCacheEpoch } from '../private-cache-scope';

/** Capture before reads/session refresh. Never replace an old intent with the new actor. */
export function captureCatalogMutationOwner(scopeCurrent: () => boolean) {
  const actor = privateCacheActor();
  const epoch = privateCacheEpoch();
  const current = () =>
    actor !== null &&
    privateCacheEpoch() === epoch &&
    privateCacheActor() === actor &&
    scopeCurrent();
  return {
    current,
    options(signal?: AbortSignal): { expectedActorId: string; signal?: AbortSignal } {
      if (actor === null) throw new TeamApiError('AUTH_REQUIRED', false);
      if (!current()) throw new TeamApiError('PERMISSION_DENIED', false);
      return { expectedActorId: actor, ...(signal ? { signal } : {}) };
    }
  };
}
