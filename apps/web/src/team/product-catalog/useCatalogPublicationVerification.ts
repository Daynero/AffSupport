import { teamErrorCodeOf } from '../errors';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogPublicationSnapshot } from '@video-compressor/shared';
import { teamApi } from '../../api/team';
import { privateCacheActor, privateCacheEpoch, usePrivateCacheEpoch } from '../private-cache-scope';
import { withReadDeadline } from '../readCoordinator';
import { withCatalogCommandDeadline } from '../catalog-updater/catalogCommandCoordinator';
import { beginCatalogUiFlow } from '../catalog-updater/analytics';
/** A baseline check is read-only at the provider, but its SQL receipt still has
 * an original owner. A lost finish reply is recovered by exact receipt reads. */
export function useCatalogPublicationVerification(input: {
  teamId: string;
  catalogId: string;
  confirmed(value: CatalogPublicationSnapshot): void;
  failed(cause: unknown): void;
}) {
  const epoch = usePrivateCacheEpoch(),
    actor = privateCacheActor();
  const scope = useMemo(
    () => ({ teamId: input.teamId, catalogId: input.catalogId, epoch, actor }),
    [input.teamId, input.catalogId, epoch, actor]
  );
  const current = useRef(scope);
  current.current = scope;
  const mounted = useRef<typeof scope | null>(scope);
  const callbacks = useRef(input);
  callbacks.current = input;
  const [pending, setPending] = useState(false),
    [unknown, setUnknown] = useState<string | null>(null);
  const running = useRef(new Set<object>());
  const delivered = useRef<ReturnType<typeof beginCatalogUiFlow> | null>(null);
  const key = actor
    ? `soty:catalog-publication-verify:v1:${actor}:${input.teamId}:${input.catalogId}`
    : null;
  const owns = useCallback(
    () =>
      current.current === scope &&
      mounted.current === scope &&
      privateCacheEpoch() === scope.epoch &&
      privateCacheActor() === scope.actor &&
      scope.actor !== null,
    [scope]
  );
  const work = useCallback(
    async (requestId: string, revision?: number) => {
      if (!owns() || !key || running.current.has(scope)) return;
      running.current.add(scope);
      setPending(true);
      const flow = beginCatalogUiFlow('publication', { parentFlowId: requestId });
      flow.stage(revision === undefined ? 'readback_requested' : 'baseline_check_requested');
      try {
        const value =
          revision === undefined
            ? await withReadDeadline(
                signal =>
                  teamApi.readCatalogPublicationVerification(
                    scope.teamId,
                    scope.catalogId,
                    requestId,
                    { signal }
                  ),
                new AbortController().signal
              )
            : await withCatalogCommandDeadline(
                signal =>
                  teamApi.verifyCatalogPublication(
                    scope.teamId,
                    scope.catalogId,
                    revision,
                    requestId,
                    { signal }
                  ),
                new AbortController().signal
              );
        if (!owns()) return;
        if (!value) {
          setUnknown(requestId);
          flow.stage('stale', 'PROCESS_RESULT_UNCERTAIN');
          return;
        }
        localStorage.removeItem(key);
        setUnknown(null);
        flow.stage('baseline_confirmed');
        delivered.current = flow;
        callbacks.current.confirmed(value);
        // The parent emits result_visible after its confirmed snapshot commits.
      } catch (cause) {
        if (owns()) {
          const code = teamErrorCodeOf(cause);
          if (revision === undefined && code === 'WRONG_STATE') {
            try {
              localStorage.removeItem(key);
              setUnknown(null);
              flow.stage('baseline_aborted', 'WRONG_STATE');
              flow.fail('WRONG_STATE');
            } catch {
              setUnknown(requestId);
            }
          } else {
            setUnknown(requestId);
            flow.stage('stale', code ?? 'PROCESS_RESULT_UNCERTAIN');
          }
          callbacks.current.failed(cause);
        }
      } finally {
        running.current.delete(scope);
        if (owns()) setPending(false);
      }
    },
    [scope, key, owns]
  );
  useEffect(() => {
    mounted.current = scope;
    setPending(false);
    setUnknown(null);
    if (!key) return;
    try {
      const id = localStorage.getItem(key);
      if (id) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))
          throw Error('INVALID_RESPONSE');
        setUnknown(id);
        void work(id);
      }
    } catch (cause) {
      callbacks.current.failed(cause);
    }
    return () => {
      if (mounted.current === scope) mounted.current = null;
    };
  }, [scope, key, work]);
  const verify = useCallback(
    async (revision: number) => {
      if (!owns() || !key || unknown || running.current.has(scope)) return;
      if (!Number.isSafeInteger(revision) || revision < 1) {
        callbacks.current.failed(Error('INVALID_INPUT'));
        return;
      }
      const id = crypto.randomUUID();
      try {
        localStorage.setItem(key, id);
      } catch (cause) {
        callbacks.current.failed(cause);
        return;
      }
      setUnknown(id);
      await work(id, revision);
    },
    [scope, key, unknown, owns, work]
  );
  return {
    pending,
    unknown,
    verify,
    visible: () => {
      const flow = delivered.current;
      delivered.current = null;
      flow?.complete();
    },
    check: () => (unknown ? work(unknown) : Promise.resolve())
  };
}
