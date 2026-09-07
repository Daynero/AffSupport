import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Ban,
  Broom,
  Check,
  Download,
  Files,
  Loader,
  Pause,
  Play,
  Trash2
} from 'lucide-react';
import type {
  TranscriptionDocument,
  TranscriptionJob,
  TranscriptionModelInfo,
  TranscriptionQualityMode,
  TranscriptionState
} from '@video-compressor/shared';
import {
  TRANSCRIPTION_LIFECYCLE,
  canTransition,
  defaultTranscriptionSettings,
  isSettled,
  isNewerSnapshot
} from '@video-compressor/shared';
import {
  request,
  transcriptionAddLocalFiles,
  transcriptionCancel,
  transcriptionCancelAll,
  transcriptionClearFinished,
  toolEventUrl,
  transcriptionModelCancel,
  transcriptionModelDownload,
  transcriptionPause,
  transcriptionTranslatorCancel,
  transcriptionTranslatorDownload,
  transcriptionRemove,
  transcriptionRemoveMany,
  transcriptionRetry,
  transcriptionReveal,
  transcriptionSelect,
  transcriptionSettings,
  transcriptionStart,
  transcriptionJobLanguage,
  transcriptionTranslate,
  transcriptionUpload,
  type TranscriptionSelectionResponse
} from '../api/client';
import { Onboarding } from '../App';
import { useAgent } from '../AgentContext';
import { useAgentEventStream } from '../api/useAgentEventStream';
import { DropZone } from '../components/DropZone';
import { Button, Checkbox, ProgressBar, Spinner } from '../components/ui';
import { useCompactToolbar } from '../components/useCompactToolbar';
import { toggleSelection } from '../queue-ui';
import { useI18n } from '../i18n';
import { describeError } from './errors';
import { usePageEntrance } from '../lib/navigation';
import { analytics } from '../analytics/service';
import { toolJobActivityEvents } from '../analytics/tools';
import { languageDisplayName } from './language';
import { TranscriptTextModal } from './TranscriptTextModal';
import {
  formatTranscriptionBatch,
  hasCopyContent,
  type TranscriptionCopyContent,
  type TranscriptionCopyEntry,
  type TranscriptionCopyScope
} from './copy';
import { TranscriptionCopyMenu } from './TranscriptionCopyMenu';
import { TranscriptionRow, type TranscriptionRowActions } from './TranscriptionRow';
import { TranscriptionSettingsPanel } from './TranscriptionSettingsPanel';
import { ConfirmDownloadModal, ModelGate, combineModelInfo } from './ModelGate';
import {
  forgetTranscriptDocuments,
  loadTranscriptDocument,
  loadTranscriptDocuments
} from './document-cache';
import {
  buildTranscriptExport,
  downloadTranscriptExport,
  hasTimings,
  type TranscriptExportContent,
  type TranscriptExportFormat
} from './export';

const EMPTY_MODEL: TranscriptionModelInfo = {
  present: false,
  downloading: false,
  progress: null,
  sizeBytes: 0,
  downloadedBytes: 0,
  label: '',
  error: null
};

/**
 * Which translation belongs on the clipboard when a file has more than one.
 *
 * The job carries the language the reader currently has selected, so that is the one to
 * copy. Taking whichever key happened to come first in the sidecar would hand over a
 * language nobody is looking at — and a different one from run to run.
 */
export function selectedTranslation(document: TranscriptionDocument, job: TranscriptionJob) {
  const completed = Object.values(document.translations).filter(
    translation => translation.status === 'completed'
  );
  const selected = job.translation?.targetLanguage;
  return (
    completed.find(translation => translation.targetLanguage === selected) ??
    [...completed].sort((left, right) =>
      left.targetLanguage.localeCompare(right.targetLanguage)
    )[0] ??
    null
  );
}

function copyEntry(
  document: TranscriptionDocument,
  job: TranscriptionJob,
  languageName: (code: string) => string
): TranscriptionCopyEntry {
  const completed = selectedTranslation(document, job);
  const translatedById = new Map(
    completed?.segments.map(segment => [segment.sourceSegmentId, segment.translatedText]) ?? []
  );
  const translated = document.segments
    .map(segment => translatedById.get(segment.id) ?? '')
    .filter(Boolean)
    .join('\n');
  return {
    fileName: job.fileName,
    transcript: document.segments.map(segment => segment.sourceText).join('\n'),
    translation:
      completed && translated
        ? { languageName: languageName(completed.targetLanguage), text: translated }
        : null
  };
}

export { describeError };

interface ToastMessage {
  id: number;
  text: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
}

export default function TranscriptionPage() {
  const { language, t } = useI18n();
  const { connection, connectedOnce, reconnect, capabilities } = useAgent();
  const multiplexed = capabilities.includes('event-stream');
  const entering = usePageEntrance();
  const [state, setStateRaw] = useState<TranscriptionState | null>(null);
  /**
   * The one place this page's snapshot is written.
   *
   * Same rule as the queue context: a request in flight when an event fires resolves
   * second and would otherwise overwrite a newer snapshot with an older one.
   */
  const applyState = useCallback((next: TranscriptionState | null) => {
    if (!next) return;
    setStateRaw(current => {
      // A restarted agent counts from zero again. Its snapshots carry the new process's
      // identity, and the first one from a different process is accepted whatever its
      // number says — comparing numbers alone froze the page on the previous run's last
      // state until a reload.
      const accepted = isNewerSnapshot(next, current, {
        sameInstance: !current?.instance || !next.instance || current.instance === next.instance
      });
      if (!accepted) return current;
      // A job that did not change keeps its object. The agent builds fresh objects for every
      // job on every frame, which made every memoised row re-render on every progress tick
      // of one file; identity is what the memo compares, so identity is kept.
      return current ? { ...next, jobs: reuseUnchangedJobs(current.jobs, next.jobs) } : next;
    });
  }, []);
  const [help, setHelp] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<{ jobId: string; trigger: HTMLElement | null } | null>(
    null
  );
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastSelectedIndex = useRef<number | null>(null);
  /** What the confirmation is for: a run that needs models, or the translator on its own. */
  const [confirmingDownload, setConfirmingDownload] = useState<false | 'run' | 'translator'>(false);
  const [copyingAll, setCopyingAll] = useState(false);
  const [copyScope, setCopyScope] = useState<TranscriptionCopyScope>('finished');
  const [copyContent, setCopyContent] = useState<TranscriptionCopyContent>('both');
  const toastId = useRef(0);
  const toastTimers = useRef(new Set<number>());
  const { ref: toolbarRow, compactActions, compactChips } = useCompactToolbar();
  // The toolbar pins itself under the intake zone by the zone's real height, not a guess.
  const intakeRef = useRef<HTMLElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const zone = intakeRef.current;
    const workspace = workspaceRef.current;
    if (!zone || !workspace) return;
    const apply = () => workspace.style.setProperty('--intake-h', `${zone.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(apply);
    observer.observe(zone);
    return () => observer.disconnect();
  }, [connection, connectedOnce]);

  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  // What the user asked to transcribe before the model was present; started automatically
  // once the download completes, on the quality it was asked for.
  const pendingStart = useRef<{ ids: string[]; quality?: TranscriptionQualityMode } | null>(null);
  const previousAnalyticsJobs = useRef<TranscriptionJob[] | null>(null);
  const connected = connection === 'connected';
  const stateReady = state !== null;
  const canUseLocalPaths = capabilities.includes('local-file-paths');

  useEffect(() => {
    document.title = t('pageTitleTranscription');
    analytics.track('tool_opened', { tool_identifier: 'transcription' });
  }, []);

  useEffect(() => {
    if (connection !== 'connected') return;
    let active = true;
    request<TranscriptionState>('/api/transcription/state', 'GET')
      .then(value => {
        if (active) applyState(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connection]);

  useAgentEventStream<{ state: TranscriptionState }>({
    url: connection === 'connected' ? toolEventUrl('transcription') : null,
    channel: 'transcription',
    multiplexed,
    enabled: connection === 'connected',
    onMessage: update => applyState(update.state)
  });

  const addToast = useCallback((text: string, tone: ToastMessage['tone'] = 'neutral') => {
    const id = ++toastId.current;
    setToasts(current => [...current, { id, text, tone }]);
    const timer = window.setTimeout(() => {
      toastTimers.current.delete(timer);
      setToasts(current => current.filter(toast => toast.id !== id));
    }, 3600);
    toastTimers.current.add(timer);
  }, []);

  const handleError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      if (['CONNECTION_FAILED', 'TIMEOUT', 'PAIRING_REQUIRED'].includes(message)) reconnect();
      addToast(describeError(error, t), 'error');
    },
    [addToast, reconnect, t]
  );

  const applySelection = (response: TranscriptionSelectionResponse) => {
    applyState(response.state);
    for (const warning of response.warnings) {
      addToast(`${warning.fileName}: ${warning.message}`, 'warning');
    }
  };

  const jobs = state?.jobs ?? EMPTY_JOBS;
  useEffect(() => {
    for (const event of toolJobActivityEvents(
      'transcription',
      previousAnalyticsJobs.current,
      jobs,
      {
        started: ['queued', 'processing'],
        completed: ['completed'],
        failed: ['failed', 'interrupted'],
        cancelled: ['cancelled']
      }
    )) {
      analytics.track(event.name, event.properties);
    }
    previousAnalyticsJobs.current = jobs;
  }, [jobs]);
  const visibleJobs = useMemo(() => [...jobs].sort((a, b) => b.createdAt - a.createdAt), [jobs]);
  const settings = state?.settings ?? {
    ...defaultTranscriptionSettings(),
    translationLanguage: language
  };
  const tools = state?.tools ?? { ffmpeg: false, whisper: false, model: false };
  const model: TranscriptionModelInfo = state?.model ?? EMPTY_MODEL;
  const translatorModel: TranscriptionModelInfo = state?.translatorModel ?? EMPTY_MODEL;
  const alignmentModel: TranscriptionModelInfo = state?.alignmentModel ?? EMPTY_MODEL;
  const translationBundle = useMemo(
    () => combineModelInfo(t('transcriptionTranslationModels'), [translatorModel, alignmentModel]),
    [translatorModel, alignmentModel, t]
  );
  const binaryReady = tools.ffmpeg && tools.whisper;
  const modelReady = tools.model;

  const counts = useMemo(() => {
    let processing = 0;
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      if (job.status === 'processing' || job.status === 'queued') processing += 1;
      else if (job.status === 'completed') completed += 1;
      else if (job.status === 'failed' || job.status === 'interrupted') failed += 1;
    }
    return { processing, completed, failed };
  }, [jobs]);
  const startable = (job: TranscriptionJob) =>
    canTransition(TRANSCRIPTION_LIFECYCLE, job.status, 'queued');
  const { readyJobs, finishedJobs } = useMemo(
    () => ({
      readyJobs: jobs.filter(job => job.status === 'ready' || job.status === 'cancelled'),
      finishedJobs: jobs.filter(job => isSettled(TRANSCRIPTION_LIFECYCLE, job.status))
    }),
    [jobs]
  );
  const selectableIds = useMemo(
    () => visibleJobs.filter(job => job.status !== 'analyzing').map(job => job.id),
    [visibleJobs]
  );
  const { startableSelected, removableSelected } = useMemo(
    () => ({
      startableSelected: jobs
        .filter(job => selected.has(job.id) && startable(job))
        .map(job => job.id),
      removableSelected: jobs
        .filter(job => selected.has(job.id) && job.status !== 'processing')
        .map(job => job.id)
    }),
    [jobs, selected]
  );
  const runningJob = jobs.find(job => job.status === 'processing') ?? null;
  const stoppable = jobs.some(job => job.status === 'processing' || job.status === 'queued');
  const copyableJobs = visibleJobs.filter(
    job => job.status === 'completed' && (job.characters ?? 0) > 0
  );
  const selectedCopyableJobs = copyableJobs.filter(job => selected.has(job.id));
  const copyJobs = copyScope === 'selected' ? selectedCopyableJobs : copyableJobs;
  const previewJob = preview ? jobs.find(job => job.id === preview.jobId) : null;
  const batchProgress = useMemo(() => {
    const running = jobs.filter(job => job.status === 'processing' || job.status === 'queued');
    if (!running.length) return null;
    // Weighted by duration when it is known: a ten-minute file and a ten-second one are not
    // the same share of the wait.
    let total = 0;
    let done = 0;
    for (const job of running) {
      const weight = job.durationSeconds ?? 60;
      total += weight;
      done += (weight * (job.status === 'processing' ? (job.progress ?? 0) : 0)) / 100;
    }
    return total > 0 ? Math.min(99, Math.round((done / total) * 100)) : null;
  }, [jobs]);

  const jobIdsKey = jobs.map(job => job.id).join('|');
  useEffect(() => {
    if (!stateReady) return;
    const existing = new Set(jobs.map(job => job.id));
    setSelected(current => {
      const next = new Set([...current].filter(id => existing.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [jobIdsKey, stateReady]);

  const updateSettings = useCallback(
    async (patch: Parameters<typeof transcriptionSettings>[0]) => {
      try {
        applyState(await transcriptionSettings(patch));
      } catch (error) {
        handleError(error);
      }
    },
    [applyState, handleError]
  );
  const updateLanguage = useCallback(
    (value: string) => void updateSettings({ language: value }),
    [updateSettings]
  );
  const updateQuality = useCallback(
    (value: TranscriptionQualityMode) => void updateSettings({ quality: value }),
    [updateSettings]
  );

  // The interface language is the default translation target. Keep that small preference in
  // the local agent so translation starts even before the viewer is opened.
  useEffect(() => {
    if (!connected || !stateReady || settings.translationLanguage === language) return;
    let active = true;
    transcriptionSettings({ translationLanguage: language })
      .then(next => {
        if (active) applyState(next);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connected, language, settings.translationLanguage, stateReady]);

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
      for (const file of files) applySelection(await transcriptionUpload(file));
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

  const run = useCallback(
    async (action: () => Promise<TranscriptionState>) => {
      try {
        applyState(await action());
      } catch (error) {
        handleError(error);
      }
    },
    [applyState, handleError]
  );
  const startNow = useCallback(
    (ids: string[], quality?: TranscriptionQualityMode) =>
      run(() => (quality ? transcriptionStart(ids, quality) : transcriptionStart(ids))),
    [run]
  );
  /** Runs what was waiting on a download, if anything was. */
  const startPending = () => {
    const pending = pendingStart.current;
    pendingStart.current = null;
    if (pending) void startNow(pending.ids, pending.quality);
  };

  /**
   * Starts, or asks first.
   *
   * The speech model is a hard requirement; the translation bundle is not. Someone who has
   * chosen to go without translation is not asked again — the agent remembers the choice —
   * and someone whose speech model is present but whose translation is downloading in the
   * background simply starts. A quality named here is for these files only; when its model
   * is missing the setting is switched to it so the gate above the queue fetches the right
   * one, and the files start on it the moment it lands.
   */
  const requestStart = (ids: string[], quality?: TranscriptionQualityMode) => {
    if (!ids.length) return;
    const speechModel = quality ? (state?.models?.[quality] ?? model) : model;
    const askAboutTranslation =
      !translationBundle.present && !translationBundle.downloading && !settings.translationDeclined;
    if (!speechModel.present || askAboutTranslation) {
      if (quality && quality !== settings.quality && !speechModel.present) {
        void updateSettings({ quality });
      }
      pendingStart.current = { ids, quality };
      setConfirmingDownload('run');
      return;
    }
    void startNow(ids, quality);
  };

  /** From a row that says the translator is missing: the consent, then the download. */
  const installTranslator = useCallback(() => {
    pendingStart.current = null;
    setConfirmingDownload('translator');
  }, []);

  const confirmDownload = async (includeTranslation: boolean) => {
    const purpose = confirmingDownload;
    setConfirmingDownload(false);
    if (purpose === 'translator') {
      await updateSettings({ translationDeclined: false });
      await run(transcriptionTranslatorDownload);
      return;
    }
    try {
      applyState(
        await transcriptionModelDownload({
          quality: pendingStart.current?.quality,
          speechOnly: !includeTranslation
        })
      );
      const pendingQuality = pendingStart.current?.quality;
      const speechModel = pendingQuality ? (state?.models?.[pendingQuality] ?? model) : model;
      if (speechModel.present) startPending();
    } catch (error) {
      handleError(error);
    }
  };
  const continueWithoutTranslation = async () => {
    setConfirmingDownload(false);
    await updateSettings({ translationDeclined: true });
    const pendingQuality = pendingStart.current?.quality;
    const speechModel = pendingQuality ? (state?.models?.[pendingQuality] ?? model) : model;
    if (!speechModel.present) {
      // The speech model is still needed; fetch only that and start when it lands.
      await run(() => transcriptionModelDownload({ quality: pendingQuality, speechOnly: true }));
      return;
    }
    startPending();
  };
  const cancelDownloadConfirmation = () => {
    pendingStart.current = null;
    setConfirmingDownload(false);
  };

  // Auto-start whatever the user queued for download once its model arrives.
  const pendingModelPresent = pendingStart.current
    ? (state?.models?.[pendingStart.current.quality ?? settings.quality]?.present ?? model.present)
    : false;
  // Not while the dialog is still asking: with the speech model already on disk the flag
  // is true from the first render, and the files started behind an open question.
  useEffect(() => {
    if (pendingModelPresent && confirmingDownload === false) startPending();
  }, [pendingModelPresent, confirmingDownload]);

  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const jobById = useCallback((id: string) => jobsRef.current.find(job => job.id === id), []);

  const copyTranscript = useCallback(
    async (jobId: string) => {
      const job = jobById(jobId);
      if (!job) return false;
      try {
        const document = await loadTranscriptDocument(job);
        await navigator.clipboard.writeText(
          document.segments.map(segment => segment.sourceText).join('\n')
        );
        return true;
      } catch {
        addToast(t('transcriptionCopyFailed'), 'error');
        return false;
      }
    },
    [jobById, addToast, t]
  );

  const exportTranscript = useCallback(
    async (jobId: string, format: TranscriptExportFormat, content: TranscriptExportContent) => {
      const job = jobById(jobId);
      if (!job) return;
      try {
        const document = await loadTranscriptDocument(job);
        const translation = selectedTranslation(document, job);
        if (format !== 'txt' && !hasTimings(document.segments)) {
          addToast(t('transcriptionExportNoTimings'), 'warning');
          return;
        }
        if (content !== 'transcript' && !translation) {
          addToast(t('transcriptionExportNoTranslation'), 'warning');
          return;
        }
        downloadTranscriptExport(
          buildTranscriptExport({
            fileName: job.fileName,
            segments: document.segments,
            translation,
            content,
            format
          })
        );
      } catch {
        addToast(t('transcriptionExportFailed'), 'error');
      }
    },
    [jobById, addToast, t]
  );

  const translateJob = useCallback(
    async (jobId: string, targetLanguage: string) => {
      try {
        await transcriptionTranslate(jobId, targetLanguage);
      } catch (error) {
        handleError(error);
        throw error;
      }
    },
    [handleError]
  );

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectableRef = useRef(selectableIds);
  selectableRef.current = selectableIds;
  const requestStartRef = useRef(requestStart);
  requestStartRef.current = requestStart;

  /** One stable object, so every row can be memoised against the job it shows. */
  const rowActions = useMemo<TranscriptionRowActions>(
    () => ({
      select: (id, index, checked, shiftKey) => {
        const update = toggleSelection(
          selectedRef.current,
          id,
          checked,
          selectableRef.current,
          lastSelectedIndex.current,
          shiftKey
        );
        setSelected(update.selected);
        lastSelectedIndex.current = update.lastIndex ?? index;
      },
      start: id => requestStartRef.current([id]),
      startWith: (id, quality) => requestStartRef.current([id], quality),
      cancel: id => void run(() => transcriptionCancel(id)),
      pause: (id, paused) => void run(() => transcriptionPause(id, paused)),
      retry: id => void run(() => transcriptionRetry(id)),
      remove: id => void run(() => transcriptionRemove(id)),
      reveal: id => void run(() => transcriptionReveal(id)),
      setLanguage: (id, code) => void run(() => transcriptionJobLanguage(id, code)),
      installTranslator,
      view: (id, trigger) => setPreview({ jobId: id, trigger }),
      copy: copyTranscript,
      translate: translateJob,
      export: (id, format, content) => void exportTranscript(id, format, content)
    }),
    [run, copyTranscript, translateJob, exportTranscript, installTranslator]
  );

  const stopAll = async () => {
    const stopping = jobs.filter(
      job => job.status === 'processing' || job.status === 'queued'
    ).length;
    try {
      applyState(await transcriptionCancelAll());
      if (stopping) addToast(t('stoppedCount', { count: stopping }), 'neutral');
    } catch (error) {
      handleError(error);
    }
  };
  const removeSelected = async () => {
    if (!removableSelected.length) return;
    await run(() => transcriptionRemoveMany(removableSelected));
    setSelected(new Set());
  };
  const clearFinished = async () => {
    await run(transcriptionClearFinished);
    forgetTranscriptDocuments();
  };

  const copyBatch = async () => {
    if (!copyJobs.length || copyingAll) return;
    setCopyingAll(true);
    try {
      const documents = await loadTranscriptDocuments(copyJobs);
      const entries = documents.map((document, index) =>
        copyEntry(document, copyJobs[index], code => languageDisplayName(code, language))
      );
      const included = entries.filter(entry => hasCopyContent(entry, copyContent));
      if (!included.length) {
        addToast(t('transcriptionCopyEmpty'), 'warning');
        return;
      }
      await navigator.clipboard.writeText(
        formatTranscriptionBatch(entries, copyContent, {
          heading: number => t('transcriptionBatchHeading', { number }),
          transcript: t('transcriptionCopyTranscriptLabel'),
          translation: t('transcriptionCopyTranslationLabel')
        })
      );
      addToast(
        t('transcriptionCopiedTranscripts', { count: included.length, total: entries.length }),
        'success'
      );
    } catch {
      addToast(t('transcriptionCopyFailed'), 'error');
    } finally {
      setCopyingAll(false);
    }
  };

  // The viewer is memoised on its props; handlers that were fresh arrows re-rendered it —
  // and its thousand segments — on every progress frame of some other file.
  const installTranslatorFromViewer = useCallback(() => {
    void updateSettings({ translationDeclined: false });
    void run(transcriptionTranslatorDownload);
  }, [updateSettings, run]);
  const cancelTranslatorFromViewer = useCallback(
    () => void run(transcriptionTranslatorCancel),
    [run]
  );
  const previewJobId = preview?.jobId ?? null;
  const exportFromViewer = useCallback(
    (format: TranscriptExportFormat, content: TranscriptExportContent) => {
      if (previewJobId) void exportTranscript(previewJobId, format, content);
    },
    [previewJobId, exportTranscript]
  );
  const closeViewer = useCallback(() => setPreview(null), []);

  if (connection === 'checking') {
    return (
      <main className={`workspace compact-state${entering ? ' page-enter' : ''}`}>
        <Spinner />
        <span>{t('connectingAgent')}</span>
      </main>
    );
  }

  if (!connected && !connectedOnce) {
    return (
      <>
        <main className={`workspace${entering ? ' page-enter' : ''}`}>
          <Onboarding state={connection} help={help} setHelp={setHelp} connect={reconnect} t={t} />
        </main>
        <ToastRegion toasts={toasts} />
      </>
    );
  }

  const translatorMissing =
    !translationBundle.present &&
    !translationBundle.downloading &&
    jobs.some(job => job.translation?.status === 'unavailable');

  return (
    <>
      <main
        ref={workspaceRef}
        className={`workspace transcription-workspace${entering ? ' page-enter' : ''}`}
      >
        {connected && state && !binaryReady && (
          <section className="blocking-message blocking-error" role="alert">
            <div>
              <strong>{t('transcriptionEngineUnavailable')}</strong>
              <span>{t('transcriptionEngineUnavailableBody')}</span>
            </div>
          </section>
        )}

        <section
          ref={intakeRef}
          className="add-files-section"
          aria-label={t('transcriptionDropTitle')}
        >
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
        </section>

        {connected && binaryReady && !modelReady && (
          <ModelGate
            model={model}
            parts={[model, translatorModel, alignmentModel]}
            language={language}
            onDownload={() => setConfirmingDownload('run')}
            onCancel={() => void run(transcriptionModelCancel)}
            t={t}
          />
        )}

        <TranscriptionSettingsPanel
          settings={settings}
          language={language}
          disabled={!connected || !binaryReady}
          // An empty queue is the moment to choose; with files on the page the files come
          // first and the settings fold to their summary line.
          defaultOpen={jobs.length === 0}
          onLanguage={updateLanguage}
          onQuality={updateQuality}
          t={t}
        />

        {jobs.length > 0 && (
          <section className="batch-toolbar" aria-label={t('transcriptionQueueTitle')}>
            <div
              className={`batch-toolbar-row ${compactActions ? 'is-compact' : ''} ${
                compactChips ? 'is-compact-chips' : ''
              }`.trim()}
              ref={toolbarRow}
            >
              <div className="selection-actions">
                <Checkbox
                  className="select-all-box"
                  checked={selectableIds.length > 0 && selected.size === selectableIds.length}
                  disabled={!connected || selectableIds.length === 0}
                  onChange={event =>
                    setSelected(event.target.checked ? new Set(selectableIds) : new Set())
                  }
                  label={<strong>{t('selectAll')}</strong>}
                />
                <Button
                  variant="ghost"
                  disabled={!connected || selected.size === 0}
                  onClick={() => {
                    setSelected(new Set());
                    lastSelectedIndex.current = null;
                  }}
                >
                  {t('clearSelection')}
                </Button>
              </div>
              {/* Not a live region: a summary re-read on every job transition talked over
                  the row that had just changed. Each chip carries its own words. */}
              <div className="batch-chips">
                <Chip
                  count={jobs.length}
                  phrase={t('transcriptionFilesCount', { count: jobs.length })}
                  icon={<Files size={12} strokeWidth={2} aria-hidden="true" />}
                />
                {/* A zero says nothing worth the room; the total is always shown. */}
                {counts.processing > 0 && (
                  <Chip
                    className="is-processing"
                    count={counts.processing}
                    phrase={t('chipProcessing', { count: counts.processing })}
                    icon={<Loader size={12} strokeWidth={2} aria-hidden="true" />}
                  />
                )}
                {counts.completed > 0 && (
                  <Chip
                    className="is-done"
                    count={counts.completed}
                    phrase={t('chipCompleted', { count: counts.completed })}
                    icon={<Check size={12} strokeWidth={2.2} aria-hidden="true" />}
                  />
                )}
                {counts.failed > 0 && (
                  <Chip
                    className="is-failed"
                    count={counts.failed}
                    phrase={t('chipFailed', { count: counts.failed })}
                    icon={<AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />}
                  />
                )}
              </div>
              <div className="primary-actions">
                {runningJob ? (
                  <Button
                    variant="primary"
                    className="is-primary-action"
                    disabled={!connected}
                    title={t(runningJob.paused ? 'jobResume' : 'jobPause')}
                    aria-label={t(runningJob.paused ? 'jobResume' : 'jobPause')}
                    onClick={() => rowActions.pause(runningJob.id, !runningJob.paused)}
                  >
                    {runningJob.paused ? (
                      <Play size={18} strokeWidth={1.75} aria-hidden="true" />
                    ) : (
                      <Pause size={18} strokeWidth={1.75} aria-hidden="true" />
                    )}
                    <span className="action-label">
                      {t(runningJob.paused ? 'jobResume' : 'jobPause')}
                    </span>
                  </Button>
                ) : (selected.size ? startableSelected : readyJobs).length === 0 ? null : (
                  /* Shown only when there is something it can start: a greyed primary in the
                     most prominent slot for a whole session read as a broken button. A
                     finished file is re-run from its own row. */
                  <Button
                    className="is-primary-action"
                    variant="primary"
                    disabled={!connected || !binaryReady || model.downloading}
                    title={
                      selected.size ? t('transcriptionStartSelected') : t('transcriptionStartAll')
                    }
                    // The words fold away when the toolbar is narrow; the name must not — and
                    // it is the visible label, count included, so the two never disagree.
                    aria-label={
                      selected.size
                        ? `${t('transcriptionStartSelected')} (${startableSelected.length})`
                        : t('transcriptionStartAll')
                    }
                    onClick={() =>
                      requestStart(selected.size ? startableSelected : readyJobs.map(job => job.id))
                    }
                  >
                    <Play size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="action-label">
                      {selected.size
                        ? `${t('transcriptionStartSelected')} (${startableSelected.length})`
                        : t('transcriptionStartAll')}
                    </span>
                  </Button>
                )}
                {stoppable && (
                  <Button
                    variant="danger"
                    disabled={!connected}
                    title={t('stopAllHint')}
                    aria-label={t('stopAll')}
                    onClick={() => void stopAll()}
                  >
                    <Ban size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="action-label">{t('stopAll')}</span>
                  </Button>
                )}
                <TranscriptionCopyMenu
                  scope={copyScope}
                  content={copyContent}
                  finishedCount={copyableJobs.length}
                  selectedCount={selectedCopyableJobs.length}
                  busy={copyingAll}
                  disabled={!connected || copyJobs.length === 0}
                  onScopeChange={setCopyScope}
                  onContentChange={setCopyContent}
                  onCopy={() => void copyBatch()}
                  t={t}
                />
                {selected.size > 0 && (
                  <Button
                    variant="danger"
                    disabled={!connected || removableSelected.length === 0}
                    title={t('removeSelected')}
                    aria-label={t('removeSelected')}
                    onClick={() => void removeSelected()}
                  >
                    <Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="action-label">{t('removeSelected')}</span>
                  </Button>
                )}
                {finishedJobs.length > 0 && (
                  <Button
                    variant="ghost"
                    disabled={!connected}
                    title={t('transcriptionClearFinished')}
                    aria-label={t('transcriptionClearFinished')}
                    onClick={() => void clearFinished()}
                  >
                    <Broom size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="action-label">{t('transcriptionClearFinished')}</span>
                  </Button>
                )}
              </div>
            </div>
            {batchProgress !== null && (
              <div className="batch-progress-heading transcription-batch-progress">
                <ProgressBar
                  value={batchProgress}
                  active={connected && !runningJob?.paused}
                  label={t('transcriptionQueueTitle')}
                />
                <span>{batchProgress}%</span>
              </div>
            )}
          </section>
        )}

        {translatorMissing && (
          <div className="transcription-translator-banner">
            <span>
              {t('transcriptionTranslatorBanner', {
                language: languageDisplayName(settings.translationLanguage, language)
              })}
            </span>
            <Button variant="secondary" disabled={!connected} onClick={installTranslator}>
              <Download size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionInstallTranslator')}
            </Button>
          </div>
        )}

        {/* Not a live region — see the compressor queue. A list that announces itself on
            every progress tick is a screen reader that cannot be interrupted. */}
        <section className="video-list transcription-list">
          {jobs.length === 0 ? (
            <div className="empty-state">
              <strong>{t('transcriptionEmpty')}</strong>
              <span>{t('transcriptionEmptyBody')}</span>
            </div>
          ) : (
            visibleJobs.map((job, index) => (
              <TranscriptionRow
                key={job.id}
                job={job}
                index={index}
                language={language}
                connected={connected}
                selected={selected.has(job.id)}
                actions={rowActions}
                t={t}
              />
            ))
          )}
        </section>
        <p className="transcription-processed-locally">{t('transcriptionProcessedLocally')}</p>
        <p className="visually-hidden" role="status" aria-live="polite">
          {runningJob ? (runningJob.paused ? t('jobPaused') : t('transcriptionProcessing')) : ''}
        </p>
      </main>
      <ToastRegion toasts={toasts} />
      {previewJob && (
        <TranscriptTextModal
          job={previewJob}
          language={language}
          returnFocus={preview?.trigger ?? null}
          translatorModel={translationBundle}
          onInstallTranslator={installTranslatorFromViewer}
          onCancelTranslator={cancelTranslatorFromViewer}
          onExport={exportFromViewer}
          onToast={addToast}
          onClose={closeViewer}
          t={t}
        />
      )}
      {confirmingDownload && (
        <ConfirmDownloadModal
          speechModel={confirmingDownload === 'translator' ? PRESENT_MODEL : model}
          translationBundle={translationBundle}
          language={language}
          willStart={pendingStart.current !== null}
          translatorOnly={confirmingDownload === 'translator'}
          onConfirm={includeTranslation => void confirmDownload(includeTranslation)}
          onContinueWithoutTranslation={() => void continueWithoutTranslation()}
          onClose={cancelDownloadConfirmation}
          t={t}
        />
      )}
    </>
  );
}

const EMPTY_JOBS: TranscriptionJob[] = [];

/** Fields of a job that change; `translation` is compared one level deeper. */
function sameJob(previous: TranscriptionJob, next: TranscriptionJob): boolean {
  const keys = Object.keys(next) as (keyof TranscriptionJob)[];
  if (keys.length !== Object.keys(previous).length) return false;
  for (const key of keys) {
    if (key === 'translation') continue;
    if (previous[key] !== next[key]) return false;
  }
  const a = previous.translation;
  const b = next.translation;
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.targetLanguage === b.targetLanguage &&
    a.status === b.status &&
    a.progress === b.progress &&
    a.completedSegments === b.completedSegments &&
    a.totalSegments === b.totalSegments &&
    a.startedAt === b.startedAt &&
    a.error === b.error
  );
}

function reuseUnchangedJobs(
  previous: readonly TranscriptionJob[],
  next: readonly TranscriptionJob[]
): TranscriptionJob[] {
  const byId = new Map(previous.map(job => [job.id, job]));
  let changed = previous.length !== next.length;
  const merged = next.map((job, index) => {
    const known = byId.get(job.id);
    if (known && sameJob(known, job)) {
      if (previous[index] !== known) changed = true;
      return known;
    }
    changed = true;
    return job;
  });
  return changed ? merged : (previous as TranscriptionJob[]);
}
/** Stands in for the speech model when the confirmation is about the translator alone. */
const PRESENT_MODEL: TranscriptionModelInfo = { ...EMPTY_MODEL, present: true, progress: 100 };

function Chip({
  count,
  phrase,
  icon,
  className = ''
}: {
  count: number;
  phrase: string;
  /** What stands in for the word when the toolbar folds the words away. */
  icon: ReactNode;
  className?: string;
}) {
  // The phrases all lead with the number; the word is what follows it.
  const word = phrase.replace(new RegExp(`^\\s*${count}\\s*`, 'u'), '');
  return (
    <span className={`batch-chip ${className}`.trim()} title={phrase}>
      <span className="chip-icon">{icon}</span>
      <b>{count}</b>
      <span className="chip-word"> {word}</span>
      {/* Read out even when the visible word has folded away. */}
      <span className="sr-only"> {word}</span>
    </span>
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
