import { createElement, lazy, useMemo, useState, type ComponentType } from 'react';
import { Button, Empty } from '../components/ui/index';
import { useI18n } from '../i18n';
import { reportChunkFailure } from './navigation-analytics';

/**
 * A lazily loaded screen that can be loaded ahead of time and survives a
 * chunk that will not load (058, FR-007, FR-009).
 *
 * - `preload()` starts loading it; it returns nothing once the code is in, so
 *   a navigation that passes it as `prepare` happens synchronously when the
 *   screen is already loaded, and waits (up to the skeleton delay) when not.
 * - A screen whose code is already in when it mounts renders directly, with
 *   no Suspense at all; one that is not stays on `lazy` for its whole life —
 *   switching mid-life would remount it.
 * - A failed load does not leave an empty frame or a skeleton forever: the
 *   screen says it did not load and offers to try again or reload the page.
 *   (A poisoned cache mid-deploy is first handled by the one-shot reload in
 *   main.tsx; this is what is left when that is not enough.)
 */
export function recoverableLazy<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  let loaded: ComponentType<Props> | null = null;
  let inflight: Promise<ComponentType<Props>> | null = null;

  const fetchComponent = () => {
    if (loaded) return Promise.resolve(loaded);
    inflight ??= load().then(
      component => {
        loaded = component;
        return component;
      },
      (error: unknown) => {
        inflight = null;
        throw error;
      }
    );
    return inflight;
  };

  const preload = (): Promise<unknown> | void => {
    if (loaded) return;
    return fetchComponent().catch(() => undefined);
  };

  function Recoverable(props: Props) {
    const [attempt, setAttempt] = useState(0);
    const [direct] = useState(() => loaded !== null);
    const Lazy = useMemo(
      () =>
        lazy(() =>
          fetchComponent().then(
            component => ({ default: component }),
            () => {
              reportChunkFailure();
              const Failed = () => (
                <ChunkFailed onRetry={() => setAttempt(current => current + 1)} />
              );
              return { default: Failed as unknown as ComponentType<Props> };
            }
          )
        ),
      // A new attempt is a new lazy component: React caches the failed one.
      [attempt]
    );
    if (direct && loaded) return createElement(loaded, props);
    return createElement(Lazy, props);
  }

  return { Component: Recoverable, preload, isLoaded: () => loaded !== null };
}

function ChunkFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <Empty
      title={t('chunkFailedTitle')}
      description={t('chunkFailedBody')}
      action={
        <div className="chunk-failed-actions">
          <Button color="primary" onClick={onRetry}>
            {t('tryAgain')}
          </Button>
          <Button variant="ghost" onClick={() => window.location.reload()}>
            {t('reloadPage')}
          </Button>
        </div>
      }
    />
  );
}
