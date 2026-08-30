import { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import { PaintRoller, Play, Trash2 } from 'lucide-react';
import {
  COMPRESSION_LIFECYCLE,
  calculateQueueSummary,
  isSettled,
  type AgentSettingsPatch,
  type CompressionJob,
  type QueueState,
  type SelectionResponse,
  type SelectionWarning
} from '@video-compressor/shared';
import {
  agentKnown,
  agentLocalUrl,
  markAgentInstallStarted,
  request,
  requestBody,
  addLocalFiles,
  uploadImage as uploadImageAsset,
  uploadFile
} from './api/client';
import { type ConnectionState } from './connection';
import { formatSize } from './format';
import { fileCountKey, selectedCountKey, type Language, type TranslationKey, useI18n } from './i18n';
import { mergeSettingsPatches } from './settings-patch';
import { preferredDownload } from './release-manifest';
import {
  batchMetrics,
  compressBlock,
  newestJobsFirst,
  removableSelectedIds,
  selectableJobIds,
  startableSelectedIds,
  stoppable,
  toggleSelection,
  type CompressBlock
} from './queue-ui';
import { DropZone } from './components/DropZone';
import { JobRow } from './components/JobRow';
import { MediaActionsPanel } from './components/MediaActionsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { Button, ProgressBar, Spinner, type Translate, Checkbox } from './components/ui';
import { SotyLogo, SotyMark } from './components/SotyLogo';
import { PowerThrottle } from './components/PowerThrottle';
import { ThemeToggle } from './components/ThemeToggle';
import { useAgent } from './AgentContext';
import { internalLink, usePageEntrance } from './lib/navigation';
import { UserMenu } from './components/UserMenu';
import { SupportButton } from './components/SupportDialog';
import { analytics } from './analytics/service';
import {
  compressionErrorCategory,
  jobTransitionEventNames,
  safeBatchProperties,
  safeCompressionProperties
} from './analytics/compression';

const COMPRESSOR_SELECTION_KEY = 'wishly.compressor.selection.v1';

function storedCompressorSelection() {
  try {
    const value = JSON.parse(sessionStorage.getItem(COMPRESSOR_SELECTION_KEY) ?? '[]');
    return new Set<string>(
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    );
  } catch {
    return new Set<string>();
  }
}

interface ToastMessage {
  id: number;
  text: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
}

export default function CompressorPage() {
  const { language, t } = useI18n();
  const { state, setState, connection, connectedOnce, reconnect, capabilities } = useAgent();
  const entering = usePageEntrance();
  const [selected, setSelected] = useState<Set<string>>(storedCompressorSelection);
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  // The intake zone flashes green or red for a second after an import so the
  // result is visible where the action happened, not only in a toast.
  // Freshly imported rows glow honey for three seconds — easing in, holding,
  // fading out — so the eye finds them in a long list without hunting.
  const [freshJobs, setFreshJobs] = useState<ReadonlySet<string>>(new Set());
  const markFresh = (ids: string[]) => {
    if (!ids.length) return;
    setFreshJobs(new Set(ids));
    window.setTimeout(() => setFreshJobs(new Set()), 3000);
  };
  // The toolbar collapses its action labels the moment the row would overflow,
  // measured rather than guessed at a breakpoint: the same window is wide
  // enough in English and too narrow in Ukrainian.
  const toolbarRow = useRef<HTMLDivElement>(null);
  const stage = useRef({ actions: false, chips: false });
  const [compactActions, setCompactActions] = useState(false);
  const [compactChips, setCompactChips] = useState(false);
  useLayoutEffect(() => {
    const row = toolbarRow.current;
    if (!row) return;
    // Two stages: the action labels go first, and only if the row still cannot
    // fit do the status words shrink to bare numbers (their meaning stays in
    // the hover hint).
    const measure = () => {
      const slack = row.clientWidth - row.scrollWidth;
      if (slack < 0) {
        // One stage per frame, re-measured in between: the action labels go
        // first, and the status words only if the row still does not fit.
        if (!stage.current.actions) {
          stage.current.actions = true;
          setCompactActions(true);
          requestAnimationFrame(measure);
          return;
        }
        if (!stage.current.chips) {
          stage.current.chips = true;
          setCompactChips(true);
        }
        return;
      }
      // Expand again when the room returns, with enough margin that a pixel of
      // slack cannot flip the row back and forth.
      if (slack > 200 && stage.current.chips) {
        stage.current.chips = false;
        setCompactChips(false);
        requestAnimationFrame(measure);
        return;
      }
      if (slack > 420 && stage.current.actions) {
        stage.current.actions = false;
        setCompactActions(false);
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  });
  const [intake, setIntake] = useState<'ok' | 'fail' | null>(null);
  const [intakeMessage, setIntakeMessage] = useState<string | null>(null);
  // Both outcomes hold for two seconds — long enough to read the line where
  // the drop happened, short enough not to linger.
  const flashIntake = (outcome: 'ok' | 'fail', message?: string) => {
    setIntake(outcome);
    setIntakeMessage(outcome === 'fail' ? (message ?? null) : null);
    window.setTimeout(
      () =>
        setIntake(current => {
          if (current !== outcome) return current;
          setIntakeMessage(null);
          return null;
        }),
      2000
    );
  };
  const [help, setHelp] = useState(false);
  const [embeddingFormValid, setEmbeddingFormValid] = useState(true);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastId = useRef(0);
  /** True while a stop-all is between request and response. */
  const [stopInFlight, setStopInFlight] = useState(false);
  /** Live toast dismissal timers, so none of them outlives the page. */
  const toastTimers = useRef(new Set<number>());

  // Every dismissal timer dies with the page that scheduled it.
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSettings = useRef<AgentSettingsPatch>({});
  const previousJobs = useRef<Map<string, CompressionJob> | null>(null);
  const estimateStartedAt = useRef(new Map<string, number>());
  const connected = connection === 'connected';

  useEffect(() => {
    document.title = t('pageTitleCompressor');
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
    // D12. Tracked so unmount can clear it. An unmounted component's dismissal
    // timer still fires, and React then warns about a state update on a tree
    // that no longer exists — noise that trains people to ignore the console,
    // for a callback whose only remaining job is to remove something already
    // gone.
    const timer = window.setTimeout(() => {
      toastTimers.current.delete(timer);
      setToasts(current => current.filter(toast => toast.id !== id));
    }, 3600);
    toastTimers.current.add(timer);
  };

  useEffect(
    () => () => {
      if (settingsTimer.current) clearTimeout(settingsTimer.current);
    },
    []
  );

  useEffect(() => {
    if (connection !== 'connected') return;
    // Keyed on the jobs array itself, which reconciliation keeps stable while
    // nothing changes. The previous version built a joined string of every id
    // on every render — allocating a string proportional to the queue several
    // times a second, purely to decide whether to skip an effect.
    const existing = new Set(state.jobs.map(job => job.id));
    setSelected(current => {
      const kept = [...current].filter(id => existing.has(id));
      // Returning the same set when nothing was dropped keeps every consumer of
      // the selection from re-rendering too.
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [connection, state.jobs]);

  useEffect(() => {
    sessionStorage.setItem(COMPRESSOR_SELECTION_KEY, JSON.stringify([...selected]));
  }, [selected]);

  const handleError = (error: unknown) => {
    const text = localizedError(error, t);
    addToast(text, 'error');
    const code = error instanceof Error ? error.message : '';
    if (['CONNECTION_FAILED', 'TIMEOUT', 'PAIRING_REQUIRED'].includes(code)) {
      reconnect();
    }
  };

  const action = async (url: string, method = 'POST', body?: unknown) => {
    try {
      setState(
        body === undefined
          ? await request<QueueState>(url, method)
          : await requestBody<QueueState>(url, body)
      );
    } catch (error) {
      handleError(error);
    }
  };

  /**
   * Stopping a conversion started from the file manager.
   *
   * Its reply wraps the compressor state rather than being it, because "stop everything"
   * also answers how much it stopped. The state inside is the whole compressor state —
   * the conversions ride it (FR-009b) — so applying it is the same as any other action.
   */
  const mediaAction = async (url: string) => {
    try {
      const reply = await request<{ state: QueueState }>(url, 'POST');
      setState(reply.state);
    } catch (error) {
      handleError(error);
    }
  };

  /**
   * Stops the batch and says how much was stopped. The count comes from what
   * this window could see before the call, so a click that lands just after the
   * last file finished reports honestly instead of implying it did something.
   */
  const stopAll = async () => {
    // D8/FR-041. Guarded against a second press: stopping takes a moment, the
    // button stays under the cursor, and a double-click used to fire two
    // cancel-all requests and report the count twice.
    if (stopInFlight) return;
    const before = state.jobs.filter(stoppable).length;
    setStopInFlight(true);
    try {
      const next = await request<QueueState>('/api/queue/cancel-all', 'POST');
      setState(next);
      // Counted from what actually changed, not from what was stoppable when
      // the button was pressed: a job that finished in between was never
      // stopped, and saying it was is a small lie the user can see.
      const after = next.jobs.filter(stoppable).length;
      const stopped = Math.max(0, before - after);
      if (stopped) addToast(t('stoppedCount', { count: stopped }), 'neutral');
    } catch (error) {
      handleError(error);
    } finally {
      setStopInFlight(false);
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
      if (added.length) {
        markFresh(added.map(job => job.id));
        flashIntake('ok');
      }
    } catch (error) {
      flashIntake('fail', localizedError(error, t));
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
      const freshIds: string[] = [];
      for (const file of files) {
        const result = await uploadFile(file);
        setState(result.state);
        selectNewJobs(known, result.state, setSelected);
        const added = result.state.jobs.filter(job => !known.has(job.id));
        addedCount += added.length;
        addedBytes += added.reduce((total, job) => total + job.originalSize, 0);
        freshIds.push(...added.map(job => job.id));
        for (const job of result.state.jobs) known.add(job.id);
        showSelectionWarnings(result.warnings, t, addToast);
      }
      if (addedCount)
        analytics.track('videos_added', {
          video_count: addedCount,
          total_input_bytes: addedBytes
        });
      markFresh(freshIds);
      flashIntake(addedCount ? 'ok' : 'fail');
    } catch (error) {
      flashIntake('fail', localizedError(error, t));
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const addDroppedFilePaths = async (paths: string[]) => {
    if (!paths.length) return;
    setImporting(true);
    const known = new Set(state.jobs.map(job => job.id));
    try {
      const result = await addLocalFiles(paths);
      setState(result.state);
      selectNewJobs(known, result.state, setSelected);
      const added = result.state.jobs.filter(job => !known.has(job.id));
      if (added.length) {
        analytics.track('videos_added', {
          video_count: added.length,
          total_input_bytes: added.reduce((total, job) => total + job.originalSize, 0)
        });
      }
      showSelectionWarnings(result.warnings, t, addToast);
      markFresh(added.map(job => job.id));
      flashIntake(added.length ? 'ok' : 'fail');
    } catch (error) {
      flashIntake('fail', localizedError(error, t));
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const startSelected = async () => {
    const ids = startableSelectedIds(state.jobs, selected);
    if (
      !ids.length ||
      !embeddingFormValid ||
      (state.settings.imageEmbedding.enabled &&
        !state.settings.imageEmbedding.startImages.length &&
        !state.settings.imageEmbedding.endImages.length)
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
          state.jobs.filter(job => ids.includes(job.id)),
          next.batch?.id
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

  const setImages = async (slot: 'start' | 'end', files: File[]) => {
    for (const file of files) {
      try {
        setState(await uploadImageAsset(slot, file));
      } catch (error) {
        handleError(error);
        throw error;
      }
    }
  };

  const removeImage = async (slot: 'start' | 'end', id: string) => {
    try {
      setState(
        await request<QueueState>(`/api/images/${slot}/${encodeURIComponent(id)}`, 'DELETE')
      );
    } catch (error) {
      handleError(error);
      throw error;
    }
  };

  const removeSelected = async () => {
    const removable = removableSelectedIds(state.jobs, selected);
    if (!removable.length) return;
    const activeSelected = [...selected].some(id =>
      state.jobs.some(job => job.id === id && stoppable(job))
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

  const visibleJobs = useMemo(() => newestJobsFirst(state.jobs), [state.jobs]);
  const selectableIds = useMemo(() => selectableJobIds(visibleJobs), [visibleJobs]);
  // Derived from the job list and the selection, so they change when those do
  // and not when a progress tick arrives. Each of these walks every job; three
  // walks per render, several times a second, on a list with no upper bound.
  const selectedStartable = useMemo(
    () => startableSelectedIds(state.jobs, selected),
    [state.jobs, selected]
  );
  const selectedRemovable = useMemo(
    () => removableSelectedIds(state.jobs, selected),
    [state.jobs, selected]
  );
  const anythingStoppable = useMemo(() => state.jobs.some(stoppable), [state.jobs]);
  const metrics = useMemo(() => batchMetrics(state.jobs, state.batch), [state.jobs, state.batch]);
  const summary = useMemo(() => calculateQueueSummary(state.jobs), [state.jobs]);
  const blocked = compressBlock({
    running: state.running,
    embeddingEnabled: state.settings.imageEmbedding.enabled,
    embeddingHasImages: Boolean(
      state.settings.imageEmbedding.startImages.length ||
      state.settings.imageEmbedding.endImages.length
    ),
    embeddingFormValid,
    selectedCount: selected.size,
    startableCount: selectedStartable.length,
    // Counted from the same list the batch panel renders, so the button and
    // the numbers beside it can no longer tell different stories.
    activeCount: state.jobs.filter(job => job.status === 'queued' || job.status === 'processing')
      .length
  });

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

  return (
    <>
      <main className={`workspace${entering ? ' page-enter' : ''}`}>
        {!connected && (
          <BlockingMessage
            title={t('agentDisconnected')}
            body={t('restoreQueue')}
            action={
              <Button onClick={reconnect} loading={connection === 'connecting'}>
                {t('reconnect')}
              </Button>
            }
          />
        )}
        {connected && (!state.tools.ffmpeg || !state.tools.ffprobe) && (
          <BlockingMessage title={t('engineUnavailable')} tone="error" />
        )}
        {state.warning && (
          <BlockingMessage title={localizedAgentText(state.warning, t)} tone="warning" />
        )}

        <section className="add-files-section" aria-label={t('chooseFiles')}>
          <DropZone
            disabled={!connected || importing || !state.tools.ffprobe}
            importing={importing}
            outcome={intake}
            outcomeMessage={intakeMessage}
            chooseFiles={() => void selectNativeFiles()}
            addDroppedFiles={files => void addDroppedFiles(files)}
            addDroppedFilePaths={
              capabilities.includes('local-file-paths')
                ? paths => void addDroppedFilePaths(paths)
                : undefined
            }
            t={t}
          />
        </section>

        <SettingsPanel
          settings={state.settings}
          disabled={!connected}
          updateSettings={updateSettings}
          chooseOutputFolder={() => void action('/api/output/select')}
          uploadImages={setImages}
          removeImage={removeImage}
          onEmbeddingValidityChange={setEmbeddingFormValid}
          t={t}
        />

        {state.jobs.length > 0 && (
          <>
            <section
              className="batch-toolbar"
              aria-label={t('fileActions', { name: t('appName') })}
            >
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
                    setLastSelectedIndex(null);
                  }}
                >
                  {t('clearSelection')}
                </Button>
              </div>
              <div className="batch-chips" aria-hidden="true">
                <span className="batch-chip" title={t('chipFilesMany', { count: state.jobs.length })}>
                  <b>{state.jobs.length}</b>
                  <span className="chip-word">
                    {' '}
                    {t(fileCountKey(language, state.jobs.length), { count: state.jobs.length })
                      .replace(String(state.jobs.length), '')
                      .trim()}
                  </span>
                </span>
                {/* All four counters stay on screen — a zero is information too. */}
                <span
                  className="batch-chip is-processing"
                  title={t('chipProcessing', { count: metrics.processing })}
                >
                  <b>{metrics.processing}</b>
                  <span className="chip-word">
                    {' '}
                    {t('chipProcessing', { count: metrics.processing })
                      .replace(String(metrics.processing), '')
                      .trim()}
                  </span>
                </span>
                <span
                  className="batch-chip is-done"
                  title={t('chipCompleted', { count: metrics.completed })}
                >
                  <b>{metrics.completed}</b>
                  <span className="chip-word">
                    {' '}
                    {t('chipCompleted', { count: metrics.completed })
                      .replace(String(metrics.completed), '')
                      .trim()}
                  </span>
                </span>
                <span
                  className="batch-chip is-failed"
                  title={t('chipFailed', { count: metrics.failed })}
                >
                  <b>{metrics.failed}</b>
                  <span className="chip-word">
                    {' '}
                    {t('chipFailed', { count: metrics.failed })
                      .replace(String(metrics.failed), '')
                      .trim()}
                  </span>
                </span>
              </div>
              <div className="primary-actions">
                <Button
                  variant="primary"
                  disabled={!connected || blocked !== null}
                  title={t('compressSelected')}
                  onClick={() => void startSelected()}
                >
                  <Play size={18} strokeWidth={1.75} aria-hidden="true" />
                  <span className="action-label">
                    {`${t('compressSelected')}${selected.size ? ` (${selected.size})` : ''}`}
                  </span>
                </Button>
                {connected && blockedReasonKey(blocked) && (
                  <span className="compress-blocked-reason" role="status">
                    {t(blockedReasonKey(blocked)!)}
                  </span>
                )}
                {anythingStoppable && (
                  <Button
                    variant="danger"
                    disabled={!connected || stopInFlight}
                    title={t('stopAllHint')}
                    onClick={() => void stopAll()}
                  >
                    {t('stopAll')}
                  </Button>
                )}
                <Button
                  variant="danger"
                  disabled={!connected || selectedRemovable.length === 0}
                  title={t('removeSelected')}
                  onClick={() => void removeSelected()}
                >
                  <Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />
                  <span className="action-label">{t('removeSelected')}</span>
                </Button>
                {state.jobs.some(job => isSettled(COMPRESSION_LIFECYCLE, job.status)) && (
                  <Button
                    variant="ghost"
                    disabled={!connected}
                    title={t('clearFinished')}
                    onClick={() => void action('/api/jobs/completed', 'DELETE')}
                  >
                    <PaintRoller size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="action-label">{t('clearFinished')}</span>
                  </Button>
                )}
              </div>
              </div>
              {state.batch && <BatchProgress metrics={metrics} t={t} />}
            </section>
          </>
        )}

        {/* Not a live region.

            A list of jobs that updates several times a second announced its
            entire contents on every progress tick — a screen reader read the
            queue aloud, continuously, for as long as an encode ran, and the
            user could not interrupt it to do anything else. Progress belongs to
            each row's own progressbar, which announces a value when asked
            rather than shouting it. */}
        <section className="video-list">
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
                fresh={freshJobs.has(job.id)}
                disabled={!connected}
                connected={connected}
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

        <MediaActionsPanel
          mediaActions={state.mediaActions}
          disabled={!connected}
          onStop={id => void mediaAction(`/api/media-actions/${id}/cancel`)}
          onStopAll={() => void mediaAction('/api/media-actions/cancel-all')}
          t={t}
        />

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
    </>
  );
}

export function Header({
  language,
  setLanguage,
  connection,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  connection: ConnectionState;
  t: Translate;
}) {
  return (
    <header className="topbar">
      <div className="topbar-lead">
        <h1>
          <a
            className="brand-link"
            href="/"
            onClick={event => internalLink(event, '/')}
            aria-label={t('backToTools')}
          >
            <SotyLogo name={t('appName')} />
          </a>
        </h1>
        <SupportButton />
      </div>
      <div className="topbar-actions">
        <PowerThrottle />
        <ThemeToggle />
        {/* A group of two states where one is always chosen, which is what
            `radiogroup` describes. Previously it was an unlabelled pair of
            buttons: a screen reader announced "EN, button" with no indication
            that a language was already selected, or which one. The active state
            was carried by a class — visible, and invisible to anything that is
            not looking at pixels. */}
        <div className="language-switch" role="radiogroup" aria-label={t('language')}>
          <button
            type="button"
            role="radio"
            aria-checked={language === 'en'}
            className={language === 'en' ? 'is-active' : ''}
            onClick={() => setLanguage('en')}
          >
            EN
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={language === 'uk'}
            className={language === 'uk' ? 'is-active' : ''}
            onClick={() => setLanguage('uk')}
          >
            UA
          </button>
        </div>
        <ConnectionBadge state={connection} t={t} />
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
    entitlement_blocked: 'entitlementBlocked',
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
  const { releaseManifest } = useAgent();
  const downloadUrl = preferredDownload(releaseManifest.manifest).url;
  // A manual connect flips the connection to "connecting" for a moment. Rather
  // than swapping the whole panel for a spinner (which read as a flicker), we
  // keep the panel mounted and let the button animate the search in place.
  const busy = state === 'connecting';
  if (state === 'pairing_required') {
    return (
      <BlockingMessage
        title={t('pairingTitle')}
        body={t('pairingBody')}
        action={
          <Button variant="primary" onClick={connect} loading={busy}>
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
            <a className="button button-primary" href={agentLocalUrl()}>
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
  if (state === 'entitlement_blocked') {
    return (
      <BlockingMessage
        title={t('entitlementBlockedTitle')}
        body={t('entitlementBlockedBody')}
        action={
          <Button variant="primary" onClick={connect}>
            {t('tryAgain')}
          </Button>
        }
      />
    );
  }
  if (state === 'connection_blocked') {
    // The browser has refused this page permission to reach loopback, so
    // "try again" is the one action guaranteed not to work — it asks for the
    // same denied permission. Opening the copy the Agent serves itself sidesteps
    // the permission entirely, and it leads. Same tab: this is a way onward, not
    // a detour, and a new tab leaves a dead page behind for the user to tidy up.
    return (
      <BlockingMessage
        title={t('blockedTitle')}
        body={t('blockedBody')}
        action={
          <div className="inline-actions">
            <a className="button button-primary" href={agentLocalUrl()}>
              {t('openSoty')}
            </a>
            <Button onClick={connect}>{t('tryAgain')}</Button>
          </div>
        }
      />
    );
  }
  // Someone whose browser has already met the Agent is not looking at an
  // onboarding problem, and telling them to install it again reads as "it did
  // not work". Opening the Agent's own copy is the whole remaining step, and it
  // is the only one that works when the browser will not let this page look for
  // the Agent at all — which is precisely the case this page cannot detect.
  const known = agentKnown();
  return (
    <section className="onboarding-panel">
      <SotyMark size={40} />
      <h2>{t(known ? 'localAppOpenTitle' : 'onboardingTitle')}</h2>
      <p>{t(known ? 'localAppOpenBody' : 'onboardingBody')}</p>
      <div className="inline-actions">
        {known ? (
          <>
            <a className="button button-primary" href={agentLocalUrl()}>
              {t('openSoty')}
            </a>
            <Button onClick={connect} loading={busy}>
              {t('checkAgain')}
            </Button>
          </>
        ) : (
          <>
            <a
              className="button button-primary"
              href={downloadUrl}
              onClick={markAgentInstallStarted}
            >
              {t('downloadAgent')}
            </a>
            <Button onClick={connect} loading={busy}>
              {t('connectAgent')}
            </Button>
          </>
        )}
      </div>
      {known && (
        // The way out for the one person this screen guesses wrong about: the
        // flag is never cleared, so someone who has uninstalled Soty would
        // otherwise be offered nothing but a link to an app that is gone.
        <p className="onboarding-alternative">
          <a href={downloadUrl} onClick={markAgentInstallStarted}>
            {t('downloadAgentAgain')}
          </a>
        </p>
      )}
      <p className={`agent-search ${busy ? 'is-active' : ''}`.trim()} role="status">
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
            {(
              [
                'install1',
                'install2',
                'install3',
                'install4',
                'install5',
                'install6',
                'install7'
              ] as TranslationKey[]
            ).map(key => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function BlockingMessage({
  title,
  body,
  action,
  tone = 'neutral'
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  tone?: 'neutral' | 'warning' | 'error';
}) {
  return (
    <section className={`blocking-message blocking-${tone}`} role="alert">
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
    <div className="batch-progress" aria-label={t('batchProgress')}>
      <ProgressBar
        value={metrics.progress}
        label={t('overallProgress')}
        active={metrics.processing > 0}
      />
      <span className="batch-progress-value">{Math.round(metrics.progress)}%</span>
      <div className="batch-counts">
        <span>{t('queuedCount', { count: metrics.queued })}</span>
        <span>{t('processingCount', { count: metrics.processing })}</span>
        <span>{t('completedCount', { count: metrics.completed })}</span>
        <span>{t('failedCount', { count: metrics.failed })}</span>
      </div>
    </div>
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

/**
 * Text for a disabled compress button. "Nothing selected" is left out: the
 * selection counter next to the button already says exactly that.
 */
function blockedReasonKey(block: CompressBlock): TranslationKey | null {
  const reasons: Record<NonNullable<CompressBlock>, TranslationKey | null> = {
    running: 'compressBusy',
    stuck: 'compressStuck',
    'embedding-needs-image': 'embeddingNeedsImage',
    'invalid-image-duration': 'compressFixImageDuration',
    'nothing-startable': 'compressNothingReady',
    'nothing-selected': null
  };
  return block ? reasons[block] : null;
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
    IMAGE_IMPORT_FAILED: 'imageUploadFailed',
    // The stable codes the local app emits in place of relaying a raw message.
    // A relayed message routinely carried a full path and could not be
    // translated anyway, so it fell through to the generic text — meaning this
    // map is what finally makes these failures readable rather than merely
    // safe.
    UPLOAD_FAILED: 'errorUploadFailed',
    IMPORT_FAILED: 'errorImportFailed',
    FILE_TOO_LARGE: 'errorFileTooLarge',
    FILE_UNAVAILABLE: 'errorFileUnavailable',
    UNSUPPORTED_FORMAT: 'errorUnsupportedFormat',
    DISK_FULL: 'errorDiskFull',
    PERMISSION_DENIED: 'errorPermissionDenied',
    PATH_NOT_GRANTED: 'errorPathNotGranted',
    TOOL_UNAVAILABLE: 'errorToolUnavailable',
    OPERATION_FAILED: 'genericError'
  };
  return t(map[raw] ?? 'genericError');
}

/**
 * Renders a message the local app sent, by its code.
 *
 * It used to match the English wording with regular expressions, which meant
 * rewording a sentence in the agent silently untranslated it here — and neither
 * side could notice, because both kept working in English. The agent emits
 * codes now; anything unrecognised falls through unchanged, which keeps an
 * older agent's prose readable instead of blanking it.
 */
function localizedAgentText(raw: string, t: Translate) {
  const byCode: Record<string, TranslationKey> = {
    DISK_SPACE_LOW: 'diskWarning',
    DISK_SPACE_UNKNOWN: 'diskCheckFailed',
    MEDIA_TOOLS_UNAVAILABLE: 'engineUnavailable',
    MEDIA_TOOLS_UNAVAILABLE_JOB: 'engineUnavailable'
  };
  const key = byCode[raw];
  if (key) return t(key);
  // An agent from before this change still sends sentences. Matching them is
  // kept as a fallback and nothing new should be added to it.
  if (/free space may be insufficient/i.test(raw)) return t('diskWarning');
  if (/could not check free space/i.test(raw)) return t('diskCheckFailed');
  if (/media tools became unavailable/i.test(raw)) return t('engineUnavailable');
  return raw;
}
