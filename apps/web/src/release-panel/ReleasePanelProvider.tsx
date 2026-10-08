import { useEffect, useState } from 'react';
import type { ReleasePanelSnapshot } from '../../../../packages/shared/src/release-automation';
import { newerSnapshot, panelJson, parseSnapshot } from './client';

/** Exactly one subscription owner; browser reconnection never starts work. */
export function useReleasePanel(taskId: string) {
  const [snapshot, setSnapshot] = useState<ReleasePanelSnapshot | null>(null);
  const [connection, setConnection] = useState('connecting');
  const [error, setError] = useState<string | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let stream: EventSource | null = null;
    const apply = (value: unknown) =>
      setSnapshot(current => newerSnapshot(current, parseSnapshot(value)));
    const refresh = (initial = false) =>
      panelJson(`/release-panel/api/tasks/${taskId}`, { signal: abort.signal })
        .then(apply)
        .catch((e: unknown) => {
          if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'PANEL_UNAVAILABLE');
          if (initial) throw e;
        });
    const foreground = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const begin = async () => {
      const capability = window.location.hash.slice(1);
      if (capability) {
        history.replaceState(null, '', `${location.pathname}${location.search}`);
        const result = await panelJson('/release-panel/api/session', {
          method: 'POST',
          signal: abort.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ capability })
        });
        if (
          !result ||
          typeof result !== 'object' ||
          !('csrf' in result) ||
          typeof result.csrf !== 'string'
        )
          throw new Error('PANEL_SESSION_REQUIRED');
        setCsrf(result.csrf);
        sessionStorage.setItem('soty.release.csrf', result.csrf);
      } else setCsrf(sessionStorage.getItem('soty.release.csrf'));
      await refresh(true);
      if (abort.signal.aborted) return;
      stream = new EventSource(`/release-panel/api/events?task=${encodeURIComponent(taskId)}`);
      const onData = (event: MessageEvent<string>) => {
        try {
          apply(JSON.parse(event.data));
          setError(null);
        } catch {
          setError('UNSUPPORTED_PANEL_SCHEMA');
          stream?.close();
        }
      };
      stream.addEventListener('snapshot', onData);
      stream.addEventListener('observation', onData);
      stream.addEventListener('resync_required', () => {
        void refresh();
      });
      stream.onopen = () => {
        setConnection('connected');
        void refresh();
      };
      stream.onerror = () => setConnection('reconnecting');
      document.addEventListener('visibilitychange', foreground);
    };
    void begin().catch((e: unknown) => {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'PANEL_UNAVAILABLE');
    });
    return () => {
      abort.abort();
      stream?.close();
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [taskId]);
  const cancel = async () => {
    if (!snapshot || !csrf) throw new Error('PANEL_SESSION_REQUIRED');
    const result = await panelJson(`/release-panel/api/tasks/${taskId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Release-CSRF': csrf },
      body: JSON.stringify({ expectedRevision: snapshot.revision, confirmation: 'cancel-release' })
    });
    setSnapshot(current => newerSnapshot(current, parseSnapshot(result)));
  };
  return { snapshot, connection, error, cancel };
}
