import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILD_ID,
  MAX_SUPPORTED_AGENT_API_VERSION,
  MIN_SUPPORTED_AGENT_API_VERSION,
  PRODUCT_VERSION,
  RELEASE_DOWNLOAD_URL,
  calculateQueueSummary,
  type AgentSettingsPatch,
  type CompressionJob,
  type QueueState,
  type SelectionResponse,
  type SelectionWarning
} from '@video-compressor/shared';
import {
  agentUrl,
  imageContentUrl,
  request,
  requestBody,
  uploadImage as uploadImageAsset,
  uploadFile
} from './api/client';
import { type ConnectionState } from './connection';
import { formatSize } from './format';
import { selectedCountKey, type Language, type TranslationKey, useI18n } from './i18n';
import { mergeSettingsPatches } from './settings-patch';
import {
  batchMetrics,
  newestJobsFirst,
  readySelectedIds,
  removableSelectedIds,
  selectableJobIds,
  toggleSelection
} from './queue-ui';
import { DropZone } from './components/DropZone';
import { JobRow } from './components/JobRow';
import { SettingsPanel } from './components/SettingsPanel';
import { Button, ProgressBar, Spinner, type Translate } from './components/ui';
import { WishlyLogo, WishlyMark } from './components/WishlyLogo';
import { useAgent } from './AgentContext';
import { internalLink } from './lib/navigation';
import { UserMenu } from './components/UserMenu';
import { SupportButton } from './components/SupportDialog';
import { analytics } from './analytics/service';
import {
  compressionErrorCategory,
  jobTransitionEventNames,
  safeBatchProperties,
  safeCompressionProperties
} from './analytics/compression';

const downloadUrl = RELEASE_DOWNLOAD_URL;

interface ToastMessage {
  id: number;
  text: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
}

export default function CompressorPage() {
  const { language, setLanguage, t } = useI18n();
  const { state, setState, connection, connectedOnce, reconnect } = useAgent();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [help, setHelp] = useState(false);
  const [embeddingFormValid, setEmbeddingFormValid] = useState(true);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastId = useRef(0);
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettings = useRef<AgentSettingsPatch>({});
  const previousJobs = useRef<Map<string, CompressionJob> | null>(null);
  const estimateStartedAt = useRef(new Map<string, number>());
  const connected = connection === 'connected';

  useEffect(() => {
    document.title = 'Video Compressor — Wishly';
    analytics.track('tool_opened', { tool_identifier: 'compressor' });
  }, []);

  useEffect(() => {
    if (!previousJobs.current) {
      previousJobs.current = new Map(state.jobs.map(job => [job.id, job]));
      return;
    }
    const now = Date.now();
    for (const job of state.jobs) {
      const previous = previousJobs.current.get(job.id);
      for (const event of jobTransitionEventNames(previous, job)) {
        const properties = safeCompressionProperties(job);
        if (event === 'estimate_started') {
          estimateStartedAt.current.set(job.id, now);
          analytics.track(event, properties);
        } else if (event === 'estimate_completed') {
          const started = estimateStartedAt.current.get(job.id);
          analytics.track(event, {
            ...properties,
            ...(started ? { processing_duration_ms: now - started } : {})
          });
          estimateStartedAt.current.delete(job.id);
        } else if (event === 'compression_failed') {
          analytics.track(event, {
            ...properties,
            success: false,
            error_category: compressionErrorCategory(job.error)
          });
        } else if (event === 'compression_completed') {
          analytics.track(event, { ...properties, success: true });
        } else {
          analytics.track(event, properties);
        }
      }
    }
    previousJobs.current = new Map(state.jobs.map(job => [job.id, job]));
  }, [state.jobs]);

  const addToast = (text: string, tone: ToastMessage['tone'] = 'neutral') => {
    const id = ++toastId.current;
    setToasts(current => [...current, { id, text, tone }]);
    window.setTimeout(() => {
      setToasts(current => current.filter(toast => toast.id !== id));
    }, 3600);
  };

  useEffect(
    () => () => {
      if (settingsTimer.current) clearTimeout(settingsTimer.current);
    },
    []
  );

  const jobIdsKey = state.jobs.map(job => job.id).join('|');
  useEffect(() => {
    const existing = new Set(state.jobs.map(job => job.id));
    setSelected(current => new Set([...current].filter(id => existing.has(id))));
  }, [jobIdsKey]);

  const handleError = (error: unknown) => {
    const text = localizedError(error, t);
    addToast(text, 'error');
    const code = error instanceof Error ? error.message : '';
    if (['CONNECTION_FAILED', 'TIMEOUT', 'PAIRING_REQUIRED'].includes(code)) {
      reconnect();
    }
  };

  const action = async (url: string, method = 'POST') => {
    try {
      setState(await request<QueueState>(url, method));
    } catch (error) {
      handleError(error);
    }
  };

  const sendSettings = async (patch: AgentSettingsPatch) => {
    try {
      setState(await requestBody<QueueState>('/api/settings', patch));
    } catch (error) {
      handleError(error);
    }
  };

  const updateSettings = (patch: AgentSettingsPatch, debounce = false) => {
    if (patch.imageEmbedding?.enabled === true && !state.settings.imageEmbedding.enabled)
      analytics.track('image_embedding_enabled', { image_embedding: true });
    if (!debounce) {
      if (settingsTimer.current) clearTimeout(settingsTimer.current);
      settingsTimer.current = null;
      const body = mergeSettingsPatches(pendingSettings.current, patch);
      pendingSettings.current = {};
      void sendSettings(body);
      return;
    }
    pendingSettings.current = mergeSettingsPatches(pendingSettings.current, patch);
    if (settingsTimer.current) clearTimeout(settingsTimer.current);
    settingsTimer.current = setTimeout(() => {
      const body = pendingSettings.current;
      pendingSettings.current = {};
      settingsTimer.current = null;
      void sendSettings(body);
    }, 350);
  };

  const selectNativeFiles = async () => {
    const before = new Set(state.jobs.map(job => job.id));
    try {
      const result = await request<SelectionResponse>('/api/files/select', 'POST');
      setState(result.state);
      selectNewJobs(before, result.state, setSelected);
      const added = result.state.jobs.filter(job => !before.has(job.id));
      if (added.length)
        analytics.track('videos_added', {
          video_count: added.length,
          total_input_bytes: added.reduce((total, job) => total + job.originalSize, 0)
        });
      await handleSelectionWarnings(
        result.warnings,
        result.state,
        t,
        addToast,
        setState,
        setSelected
      );
    } catch (error) {
      handleError(error);
    }
  };

  const addDroppedFiles = async (files: File[]) => {
    if (!files.length) return;
    setImporting(true);
    const known = new Set(state.jobs.map(job => job.id));
    try {
      let addedCount = 0;
      let addedBytes = 0;
      for (const file of files) {
        const result = await uploadFile(file);
        setState(result.state);
        selectNewJobs(known, result.state, setSelected);
        const added = result.state.jobs.filter(job => !known.has(job.id));
        addedCount += added.length;
        addedBytes += added.reduce((total, job) => total + job.originalSize, 0);
        for (const job of result.state.jobs) known.add(job.id);
        showSelectionWarnings(result.warnings, t, addToast);
      }
      if (addedCount)
        analytics.track('videos_added', {
          video_count: addedCount,
          total_input_bytes: addedBytes
        });
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const startSelected = async () => {
    const ids = readySelectedIds(state.jobs, selected);
    if (
      !ids.length ||
      !embeddingFormValid ||
      (state.settings.imageEmbedding.enabled &&
        !state.settings.imageEmbedding.startImage &&
        !state.settings.imageEmbedding.endImage)
    ) {
      return;
    }
    try {
      const next = await requestBody<QueueState>('/api/queue/start', { ids });
      setState(next);
      analytics.track(
        'compression_batch_started',
        safeBatchProperties(
          state.settings,
          state.jobs.filter(job => ids.includes(job.id))
        )
      );
      setSelected(current => {
        const updated = new Set(current);
        ids.forEach(id => updated.delete(id));
        return updated;
      });
      setLastSelectedIndex(null);
    } catch (error) {
      handleError(error);
    }
  };

  const setImage = async (slot: 'start' | 'end', file: File) => {
    try {
      setState(await uploadImageAsset(slot, file));
    } catch (error) {
      handleError(error);
      throw error;
    }
  };

  const removeImage = async (slot: 'start' | 'end') => {
    try {
      setState(await request<QueueState>(`/api/images/${slot}`, 'DELETE'));
    } catch (error) {
      handleError(error);
      throw error;
    }
  };

  const removeSelected = async () => {
    const removable = removableSelectedIds(state.jobs, selected);
    if (!removable.length) return;
    const activeSelected = [...selected].some(id =>
      state.jobs.some(job => job.id === id && ['processing', 'queued'].includes(job.status))
    );
    try {
      const next = await requestBody<QueueState>('/api/jobs/remove', { ids: [...selected] });
      setState(next);
      setSelected(current => {
        const existing = new Set(next.jobs.map(job => job.id));
        return new Set([...current].filter(id => existing.has(id)));
      });
      if (activeSelected) addToast(t('activeJobsNotRemoved'), 'warning');
    } catch (error) {
      handleError(error);
    }
  };

  const copyDiagnostics = async () => {
    try {
      const agent = await request('/api/diagnostics');
      await navigator.clipboard.writeText(
        JSON.stringify(
          {
            web: {
              version: PRODUCT_VERSION,
              buildId: BUILD_ID,
              revision: import.meta.env.VITE_WEB_REVISION ?? 'development',
              supportedAgentApi: {
                min: MIN_SUPPORTED_AGENT_API_VERSION,
                max: MAX_SUPPORTED_AGENT_API_VERSION
              },
              origin: location.origin
            },
            agent
          },
          null,
          2
        )
      );
      addToast(t('diagnosticsCopied'), 'success');
    } catch (error) {
      handleError(error);
    }
  };

  const visibleJobs = useMemo(() => newestJobsFirst(state.jobs), [state.jobs]);
  const selectableIds = useMemo(() => selectableJobIds(visibleJobs), [visibleJobs]);
  const selectedReady = readySelectedIds(state.jobs, selected);
  const selectedRemovable = removableSelectedIds(state.jobs, selected);
  const metrics = useMemo(() => batchMetrics(state.jobs, state.batch), [state.jobs, state.batch]);
  const summary = useMemo(() => calculateQueueSummary(state.jobs), [state.jobs]);
  const selectedLabel = selected.size
    ? t(selectedCountKey(language, selected.size), { count: selected.size })
    : t('noSelection');

  const header = (
    <Header
      language={language}
      setLanguage={setLanguage}
      connection={connection}
      showProblemAction={!connected}
      copyDiagnostics={() => void copyDiagnostics()}
      onHome={event => {
        if (state.running && !confirm(t('leaveCompressorConfirm'))) {
          event.preventDefault();
          return;
        }
        internalLink(event, '/');
      }}
      t={t}
    />
  );

  if (connection === 'checking') {
    return (
      <div className="app-shell">
        {header}
        <main className="workspace compact-state">
          <Spinner />
          <span>{t('connectingAgent')}</span>
        </main>
      </div>
    );
  }

  if (!connected && !connectedOnce) {
    return (
      <div className="app-shell">
        {header}
        <main className="workspace">
          <Onboarding state={connection} help={help} setHelp={setHelp} connect={reconnect} t={t} />
        </main>
        <ToastRegion toasts={toasts} />
      </div>
    );
  }

  return (
    <div className="app-shell">
      {header}
      <main className="workspace">
        {!connected && (
          <BlockingMessage
            title={t('agentDisconnected')}
            body={t('restoreQueue')}
            action={<Button onClick={reconnect}>{t('reconnect')}</Button>}
          />
        )}
        {connected && (!state.tools.ffmpeg || !state.tools.ffprobe) && (
          <BlockingMessage title={t('engineUnavailable')} tone="error" />
        )}
        {state.warning && (
          <BlockingMessage title={localizedAgentText(state.warning, t)} tone="warning" />
        )}

        <SettingsPanel
          settings={state.settings}
          disabled={!connected}
          hasUploadedFiles={state.jobs.some(job => job.sourceKind === 'uploaded')}
          updateSettings={updateSettings}
          chooseOutputFolder={() => void action('/api/output/select')}
          uploadImage={setImage}
          removeImage={removeImage}
          imageUrl={imageContentUrl}
          onEmbeddingValidityChange={setEmbeddingFormValid}
          t={t}
        />

        <section className="add-files-section" aria-label={t('chooseFiles')}>
          <DropZone
            disabled={!connected || importing || !state.tools.ffprobe}
            importing={importing}
            chooseFiles={() => void selectNativeFiles()}
            addDroppedFiles={files => void addDroppedFiles(files)}
            t={t}
          />
          <p>{t('processedLocally')}</p>
        </section>

        {state.jobs.length > 0 && (
          <>
            <section
              className="batch-toolbar"
              aria-label={t('fileActions', { name: t('appName') })}
            >
              <div className="selection-actions">
                <Button
                  variant="ghost"
                  disabled={!connected || selectableIds.length === 0}
                  onClick={() => setSelected(new Set(selectableIds))}
                >
                  {t('selectAll')}
                </Button>
                <Button
                  variant="ghost"
                  disabled={!connected || selected.size === 0}
                  onClick={() => {
                    setSelected(new Set());
                    setLastSelectedIndex(null);
                  }}
                >
                  {t('clearSelection')}
                </Button>
                <span className="selected-count" aria-live="polite">
                  {selectedLabel}
                </span>
              </div>
              <div className="primary-actions">
                <Button
                  variant="primary"
                  disabled={
                    !connected ||
                    state.running ||
                    selectedReady.length === 0 ||
                    !embeddingFormValid ||
                    (state.settings.imageEmbedding.enabled &&
                      !state.settings.imageEmbedding.startImage &&
                      !state.settings.imageEmbedding.endImage)
                  }
                  onClick={() => void startSelected()}
                >
                  {t('compressSelected')}
                </Button>
                <Button
                  variant="danger"
                  disabled={!connected || selectedRemovable.length === 0}
                  onClick={() => void removeSelected()}
                >
                  {t('removeSelected')}
                </Button>
                {state.jobs.some(job =>
                  ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)
                ) && (
                  <Button
                    variant="ghost"
                    disabled={!connected}
                    onClick={() => void action('/api/jobs/completed', 'DELETE')}
                  >
                    {t('clearFinished')}
                  </Button>
                )}
              </div>
            </section>

            {state.batch && <BatchProgress metrics={metrics} t={t} />}
          </>
        )}

        <section className="video-list" aria-live="polite">
          {state.jobs.length === 0 ? (
            <div className="empty-state">
              <strong>{t('queueEmpty')}</strong>
              <span>{t('queueEmptyBody')}</span>
            </div>
          ) : (
            visibleJobs.map((job, index) => (
              <JobRow
                key={job.id}
                job={job}
                selected={selected.has(job.id)}
                disabled={!connected}
                compressionRunning={state.running}
                language={language}
                onSelected={(checked, shiftKey) => {
                  const update = toggleSelection(
                    selected,
                    job.id,
                    checked,
                    selectableIds,
                    lastSelectedIndex,
                    shiftKey
                  );
                  setSelected(update.selected);
                  setLastSelectedIndex(update.lastIndex ?? index);
                }}
                action={(url, method) => void action(url, method)}
                t={t}
              />
            ))
          )}
        </section>

        {(summary.successful > 0 || summary.failed > 0) && (
          <section className="result-summary" aria-labelledby="summary-title">
            <h2 id="summary-title">{t('summaryTitle')}</h2>
            <dl>
              <div>
                <dt>{t('summaryFiles')}</dt>
                <dd>{summary.successful}</dd>
              </div>
              <div>
                <dt>{t('summaryOriginal')}</dt>
                <dd>{formatSize(summary.originalSize, language)}</dd>
              </div>
              <div>
                <dt>{t('summaryResult')}</dt>
                <dd>{formatSize(summary.finalSize, language)}</dd>
              </div>
              <div>
                <dt>{t('summarySaved')}</dt>
                <dd>
                  {formatSize(summary.savedBytes, language)} · {summary.savedPercent}%
                </dd>
              </div>
            </dl>
            {summary.successful > 0 && (
              <Button
                variant="ghost"
                disabled={!connected}
                onClick={() => void action('/api/output/reveal')}
              >
                {t('showOutput')}
              </Button>
            )}
          </section>
        )}
      </main>
      <ToastRegion toasts={toasts} />
    </div>
  );
}

export function Header({
  language,
  setLanguage,
  connection,
  showProblemAction,
  copyDiagnostics,
  onHome,
  showDiagnostics = true,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  connection: ConnectionState;
  showProblemAction: boolean;
  copyDiagnostics: () => void;
  onHome?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  showDiagnostics?: boolean;
  t: Translate;
}) {
  return (
    <header className="topbar">
      <div className="topbar-lead">
        <h1>
          <a
            className="brand-link"
            href="/"
            onClick={event => (onHome ? onHome(event) : internalLink(event, '/'))}
            aria-label={t('backToTools')}
          >
            <WishlyLogo name={t('appName')} />
          </a>
        </h1>
        <SupportButton />
      </div>
      <div className="topbar-actions">
        <div className="language-switch" aria-label={t('language')}>
          <button
            className={language === 'en' ? 'is-active' : ''}
            onClick={() => setLanguage('en')}
          >
            EN
          </button>
          <button
            className={language === 'uk' ? 'is-active' : ''}
            onClick={() => setLanguage('uk')}
          >
            UA
          </button>
        </div>
        <ConnectionBadge state={connection} t={t} />
        {showDiagnostics && (
          <details className="header-menu">
            <summary aria-label={t('menu')}>•••</summary>
            <div>
              <strong>{t('diagnostics')}</strong>
              <button onClick={copyDiagnostics}>{t('copyDiagnostics')}</button>
              {showProblemAction && (
                <a href={`${agentUrl}/local`} target="_blank" rel="noreferrer">
                  {t('openLocal')}
                </a>
              )}
            </div>
          </details>
        )}
        <UserMenu />
      </div>
    </header>
  );
}

export function ConnectionBadge({ state, t }: { state: ConnectionState; t: Translate }) {
  const keys: Record<ConnectionState, TranslationKey> = {
    checking: 'connectingAgent',
    connecting: 'lookingForAgent',
    connected: 'agentConnected',
    not_installed_or_not_running: 'agentNotRunning',
    pairing_required: 'agentReady',
    agent_update_required: 'agentUpdateRequired',
    web_update_required: 'webUpdateRequired',
    connection_blocked: 'connectionBlocked',
    disconnected: 'agentDisconnected'
  };
  return (
    <span className={`connection-badge connection-${state}`}>
      <i aria-hidden="true" />
      {t(keys[state])}
    </span>
  );
}

export function Onboarding({
  state,
  help,
  setHelp,
  connect,
  t
}: {
  state: ConnectionState;
  help: boolean;
  setHelp: (value: boolean) => void;
  connect: () => void;
  t: Translate;
}) {
  if (state === 'connecting') {
    return (
      <BlockingMessage title={t('lookingForAgent')} body={t('keepAgentOpen')} icon={<Spinner />} />
    );
  }
  if (state === 'pairing_required') {
    return (
      <BlockingMessage
        title={t('pairingTitle')}
        body={t('pairingBody')}
        action={
          <Button variant="primary" onClick={connect}>
            {t('connectAgent')}
          </Button>
        }
      />
    );
  }
  if (state === 'agent_update_required') {
    return (
      <BlockingMessage
        title={t('updateTitle')}
        body={t('updateBody')}
        action={
          <div className="inline-actions">
            <a className="button button-primary" href={`${agentUrl}/local`}>
              {t('openInstalledVersion')}
            </a>
            <a className="button button-secondary" href={downloadUrl}>
              {t('downloadLatest')}
            </a>
          </div>
        }
      />
    );
  }
  if (state === 'web_update_required') {
    return (
      <BlockingMessage
        title={t('webUpdateTitle')}
        body={t('webUpdateBody')}
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('reloadPage')}
          </Button>
        }
      />
    );
  }
  if (state === 'connection_blocked') {
    return (
      <BlockingMessage
        title={t('blockedTitle')}
        body={t('blockedBody')}
        action={
          <div className="inline-actions">
            <Button variant="primary" onClick={connect}>
              {t('tryAgain')}
            </Button>
            <a
              className="button button-secondary"
              href={`${agentUrl}/local`}
              target="_blank"
              rel="noreferrer"
            >
              {t('openLocal')}
            </a>
          </div>
        }
      />
    );
  }
  return (
    <section className="onboarding-panel">
      <WishlyMark size={40} />
      <h2>{t('onboardingTitle')}</h2>
      <p>{t('onboardingBody')}</p>
      <div className="inline-actions">
        <a className="button button-primary" href={downloadUrl}>
          {t('downloadAgent')}
        </a>
        <Button onClick={connect}>{t('connectAgent')}</Button>
      </div>
      <p className="agent-search" role="status">
        <span className="agent-search-dot" aria-hidden="true" />
        {t('lookingForAgent')}
      </p>
      <button className="text-button" onClick={() => setHelp(!help)} aria-expanded={help}>
        {t('installationHelp')}
      </button>
      {help && (
        <div className="installation-help">
          <h3>{t('installTitle')}</h3>
          <ol>
            {(['install1', 'install2', 'install3', 'install4'] as TranslationKey[]).map(key => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>
          <p>{t('gatekeeperHelp')}</p>
        </div>
      )}
    </section>
  );
}

function BlockingMessage({
  title,
  body,
  action,
  icon,
  tone = 'neutral'
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'neutral' | 'warning' | 'error';
}) {
  return (
    <section className={`blocking-message blocking-${tone}`} role="alert">
      {icon}
      <div>
        <strong>{title}</strong>
        {body && <span>{body}</span>}
      </div>
      {action}
    </section>
  );
}

function BatchProgress({ metrics, t }: { metrics: ReturnType<typeof batchMetrics>; t: Translate }) {
  return (
    <section className="batch-progress" aria-label={t('batchProgress')}>
      <div className="batch-progress-heading">
        <strong>{t('batchProgress')}</strong>
        <span>{Math.round(metrics.progress)}%</span>
      </div>
      <ProgressBar
        value={metrics.progress}
        label={t('overallProgress')}
        active={metrics.processing > 0}
      />
      <div className="batch-counts">
        <span>{t('queuedCount', { count: metrics.queued })}</span>
        <span>{t('processingCount', { count: metrics.processing })}</span>
        <span>{t('completedCount', { count: metrics.completed })}</span>
        <span>{t('failedCount', { count: metrics.failed })}</span>
      </div>
    </section>
  );
}

function ToastRegion({ toasts }: { toasts: ToastMessage[] }) {
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.text}
        </div>
      ))}
    </div>
  );
}

async function handleSelectionWarnings(
  warnings: SelectionWarning[],
  state: QueueState,
  t: Translate,
  addToast: (text: string, tone?: ToastMessage['tone']) => void,
  setState: (state: QueueState) => void,
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
) {
  showSelectionWarnings(warnings, t, addToast);
  const confirmable = warnings.filter(warning =>
    ['duplicate', 'already-compressed'].includes(warning.reason)
  );
  if (!confirmable.length) return;
  const prompt = confirmable
    .map(warning => `${warning.fileName}: ${warningText(warning, t)}`)
    .join('\n');
  if (!window.confirm(`${prompt}\n\n${t('addAnyway')}`)) return;
  const before = new Set(state.jobs.map(job => job.id));
  const next = await requestBody<QueueState>('/api/files/confirm', {
    ids: confirmable.map(warning => warning.id)
  });
  setState(next);
  selectNewJobs(before, next, setSelected);
}

function showSelectionWarnings(
  warnings: SelectionWarning[],
  t: Translate,
  addToast: (text: string, tone?: ToastMessage['tone']) => void
) {
  for (const warning of warnings) {
    addToast(`${warning.fileName}: ${warningText(warning, t)}`, 'warning');
  }
}

function warningText(warning: SelectionWarning, t: Translate) {
  const keys: Record<SelectionWarning['reason'], TranslationKey> = {
    duplicate: 'duplicate',
    'already-compressed': 'alreadyCompressed',
    'unsupported-format': 'unsupportedFormat',
    inaccessible: 'inaccessibleFile'
  };
  return t(keys[warning.reason]);
}

function selectNewJobs(
  before: ReadonlySet<string>,
  next: QueueState,
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
) {
  const added = next.jobs.filter(job => !before.has(job.id) && job.status !== 'analyzing');
  if (!added.length) return;
  setSelected(current => {
    const updated = new Set(current);
    added.forEach(job => updated.add(job.id));
    return updated;
  });
}

function localizedError(value: unknown, t: Translate) {
  const raw = value instanceof Error ? value.message : '';
  const map: Record<string, TranslationKey> = {
    PAIRING_REQUIRED: 'pairingRequired',
    CONNECTION_FAILED: 'connectionFailed',
    TIMEOUT: 'timeout',
    'Invalid session token.': 'invalidToken',
    EMBED_IMAGES_REQUIRED: 'embeddingNeedsImage',
    INVALID_CUSTOM_IMAGE_DURATION: 'invalidCustomDuration',
    IMAGE_UNSUPPORTED_FORMAT: 'unsupportedImageFormat',
    IMAGE_DAMAGED: 'damagedImage',
    IMAGE_TOO_LARGE: 'imageTooLarge',
    IMAGE_UNAVAILABLE: 'imageUnavailable',
    IMAGE_IMPORT_FAILED: 'imageUploadFailed'
  };
  return t(map[raw] ?? 'genericError');
}

function localizedAgentText(raw: string, t: Translate) {
  if (/free space may be insufficient/i.test(raw)) return t('diskWarning');
  if (/could not check free space/i.test(raw)) return t('diskCheckFailed');
  return raw;
}
