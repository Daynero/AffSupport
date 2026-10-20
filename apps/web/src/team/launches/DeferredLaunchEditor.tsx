import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { analytics } from '../../analytics/service';
import { trackToolError } from '../../analytics/errors';
import { ErrorState, LoadingState } from '../../components/ui/index';
import { useI18n } from '../../i18n';
import type { LaunchEditor } from './LaunchEditor';

// Analytics is best effort: enqueue/identity failures cannot interrupt loading,
// retry or modal cleanup. Keep the same protection for the error tracker adapter.
const trackLoadSignal: typeof analytics.track = (name, properties) => {
  try {
    analytics.track(name, properties);
  } catch {
    // Missing diagnostics remains unknown; never fail the user's launch session.
  }
};

type Editor = typeof LaunchEditor;
export type LaunchEditorLoader = () => Promise<{ LaunchEditor: Editor }>;
type EditorProps = ComponentProps<Editor>;

let loadedEditor: Editor | null = null;
let loadingEditor: ReturnType<LaunchEditorLoader> | null = null;

/** The list and saved result never request the settings editor's dependencies. */
const loadEditor: LaunchEditorLoader = () => {
  if (loadedEditor) return Promise.resolve({ LaunchEditor: loadedEditor });
  loadingEditor ??= import('./LaunchEditor').then(
    module => {
      loadedEditor = module.LaunchEditor;
      return module;
    },
    error => {
      // Keep a failed request retryable instead of caching a rejected lazy component.
      loadingEditor = null;
      throw error;
    }
  );
  return loadingEditor;
};

export function DeferredLaunchEditor({
  loader = loadEditor,
  ...props
}: EditorProps & { loader?: LaunchEditorLoader }) {
  const { t } = useI18n();
  const [EditorComponent, setEditorComponent] = useState<Editor | null>(() =>
    loader === loadEditor ? loadedEditor : null
  );
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [flowId] = useState(() => crypto.randomUUID());
  const [readyAttempt, setReadyAttempt] = useState<string | null>(null);
  const pending = useRef<{ id: string; started: number; finished: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    const request = { id: crypto.randomUUID(), started: Date.now(), finished: false };
    pending.current = request;
    const properties = {
      flow_id: flowId,
      attempt_id: request.id,
      flow_step: 'launch_settings_editor'
    };
    trackLoadSignal('operation_started', properties);
    setFailed(false);
    void (async () => loader())().then(
      module => {
        if (active) {
          setEditorComponent(() => module.LaunchEditor);
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
          error_code: 'LAUNCH_EDITOR_LOAD_FAILED',
          duration_ms: Math.max(0, Date.now() - request.started)
        });
        // Import exceptions may contain a URL, token or provider text. Only our
        // stable failure category crosses the analytics boundary.
        trackToolError(
          {
            tool: 'team',
            stage: 'library',
            code: 'LAUNCH_EDITOR_LOAD_FAILED',
            flowId,
            attemptId: request.id,
            retryable: true
          },
          {
            track: (name, properties) =>
              trackLoadSignal(name, { ...properties, flow_step: 'launch_settings_editor' })
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
    if (!EditorComponent || !readyAttempt || request?.id !== readyAttempt || request.finished)
      return;
    // This runs after the loaded editor subtree reaches React's DOM commit.
    // Resolving an import alone never proves the settings were presented.
    request.finished = true;
    trackLoadSignal('operation_completed', {
      flow_id: flowId,
      attempt_id: request.id,
      flow_step: 'launch_settings_editor',
      outcome: 'success',
      success: true,
      duration_ms: Math.max(0, Date.now() - request.started)
    });
  }, [EditorComponent, readyAttempt, flowId]);

  if (EditorComponent) return <EditorComponent {...props} />;
  if (failed)
    return (
      <ErrorState
        title={t('launchesSettings')}
        message={t('genericError')}
        retryLabel={t('retry')}
        onRetry={() => setAttempt(current => current + 1)}
      />
    );
  return <LoadingState shape="block" count={1} label={t('launchesSettings')} />;
}
