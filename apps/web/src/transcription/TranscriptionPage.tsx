import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TranscriptionJob, TranscriptionState } from '@video-compressor/shared';
import { TRANSCRIPTION_LANGUAGE_CODES } from '@video-compressor/shared';
import { createPortal } from 'react-dom';
import {
  request,
  transcriptionAddLocalFiles,
  transcriptionCancel,
  transcriptionClearFinished,
  transcriptionDocument,
  transcriptionEventUrl,
  transcriptionModelCancel,
  transcriptionModelDownload,
  transcriptionTranslatorCancel,
  transcriptionTranslatorDownload,
  transcriptionRemove,
  transcriptionRetry,
  transcriptionReveal,
  transcriptionSelect,
  transcriptionSettings,
  transcriptionStart,
  transcriptionUpload,
  type TranscriptionSelectionResponse
} from '../api/client';
import { Header, Onboarding } from '../App';
import { useAgent } from '../AgentContext';
import { DropZone } from '../components/DropZone';
import {
  Button,
  ProgressBar,
  Spinner,
  StatusBadge,
  Tooltip,
  type Translate
} from '../components/ui';
import { formatSize } from '../format';
import { useI18n, type Language } from '../i18n';
import { internalLink } from '../lib/navigation';
import { analytics } from '../analytics/service';
import { languageDisplayName } from './language';
import { TranscriptTextModal } from './TranscriptTextModal';
import { formatTranscriptionBatch } from './copy';

type TranscriptionModelInfo = NonNullable<TranscriptionState['model']>;

function combineModelInfo(
  label: string,
  parts: readonly TranscriptionModelInfo[]
): TranscriptionModelInfo {
  const activeBatchId =
    parts.find(part => part.downloading && part.downloadBatchId)?.downloadBatchId ?? null;
  const participants = activeBatchId
    ? parts.filter(part => part.downloadBatchId === activeBatchId)
    : parts.filter(part => !part.present);
  const sizeBytes = participants.reduce((sum, part) => sum + Math.max(0, part.sizeBytes), 0);
  const downloadedBytes = participants.reduce(
    (sum, part) =>
      sum +
      (part.present
        ? Math.max(0, part.sizeBytes)
        : Math.min(Math.max(0, part.downloadedBytes), Math.max(0, part.sizeBytes))),
    0
  );
  const present = parts.every(part => part.present);
  const downloading = parts.some(part => part.downloading);
  return {
    present,
    downloading,
    progress: present
      ? 100
      : downloading && sizeBytes > 0
        ? Math.min(99, Math.floor((downloadedBytes / sizeBytes) * 100))
        : null,
    sizeBytes,
    downloadedBytes,
    downloadBatchId: activeBatchId,
    label,
    error: parts.map(part => part.error).find((error): error is string => Boolean(error)) ?? null
  };
}

interface ToastMessage {
  id: number;
  text: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
}

export default function TranscriptionPage() {
  const { language, setLanguage, t } = useI18n();
  const { connection, connectedOnce, reconnect, capabilities } = useAgent();
  const [state, setState] = useState<TranscriptionState | null>(null);
  const [help, setHelp] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<{ jobId: string; trigger: HTMLElement | null } | null>(
    null
  );
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [confirmingDownload, setConfirmingDownload] = useState(false);
  const [copyingAll, setCopyingAll] = useState(false);
  const toastId = useRef(0);
  // Job ids the user asked to transcribe before the model was present; started
  // automatically once the download completes.
  const pendingStart = useRef<string[] | null>(null);
  const connected = connection === 'connected';
  const canUseLocalPaths = capabilities.includes('local-file-paths');

  useEffect(() => {
    document.title = 'Transcription — Wishly';
    analytics.track('tool_opened', { tool_identifier: 'transcription' });
  }, []);

  useEffect(() => {
    if (connection !== 'connected') return;
    let source: EventSource | null = null;
    let active = true;
    request<TranscriptionState>('/api/transcription/state', 'GET')
      .then(value => {
        if (active) setState(value);
      })
      .catch(() => {});
    source = new EventSource(transcriptionEventUrl());
    source.onmessage = event => {
      const update = JSON.parse(event.data) as { state: TranscriptionState };
      setState(update.state);
    };
    return () => {
      active = false;
      source?.close();
    };
  }, [connection]);

  const addToast = (text: string, tone: ToastMessage['tone'] = 'neutral') => {
    const id = ++toastId.current;
    setToasts(current => [...current, { id, text, tone }]);
    window.setTimeout(() => setToasts(current => current.filter(toast => toast.id !== id)), 3600);
  };

  const handleError = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    if (['CONNECTION_FAILED', 'TIMEOUT', 'PAIRING_REQUIRED'].includes(message)) reconnect();
    addToast(message && message.length < 120 ? message : t('transcriptionFailedTitle'), 'error');
  };

  const applySelection = (response: TranscriptionSelectionResponse) => {
    setState(response.state);
    for (const warning of response.warnings) {
      addToast(`${warning.fileName}: ${warning.message}`, 'warning');
    }
  };

  const jobs = state?.jobs ?? [];
  const visibleJobs = useMemo(() => [...jobs].sort((a, b) => b.createdAt - a.createdAt), [jobs]);
  const settings = state?.settings ?? { language: 'auto' };
  const tools = state?.tools ?? { ffmpeg: false, whisper: false, model: false };
  const emptyModelInfo: TranscriptionModelInfo = {
    present: false,
    downloading: false,
    progress: null,
    sizeBytes: 0,
    downloadedBytes: 0,
    label: '',
    error: null
  };
  const model: TranscriptionModelInfo = state?.model ?? emptyModelInfo;
  const translatorModel: TranscriptionModelInfo = state?.translatorModel ?? emptyModelInfo;
  const alignmentModel: TranscriptionModelInfo = state?.alignmentModel ?? emptyModelInfo;
  const localModelBundle = combineModelInfo(t('transcriptionLocalModels'), [
    model,
    translatorModel,
    alignmentModel
  ]);
  const translationBundle = combineModelInfo(t('transcriptionTranslationModels'), [
    translatorModel,
    alignmentModel
  ]);
  // The whisper binary + ffmpeg are what make the tool operable; the model is a
  // separate, on-demand download handled by its own gate.
  const binaryReady = tools.ffmpeg && tools.whisper;
  const modelReady = tools.model;
  const readyJobs = jobs.filter(job => job.status === 'ready' || job.status === 'cancelled');
  const finishedJobs = jobs.filter(
    job => job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
  );
  const copyableJobs = visibleJobs.filter(
    job => job.status === 'completed' && (job.characters ?? 0) > 0
  );
  const previewJob = preview ? jobs.find(job => job.id === preview.jobId) : null;

  const updateLanguage = async (value: string) => {
    try {
      setState(await transcriptionSettings({ language: value }));
    } catch (error) {
      handleError(error);
    }
  };

  const chooseFiles = async () => {
    if (importing || !connected) return;
    setImporting(true);
    try {
      applySelection(await transcriptionSelect());
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const addDroppedFiles = async (files: File[]) => {
    if (importing || !files.length) return;
    setImporting(true);
    try {
      for (const file of files) {
        applySelection(await transcriptionUpload(file));
      }
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const addDroppedFilePaths = async (paths: string[]) => {
    if (importing || !paths.length) return;
    setImporting(true);
    try {
      applySelection(await transcriptionAddLocalFiles(paths));
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const startNow = async (ids: string[]) => {
    if (!ids.length) return;
    try {
      setState(await transcriptionStart(ids));
    } catch (error) {
      handleError(error);
    }
  };

  // Clicking transcribe with no model yet opens the one-time download prompt and
  // remembers what to start once it finishes.
  const requestStart = (ids: string[]) => {
    if (!ids.length) return;
    if (!localModelBundle.present) {
      pendingStart.current = ids;
      setConfirmingDownload(true);
      return;
    }
    void startNow(ids);
  };

  const confirmDownload = async () => {
    setConfirmingDownload(false);
    try {
      setState(await transcriptionModelDownload());
      // If Whisper was already installed, translation/alignment can continue
      // downloading in the background while the shared resource queue starts
      // transcription immediately.
      if (model.present && pendingStart.current) {
        const ids = pendingStart.current;
        pendingStart.current = null;
        await startNow(ids);
      }
    } catch (error) {
      handleError(error);
    }
  };

  const continueWithoutTranslation = () => {
    const ids = pendingStart.current;
    pendingStart.current = null;
    setConfirmingDownload(false);
    if (model.present && ids) void startNow(ids);
  };

  const cancelDownloadConfirmation = () => {
    pendingStart.current = null;
    setConfirmingDownload(false);
  };

  const cancelDownload = async () => {
    try {
      setState(await transcriptionModelCancel());
    } catch (error) {
      handleError(error);
    }
  };

  // Auto-start whatever the user queued for download once the model arrives.
  useEffect(() => {
    if (model.present && pendingStart.current) {
      const ids = pendingStart.current;
      pendingStart.current = null;
      void startNow(ids);
    }
  }, [model.present]);

  const run = async (action: () => Promise<TranscriptionState>) => {
    try {
      setState(await action());
    } catch (error) {
      handleError(error);
    }
  };

  const copyTranscript = async (jobId: string) => {
    try {
      const document = await transcriptionDocument(jobId);
      const text = document.segments.map(segment => segment.sourceText).join('\n');
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      addToast(t('transcriptionFailedTitle'), 'error');
      return false;
    }
  };

  const copyAllTranscripts = async () => {
    if (!copyableJobs.length || copyingAll) return;
    setCopyingAll(true);
    try {
      const documents = await Promise.all(copyableJobs.map(job => transcriptionDocument(job.id)));
      const text = formatTranscriptionBatch(
        documents.map(document => document.segments.map(segment => segment.sourceText).join('\n')),
        number => t('transcriptionBatchHeading', { number })
      );
      await navigator.clipboard.writeText(text);
      addToast(t('transcriptionCopiedTranscripts'), 'success');
    } catch {
      addToast(t('transcriptionFailedTitle'), 'error');
    } finally {
      setCopyingAll(false);
    }
  };

  const header = (
    <Header
      language={language}
      setLanguage={setLanguage}
      connection={connection}
      onHome={event => {
        if (state?.running && !confirm(t('transcriptionProcessedLocally'))) {
          // Transcription keeps running in the background; no destructive leave.
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
        {connected && state && !binaryReady && (
          <section className="blocking-message blocking-error" role="alert">
            <div>
              <strong>{t('transcriptionEngineUnavailable')}</strong>
              <span>{t('transcriptionEngineUnavailableBody')}</span>
            </div>
          </section>
        )}

        {connected && binaryReady && !modelReady && (
          <ModelGate
            model={localModelBundle}
            parts={[model, translatorModel, alignmentModel]}
            language={language}
            onDownload={() => setConfirmingDownload(true)}
            onCancel={cancelDownload}
            t={t}
          />
        )}

        <section
          className="settings-panel transcription-settings-panel"
          aria-labelledby="transcription-settings-title"
        >
          <div className="section-heading compact-heading">
            <h2 id="transcription-settings-title">{t('transcriptionSettingsTitle')}</h2>
          </div>
          <div className="field-group transcription-language-field">
            <div className="field-label">
              <span>{t('transcriptionLanguage')}</span>
              <Tooltip label={t('transcriptionLanguageHint')}>
                {t('transcriptionLanguageHint')}
              </Tooltip>
            </div>
            <select
              className="transcription-language-select"
              value={settings.language}
              disabled={!connected || !binaryReady}
              onChange={event => void updateLanguage(event.target.value)}
            >
              {TRANSCRIPTION_LANGUAGE_CODES.map(code => (
                <option key={code} value={code}>
                  {code === 'auto'
                    ? t('transcriptionLanguageAuto')
                    : languageDisplayName(code, language)}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="add-files-section" aria-label={t('transcriptionDropTitle')}>
          <DropZone
            disabled={!connected || importing || !binaryReady}
            importing={importing}
            chooseFiles={() => void chooseFiles()}
            addDroppedFiles={files => void addDroppedFiles(files)}
            addDroppedFilePaths={
              canUseLocalPaths ? paths => void addDroppedFilePaths(paths) : undefined
            }
            title={t('transcriptionDropTitle')}
            activeLabel={t('transcriptionDropActive')}
            formats={t('transcriptionDropFormats')}
            importingLabel={t('transcriptionImporting')}
            t={t}
          />
          <p>{t('transcriptionProcessedLocally')}</p>
        </section>

        {jobs.length > 0 && (
          <section className="batch-toolbar" aria-label={t('transcriptionQueueTitle')}>
            <div className="batch-toolbar-info">
              <strong>{t('transcriptionQueueTitle')}</strong>
              <span>{t('transcriptionQueueCount', { count: jobs.length })}</span>
            </div>
            <div className="batch-toolbar-actions">
              <Button
                variant="primary"
                disabled={!connected || !binaryReady || model.downloading || readyJobs.length === 0}
                onClick={() => requestStart(readyJobs.map(job => job.id))}
              >
                {t('transcriptionStartAll')}
              </Button>
              <Button
                variant="ghost"
                disabled={!connected || finishedJobs.length === 0}
                onClick={() => void run(transcriptionClearFinished)}
              >
                {t('transcriptionClearFinished')}
              </Button>
            </div>
          </section>
        )}

        <section className="video-list" aria-live="polite">
          {jobs.length === 0 ? (
            <div className="empty-state">
              <strong>{t('transcriptionEmpty')}</strong>
              <span>{t('transcriptionEmptyBody')}</span>
            </div>
          ) : (
            visibleJobs.map(job => (
              <TranscriptionRow
                key={job.id}
                job={job}
                language={language}
                connected={connected}
                onStart={() => requestStart([job.id])}
                onCancel={() => void run(() => transcriptionCancel(job.id))}
                onRetry={() => void run(() => transcriptionRetry(job.id))}
                onRemove={() => void run(() => transcriptionRemove(job.id))}
                onReveal={() => void run(() => transcriptionReveal(job.id))}
                onView={trigger => setPreview({ jobId: job.id, trigger })}
                onCopy={copyTranscript}
                t={t}
              />
            ))
          )}
        </section>
        {jobs.length > 0 && (
          <div className="transcription-list-actions">
            <Button
              variant="secondary"
              loading={copyingAll}
              disabled={!connected || copyableJobs.length === 0}
              onClick={() => void copyAllTranscripts()}
            >
              {t('transcriptionCopyAllTranscripts')}
            </Button>
          </div>
        )}
      </main>
      <ToastRegion toasts={toasts} />
      {previewJob && (
        <TranscriptTextModal
          job={previewJob}
          language={language}
          returnFocus={preview?.trigger ?? null}
          translatorModel={translationBundle}
          onInstallTranslator={() => void run(transcriptionTranslatorDownload)}
          onCancelTranslator={() => void run(transcriptionTranslatorCancel)}
          onClose={() => setPreview(null)}
          t={t}
        />
      )}
      {confirmingDownload && (
        <ConfirmDownloadModal
          sizeLabel={formatSize(
            [model, translatorModel, alignmentModel].reduce(
              (sum, part) => sum + (part.present ? 0 : part.sizeBytes),
              0
            ),
            language
          )}
          canContinueWithoutTranslation={model.present}
          requiresGemmaConsent={!translatorModel.present}
          onConfirm={() => void confirmDownload()}
          onContinueWithoutTranslation={continueWithoutTranslation}
          onClose={cancelDownloadConfirmation}
          t={t}
        />
      )}
    </div>
  );
}

function ModelGate({
  model,
  parts,
  language,
  onDownload,
  onCancel,
  t
}: {
  model: TranscriptionModelInfo;
  parts: readonly TranscriptionModelInfo[];
  language: Language;
  onDownload: () => void;
  onCancel: () => void;
  t: Translate;
}) {
  const size = formatSize(model.sizeBytes, language);
  return (
    <section className="transcription-model-gate" aria-live="polite">
      <div className="transcription-model-gate-body">
        <strong>{t('transcriptionModelTitle')}</strong>
        {model.downloading ? (
          <>
            <span>
              {t('transcriptionModelDownloading', {
                progress: model.progress ?? 0,
                done: formatSize(model.downloadedBytes, language),
                total: size
              })}
            </span>
            <ProgressBar value={model.progress} active label={t('transcriptionModelTitle')} />
            <ul className="transcription-model-parts">
              {parts.map(part => (
                <li key={part.label}>
                  <span>{part.label}</span>
                  <span>
                    {part.present
                      ? t('transcriptionModelReady')
                      : part.downloading
                        ? `${part.progress ?? 0}%`
                        : part.error
                          ? t('statusFailed')
                          : t('statusQueued')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : model.error ? (
          <span className="transcription-model-error">
            {t('transcriptionModelError', { error: model.error })}
          </span>
        ) : (
          <span>{t('transcriptionModelBody', { size })}</span>
        )}
      </div>
      <div className="transcription-model-gate-actions">
        {model.downloading ? (
          <Button variant="ghost" onClick={onCancel}>
            {t('transcriptionModelCancelBtn')}
          </Button>
        ) : (
          <Button variant="primary" onClick={onDownload}>
            {model.error
              ? t('transcriptionModelRetry')
              : t('transcriptionModelDownloadBtn', { size })}
          </Button>
        )}
      </div>
    </section>
  );
}

function ConfirmDownloadModal({
  sizeLabel,
  canContinueWithoutTranslation,
  requiresGemmaConsent,
  onConfirm,
  onContinueWithoutTranslation,
  onClose,
  t
}: {
  sizeLabel: string;
  canContinueWithoutTranslation: boolean;
  requiresGemmaConsent: boolean;
  onConfirm: () => void;
  onContinueWithoutTranslation: () => void;
  onClose: () => void;
  t: Translate;
}) {
  const [accepted, setAccepted] = useState(!requiresGemmaConsent);
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      modalRef.current
        ?.querySelector<HTMLElement>('input, button:not([disabled]), a[href]')
        ?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !modalRef.current) return;
      const focusable = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          'input, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="lock-modal transcription-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 id={titleId}>{t('transcriptionConfirmTitle')}</h2>
        <p>{t('transcriptionConfirmBody', { size: sizeLabel })}</p>
        {requiresGemmaConsent && (
          <label className="transcription-gemma-consent">
            <input
              type="checkbox"
              checked={accepted}
              onChange={event => setAccepted(event.target.checked)}
            />
            <span>
              {t('transcriptionGemmaConsent')}{' '}
              <a href="https://ai.google.dev/gemma/terms" target="_blank" rel="noreferrer">
                {t('transcriptionGemmaTerms')}
              </a>{' '}
              {t('transcriptionGemmaAnd')}{' '}
              <a
                href="https://ai.google.dev/gemma/prohibited_use_policy"
                target="_blank"
                rel="noreferrer"
              >
                {t('transcriptionGemmaPolicy')}
              </a>
              .
            </span>
          </label>
        )}
        <div className="inline-actions">
          {canContinueWithoutTranslation ? (
            <Button variant="ghost" onClick={onContinueWithoutTranslation}>
              {t('transcriptionContinueWithoutTranslation')}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {t('transcriptionConfirmCancel')}
            </Button>
          )}
          <Button variant="primary" disabled={!accepted} onClick={onConfirm}>
            {t('transcriptionConfirmDownload')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function TranscriptionRow({
  job,
  language,
  connected,
  onStart,
  onCancel,
  onRetry,
  onRemove,
  onReveal,
  onView,
  onCopy,
  t
}: {
  job: TranscriptionJob;
  language: Language;
  connected: boolean;
  onStart: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onReveal: () => void;
  onView: (trigger: HTMLElement | null) => void;
  onCopy: (jobId: string) => Promise<boolean>;
  t: Translate;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), []);

  const detected = job.detectedLanguage
    ? languageDisplayName(job.detectedLanguage, language)
    : null;
  const active = job.status === 'processing' || job.status === 'queued';
  const done = job.status === 'completed';

  const copy = async () => {
    if (await onCopy(job.id)) {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <article className={`job-row ${job.status === 'processing' ? 'is-processing' : ''}`.trim()}>
      <div className="job-row-header">
        <span className="job-row-name" title={job.fileName}>
          {job.fileName}
        </span>
        <StatusBadge status={job.status} t={t} />
        <div className="job-row-actions">
          {done && (
            <>
              <Button
                variant="secondary"
                onClick={event => onView(event.currentTarget as HTMLElement)}
              >
                {t('transcriptionView')}
              </Button>
              <Button variant="ghost" onClick={() => void copy()}>
                {copied ? t('transcriptionCopied') : t('transcriptionCopy')}
              </Button>
              <Button variant="ghost" onClick={onReveal}>
                {t('transcriptionReveal')}
              </Button>
            </>
          )}
          {job.status === 'ready' && (
            <Button variant="primary" disabled={!connected} onClick={onStart}>
              {t('transcriptionStart')}
            </Button>
          )}
          {(job.status === 'processing' || job.status === 'queued') && (
            <Button variant="ghost" onClick={onCancel}>
              {t('transcriptionCancel')}
            </Button>
          )}
          {(job.status === 'failed' || job.status === 'cancelled') && (
            <Button variant="secondary" disabled={!connected} onClick={onRetry}>
              {t('transcriptionRetry')}
            </Button>
          )}
          {job.status !== 'processing' && (
            <Button variant="ghost" onClick={onRemove}>
              {t('transcriptionRemove')}
            </Button>
          )}
        </div>
      </div>

      {active && (
        <div className="job-progress">
          <ProgressBar
            value={job.progress}
            active={job.status === 'processing'}
            label={job.fileName}
          />
          <div className="job-progress-meta">
            {job.progress !== null ? `${Math.round(job.progress)}%` : t('statusProcessing')}
          </div>
        </div>
      )}

      {done && (detected || job.characters !== null) && (
        <div className="transcription-row-meta">
          {detected && <span>{t('transcriptionDetected', { language: detected })}</span>}
          {job.characters !== null && (
            <span>{t('transcriptionCharacters', { count: job.characters })}</span>
          )}
        </div>
      )}

      {job.status === 'failed' && job.error && (
        <div className="transcription-row-error" role="alert">
          {job.error}
        </div>
      )}
    </article>
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
