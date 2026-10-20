import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { Button, ErrorState, LoadingState } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import { analytics } from '../../analytics/service';
import { trackToolError } from '../../analytics/errors';
import type { LaunchSession } from './LaunchSession';

// Analytics is best effort: enqueue/identity failures cannot interrupt loading,
// retry or modal cleanup. Keep the same protection for the error tracker adapter.
const trackLoadSignal: typeof analytics.track = (name, properties) => {
  try {
    analytics.track(name, properties);
  } catch {
    // Missing diagnostics remains unknown; never fail the user's launch session.
  }
};

type Session = typeof LaunchSession;
export type LaunchSessionLoader = () => Promise<{ LaunchSession: Session }>;
type SessionProps = ComponentProps<Session>;

let loadedSession: Session | null = null;
let loadingSession: ReturnType<LaunchSessionLoader> | null = null;

/** Launch editing, recovery and result UI are requested only when its modal opens. */
const loadSession: LaunchSessionLoader = () => {
  if (loadedSession) return Promise.resolve({ LaunchSession: loadedSession });
  loadingSession ??= import('./LaunchSession').then(
    module => {
      loadedSession = module.LaunchSession;
      return module;
    },
    error => {
      loadingSession = null;
      throw error;
    }
  );
  return loadingSession;
};

export function DeferredLaunchSession({
  loader = loadSession,
  ...props
}: SessionProps & { loader?: LaunchSessionLoader }) {
  const { t } = useI18n();
  const [SessionComponent, setSessionComponent] = useState<Session | null>(() =>
    loader === loadSession ? loadedSession : null
  );
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [flowId] = useState(() => crypto.randomUUID());
  const [readyAttempt, setReadyAttempt] = useState<string | null>(null);
  const pending = useRef<{ id: string; started: number; finished: boolean } | null>(null);

  useLayoutEffect(() => {
    if (SessionComponent) return;
    // Before the session exists there is no dirty draft to guard. Give the
    // parent modal's Escape/backdrop its real close action immediately.
    const close = props.onClose;
    props.closeRequestRef.current = close;
    return () => {
      // The session installs its own draft guard during render. Never replace
      // it when the successful import commits, or on later tab changes.
      if (props.closeRequestRef.current === close) props.closeRequestRef.current = () => {};
    };
  }, [SessionComponent, props.onClose, props.closeRequestRef]);

  useEffect(() => {
    let active = true;
    const request = { id: crypto.randomUUID(), started: Date.now(), finished: false };
    pending.current = request;
    const properties = {
      flow_id: flowId,
      attempt_id: request.id,
      flow_step: 'launch_detail_session'
    };
    trackLoadSignal('operation_started', properties);
    setFailed(false);
    void (async () => loader())().then(
      module => {
        if (active) {
          setSessionComponent(() => module.LaunchSession);
          setReadyAttempt(request.id);
        }
      },
      () => {
        if (!active) return;
        request.finished = true;
        setFailed(true);
        trackLoadSignal('operation_failed', {
          ...properties,
          outcome: 'failure',
          error_code: 'LAUNCH_SESSION_LOAD_FAILED',
          duration_ms: Math.max(0, Date.now() - request.started)
        });
        // Import exceptions may contain a URL, token or provider text. Only our
        // stable failure category crosses the analytics boundary.
        trackToolError(
          {
            tool: 'team',
            stage: 'library',
            code: 'LAUNCH_SESSION_LOAD_FAILED',
            flowId,
            attemptId: request.id,
            retryable: true
          },
          {
            track: (name, properties) =>
              trackLoadSignal(name, { ...properties, flow_step: 'launch_detail_session' })
          }
        );
      }
    );
    return () => {
      active = false;
      if (!request.finished) {
        request.finished = true;
        trackLoadSignal('operation_cancelled', {
          ...properties,
          outcome: 'cancelled',
          duration_ms: Math.max(0, Date.now() - request.started)
        });
      }
    };
  }, [loader, attempt, flowId]);
  useEffect(() => {
    const request = pending.current;
    if (!SessionComponent || !readyAttempt || request?.id !== readyAttempt || request.finished)
      return;
    // This runs after the loaded session subtree reaches React's DOM commit.
    // Resolving an import alone never proves the detail session was presented.
    request.finished = true;
    trackLoadSignal('operation_completed', {
      flow_id: flowId,
      attempt_id: request.id,
      flow_step: 'launch_detail_session',
      outcome: 'success',
      success: true,
      duration_ms: Math.max(0, Date.now() - request.started)
    });
  }, [SessionComponent, readyAttempt, flowId]);

  if (SessionComponent) return <SessionComponent {...props} />;
  return (
    <div className="flex flex-col gap-3">
      {failed ? (
        <ErrorState
          title={t('launchesTitle')}
          message={t('genericError')}
          retryLabel={t('retry')}
          onRetry={() => setAttempt(current => current + 1)}
        />
      ) : (
        <LoadingState shape="block" count={1} label={t('launchesTitle')} />
      )}
      <Button variant="ghost" onClick={props.onClose}>
        {t('teamClose')}
      </Button>
    </div>
  );
}
