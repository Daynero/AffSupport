import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Ban,
  Broom,
  ChevronDown,
  Files,
  FolderOpen,
  Crown,
  Play,
  Settings as SettingsIcon,
  Sparkles
} from 'lucide-react';
import {
  LANDING_JOB_LIFECYCLE,
  canTransition,
  isSettled,
  type LandingEvent,
  type LandingJobStatus,
  type LandingSettings,
  isNewerSnapshot,
  defaultLandingSettings,
  DEFAULT_CRF,
  LANDING_HIGH_QUALITY_CRF,
  LANDING_IMAGE_QUALITY as IMAGE_QUALITY,
  type LandingState
} from '@video-compressor/shared';

/**
 * Can this landing be stopped right now?
 *
 * Asked of the same table the agent enforces, so the button the interface offers and the
 * request the agent accepts cannot disagree.
 */
function landingStoppable(status: LandingJobStatus): boolean {
  return canTransition(LANDING_JOB_LIFECYCLE, status, 'cancelled');
}
import {
  toolEventUrl,
  landingFolderBegin,
  landingFolderFile,
  landingFolderFinish,
  request,
  requestBody,
  uploadLandingZip
} from '../api/client';
import { Onboarding } from '../App';
import { useAgent } from '../AgentContext';
import { useAgentEventStream } from '../api/useAgentEventStream';
import { DropZone } from '../components/DropZone';
import {
  Button,
  Checkbox,
  SegmentedControl,
  Spinner,
  Tooltip,
  type Translate
} from '../components/ui';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { useCompactToolbar } from '../components/useCompactToolbar';
import { compactPath } from '../format';
import { useI18n } from '../i18n';
import { usePageEntrance } from '../lib/navigation';
import { analytics } from '../analytics/service';
import { LandingJobCard } from './LandingJobCard';

interface ToastMessage {
  id: number;
  text: string;
  tone: 'neutral' | 'success' | 'warning' | 'error';
}

interface UploadFile {
  file: File;
  relPath: string;
}

export default function LandingOptimizerPage() {
  const { language, t } = useI18n();
  const { capabilities, connection, connectedOnce, reconnect } = useAgent();
  const multiplexed = capabilities.includes('event-stream');
  const entering = usePageEntrance();
  const [state, setStateRaw] = useState<LandingState | null>(null);

  /**
   * The one place this page's snapshot is written.
   *
   * Same rule as the queue context, for the same reason: a request in flight
   * when an event fires resolves second and would overwrite a newer snapshot
   * with an older one. Every writer below goes through here, so "newer wins" is
   * a property of the page rather than something each call site remembers.
   */
  const applyState = useCallback((next: LandingState | null) => {
    if (!next) return;
    setStateRaw(current => (isNewerSnapshot(next, current) ? next : current));
  }, []);
  const [help, setHelp] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastId = useRef(0);
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
  const connected = connection === 'connected';

  useEffect(() => {
    document.title = t('pageTitleLanding');
    analytics.track('tool_opened', { tool_identifier: 'landing-optimizer' });
  }, []);

  useEffect(() => {
    if (connection !== 'connected') return;
    let active = true;
    request<LandingState>('/api/landing/state', 'GET')
      .then(value => {
        if (active) applyState(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connection]);

  // Through the shared hook rather than a socket of this page's own. Three pages each
  // opening their own `EventSource` is three of the seven connections the multiplexed
  // stream exists to replace — and three more places deciding for themselves whether the
  // local app is reachable.
  useAgentEventStream<LandingEvent>({
    url: connection === 'connected' ? toolEventUrl('landing') : null,
    channel: 'landing',
    multiplexed,
    enabled: connection === 'connected',
    onMessage: update => applyState(update.state)
  });

  const addToast = (text: string, tone: ToastMessage['tone'] = 'neutral') => {
    const id = ++toastId.current;
    setToasts(current => [...current, { id, text, tone }]);
    // D12. Tracked so unmount can clear it: a dismissal timer that fires after
    // the page is gone updates state on a tree that no longer exists.
    const timer = window.setTimeout(() => {
      toastTimers.current.delete(timer);
      setToasts(current => current.filter(toast => toast.id !== id));
    }, 3600);
    toastTimers.current.add(timer);
  };

  const handleError = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    if (['CONNECTION_FAILED', 'TIMEOUT', 'PAIRING_REQUIRED'].includes(message)) reconnect();
    addToast(message && message.length < 120 ? message : t('landingResultFailedTitle'), 'error');
  };

  const { ref: toolbarRow, compactActions, compactChips } = useCompactToolbar();
  const jobs = state?.jobs ?? (state?.job ? [state.job] : []);
  const visibleJobs = useMemo(() => [...jobs].sort((a, b) => b.createdAt - a.createdAt), [jobs]);
  const counts = useMemo(
    () => ({
      processing: jobs.filter(job => job.status === 'processing').length,
      completed: jobs.filter(job => job.status === 'completed').length,
      failed: jobs.filter(job => job.status === 'failed').length
    }),
    [jobs]
  );
  // Before the first snapshot arrives, the same defaults the agent would have sent.
  const settings = state?.settings ?? defaultLandingSettings();
  const readyJobs = jobs.filter(job => job.status === 'ready');
  const finishedJobs = jobs.filter(job => isSettled(LANDING_JOB_LIFECYCLE, job.status));
  const stoppable = jobs.some(job => landingStoppable(job.status));

  const updateSettings = async (patch: Partial<LandingSettings>) => {
    try {
      applyState(await requestBody<LandingState>('/api/landing/settings', patch));
    } catch (error) {
      handleError(error);
    }
  };

  /* The system dialog, then whatever it returned. A cancelled dialog changes nothing — the
     agent leaves the mode alone rather than switching to a folder nobody chose. */
  const chooseOutputFolder = async () => {
    try {
      applyState(await request<LandingState>('/api/landing/output/select', 'POST'));
    } catch (error) {
      handleError(error);
    }
  };

  const onDropData = async (data: DataTransfer) => {
    if (importing) return;
    const payloads = await collectDropped(data);
    if (!payloads.length) {
      addToast(t('landingUnsupportedDrop'), 'warning');
      return;
    }
    await importLandings(payloads);
  };

  const importLandings = async (payloads: DroppedPayload[]) => {
    setImporting(true);
    let loaded = 0;
    try {
      for (const payload of payloads) {
        try {
          if (payload.kind === 'zip') {
            applyState(await uploadLandingZip(payload.file));
            loaded += 1;
          } else if (payload.files.length) {
            await landingFolderBegin(payload.name);
            for (const item of payload.files) {
              await landingFolderFile(item.relPath, item.file);
            }
            applyState(await landingFolderFinish());
            loaded += 1;
          }
        } catch (error) {
          handleError(error);
        }
      }
    } finally {
      setImporting(false);
    }
    if (loaded > 0) {
      analytics.track('landing_loaded', { tool_identifier: 'landing-optimizer' });
    }
  };

  const pick = async (endpoint: string) => {
    if (importing) return;
    setImporting(true);
    try {
      applyState(await request<LandingState>(endpoint, 'POST'));
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const start = async (jobId: string) => {
    try {
      applyState(
        await request<LandingState>(`/api/landing/jobs/${encodeURIComponent(jobId)}/start`, 'POST')
      );
      analytics.track('landing_optimization_started', { tool_identifier: 'landing-optimizer' });
    } catch (error) {
      handleError(error);
    }
  };

  const startAll = async () => {
    try {
      applyState(
        await requestBody<LandingState>('/api/landing/start', {
          ids: readyJobs.map(job => job.id)
        })
      );
      analytics.track('landing_optimization_started', {
        tool_identifier: 'landing-optimizer',
        file_count: readyJobs.length
      });
    } catch (error) {
      handleError(error);
    }
  };

  /*
   * Stopping one landing, not removing it.
   *
   * `remove` refuses while a landing is running — a job in flight has a workspace and a child
   * process behind it, and dropping the row would leave both. The agent has had a per-job
   * cancel for exactly this since stopping one of four became possible; nothing in the
   * interface had ever called it.
   */
  const stop = async (jobId: string) => {
    try {
      applyState(
        await request<LandingState>(
          `/api/landing/jobs/${encodeURIComponent(jobId)}/cancel`,
          'POST'
        )
      );
    } catch (error) {
      handleError(error);
    }
  };

  const remove = async (jobId: string) => {
    try {
      applyState(
        await request<LandingState>(`/api/landing/jobs/${encodeURIComponent(jobId)}`, 'DELETE')
      );
    } catch (error) {
      handleError(error);
    }
  };

  /**
   * Stops every landing this tool shows and says how many. The count comes from
   * what this window could see before the call, so a click that lands just
   * after the last one finished reports honestly.
   */
  const stopAll = async () => {
    const stopping = jobs.filter(job => landingStoppable(job.status)).length;
    try {
      applyState(await request<LandingState>('/api/landing/cancel-all', 'POST'));
      if (stopping) addToast(t('stoppedCount', { count: stopping }));
    } catch (error) {
      handleError(error);
    }
  };

  const clearFinished = async () => {
    try {
      applyState(await request<LandingState>('/api/landing/completed', 'DELETE'));
    } catch (error) {
      handleError(error);
    }
  };

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
        {connected && state && (!state.tools.ffmpeg || !state.tools.ffprobe) && (
          <section className="blocking-message blocking-error" role="alert">
            <div>
              <strong>{t('engineUnavailable')}</strong>
            </div>
          </section>
        )}

        {/* The drop zone first and the settings under it, as in the compressor: the thing you
            came to do, then the way it will be done. Nothing sits under the zone — the two
            pickers are the zone's own, because a landing arrives as either an archive or a
            folder and no system dialog offers both at once. */}
        <section className="add-files-section" aria-label={t('landingDropTitle')}>
          <DropZone
            disabled={!connected || importing || !state?.tools.ffmpeg}
            importing={importing}
            chooseFiles={() => void pick('/api/landing/select/zip')}
            addDroppedFiles={() => {}}
            onDropData={data => void onDropData(data)}
            title={t('landingDropTitle')}
            activeLabel={t('landingDropActive')}
            formats={t('landingDropFormats')}
            importingLabel={t('landingImporting')}
            secondaryAction={{
              label: t('landingChooseFolder'),
              run: () => void pick('/api/landing/select/folder'),
              disabled: !connected || importing
            }}
            t={t}
          />
        </section>

        <LandingSettingsPanel
          settings={settings}
          disabled={!connected || importing}
          update={updateSettings}
          chooseOutputFolder={() => void chooseOutputFolder()}
          t={t}
        />

        {jobs.length > 0 && (
          /* The compressor's toolbar, because it is the same toolbar: counters on the left,
             actions on the right, and when the row runs out of room the actions drop their
             words and keep their icons — the measurement is the shared one, so the two tools
             cannot disagree about when a window is too narrow. */
          <section className="batch-toolbar" aria-label={t('landingQueueTitle')}>
            <div
              className={`batch-toolbar-row ${compactActions ? 'is-compact' : ''} ${
                compactChips ? 'is-compact-chips' : ''
              }`.trim()}
              ref={toolbarRow}
            >
              <div className="batch-chips" aria-hidden="true">
                <LandingChip
                  count={jobs.length}
                  phrase={t('landingQueueCount', { count: jobs.length })}
                />
                {/* All four stay on screen — a zero is information too. */}
                <LandingChip
                  className="is-processing"
                  count={counts.processing}
                  phrase={t('chipProcessing', { count: counts.processing })}
                />
                <LandingChip
                  className="is-done"
                  count={counts.completed}
                  phrase={t('chipCompleted', { count: counts.completed })}
                />
                <LandingChip
                  className="is-failed"
                  count={counts.failed}
                  phrase={t('chipFailed', { count: counts.failed })}
                />
              </div>
              <div className="primary-actions">
                <Button
                  variant="primary"
                  disabled={!connected || readyJobs.length === 0}
                  title={t('landingOptimizeAll')}
                  onClick={() => void startAll()}
                >
                  <Play size={18} strokeWidth={1.75} aria-hidden="true" />
                  <span className="action-label">{t('landingOptimizeAll')}</span>
                </Button>
                {stoppable && (
                  <Button
                    variant="danger"
                    disabled={!connected}
                    title={t('stopAllHint')}
                    onClick={() => void stopAll()}
                  >
                    <Ban size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="action-label">{t('stopAll')}</span>
                  </Button>
                )}
                {finishedJobs.length > 0 && (
                  <Button
                    variant="ghost"
                    disabled={!connected}
                    title={t('landingClearFinished')}
                    onClick={() => void clearFinished()}
                  >
                    <Broom size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="action-label">{t('landingClearFinished')}</span>
                  </Button>
                )}
              </div>
            </div>
          </section>
        )}

        {jobs.length > 0 ? (
          <section
            className="landing-jobs-list"
            // Not a live region — same reason as the compressor queue: a list
            // that changes on a timer is not an announcement, it is a wall of
            // speech a screen reader user cannot interrupt.
          >
            {visibleJobs.map(job => (
              <LandingJobCard
                key={job.id}
                job={job}
                connected={connected}
                running={job.status === 'processing'}
                language={language}
                onStart={() => void start(job.id)}
                onReset={() => void remove(job.id)}
                onStop={() => void stop(job.id)}
                onReveal={action =>
                  void request(
                    `/api/landing/jobs/${encodeURIComponent(job.id)}/output/${action}`,
                    'POST'
                  ).catch(handleError)
                }
                onPause={paused =>
                  void requestBody<LandingState>(
                    `/api/landing/jobs/${encodeURIComponent(job.id)}/pause`,
                    { paused }
                  )
                    .then(applyState)
                    .catch(handleError)
                }
                t={t}
              />
            ))}
          </section>
        ) : (
          <section className="video-list">
            <div className="empty-state">
              <strong>{t('landingEmpty')}</strong>
              <span>{t('landingEmptyBody')}</span>
            </div>
          </section>
        )}
      </main>
      <ToastRegion toasts={toasts} />
    </>
  );
}

const LANDING_SETTINGS_OPEN_KEY = 'wishly.landing.settings-open.v1';

export function LandingSettingsPanel({
  settings,
  disabled,
  update,
  chooseOutputFolder,
  t
}: {
  settings: LandingSettings;
  disabled: boolean;
  update: (patch: Partial<LandingSettings>) => void;
  /** Opens the system dialog; the agent stores whatever comes back. */
  chooseOutputFolder: () => void;
  t: Translate;
}) {
  // Folds to its title line, and remembers: the compressor's panel does both, and re-opening
  // this one after every reload is the kind of small chore that makes a tool feel forgetful.
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(LANDING_SETTINGS_OPEN_KEY) !== 'closed';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(LANDING_SETTINGS_OPEN_KEY, open ? 'open' : 'closed');
    } catch {
      // Private windows and blocked site data: the panel simply opens by default.
    }
  }, [open]);

  const mediaName = (on: boolean, quality: 'optimal' | 'high') =>
    !on ? t('landingMediaOff') : quality === 'high' ? t('highQuality') : t('optimal');

  /* The number behind the word, as the compressor prints "Optimal · 30 FPS · CRF 26 · 720p".
     "Optimal" on its own says which of two buttons is pressed and nothing about what it does;
     the dial is the whole answer, and it is the first thing anyone asks. */
  const imageDial = { optimal: `WebP ${IMAGE_QUALITY.optimal}`, high: `WebP ${IMAGE_QUALITY.high}` };
  const videoDial = { optimal: `CRF ${DEFAULT_CRF}`, high: `CRF ${LANDING_HIGH_QUALITY_CRF}` };

  return (
    <section
      className={`settings-panel landing-settings-panel ${open ? '' : 'is-collapsed'}`.trim()}
      aria-labelledby="landing-settings-title"
    >
      {/* The whole header is the toggle: gear and title on the left, what will actually run in
          the middle, chevron in the corner — the compressor's own header, because this is the
          same panel doing the same job. */}
      <button
        type="button"
        className="settings-collapse section-heading compact-heading"
        aria-expanded={open}
        aria-controls="landing-settings-body"
        onClick={() => setOpen(current => !current)}
      >
        <SettingsIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <h2 id="landing-settings-title">{t('landingQualityTitle')}</h2>
        <span className="settings-summary">
          <span>
            <span className="settings-summary-key">{t('landingSettingsSummaryImages')}</span>
            {mediaName(settings.optimizeImages, settings.imageQuality)}
          </span>
          <span>
            <span className="settings-summary-key">{t('landingSettingsSummaryVideos')}</span>
            {mediaName(settings.optimizeVideos, settings.videoQuality)}
          </span>
          <span>
            {settings.outputMode === 'next-to-originals'
              ? t('nextToOriginals')
              : t('chooseFolder')}
          </span>
          {/* Each of these is worth a word only when it is on. */}
          {settings.archive && <span>{t('landingArchive')}</span>}
          {settings.renameMedia && <span>{t('landingRenameMedia')}</span>}
        </span>
        <ChevronDown
          size={ICON_SIZE}
          strokeWidth={ICON_STROKE}
          className={`settings-chevron ${open ? '' : 'is-rotated'}`.trim()}
          aria-hidden="true"
        />
      </button>

      <div id="landing-settings-body" className="settings-body" hidden={!open}>
        <div className="settings-primary-row landing-settings-primary-row">
          {/*
            Off, optimal, high — one row of pictos per kind of media rather than a switch
            beside a choice. The two questions a person has about images are "are you touching
            them?" and "how hard?", and answering both in one row is the shape the compressor
            gives its own mode, down to the grey line that spells the answer out underneath.

            The same three glyphs in both rows, deliberately: a sparkle means optimal here for
            the same reason it means optimal in the compressor, and an icon that changed its
            meaning between two adjacent controls would be worse than no icon at all.
          */}
          <LandingMediaField
            label={t('landingImageQuality')}
            value={settings.optimizeImages ? settings.imageQuality : 'off'}
            disabled={disabled}
            offHint={t('landingImagesOffHint')}
            optimalHint={t('landingImageOptimalHint')}
            highHint={t('landingImageHighHint')}
            dial={imageDial}
            onChange={choice =>
              update(
                choice === 'off'
                  ? { optimizeImages: false }
                  : { optimizeImages: true, imageQuality: choice }
              )
            }
            t={t}
          />
          <LandingMediaField
            label={t('landingVideoQuality')}
            value={settings.optimizeVideos ? settings.videoQuality : 'off'}
            disabled={disabled}
            offHint={t('landingVideosOffHint')}
            optimalHint={t('landingVideoOptimalHint')}
            highHint={t('landingVideoHighHint')}
            dial={videoDial}
            onChange={choice =>
              update(
                choice === 'off'
                  ? { optimizeVideos: false }
                  : { optimizeVideos: true, videoQuality: choice }
              )
            }
            t={t}
          />

          {/* The compressor's own destination control, in the compressor's own markup: a
              landing used to go beside its original or into Downloads depending on how it had
              arrived, and nothing said which. */}
          <div className="field-group landing-settings-field">
            <LandingFieldLabel label={t('saveResults')} tooltip={t('saveTooltip')} />
            <div className="fit-mode-pictos" role="radiogroup" aria-label={t('saveResults')}>
              <button
                type="button"
                role="radio"
                className={settings.outputMode === 'next-to-originals' ? 'is-selected' : ''}
                data-tip={t('nextToOriginals')}
                aria-label={t('nextToOriginals')}
                aria-checked={settings.outputMode === 'next-to-originals'}
                disabled={disabled}
                onClick={() => update({ outputMode: 'next-to-originals' })}
              >
                <Files size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="radio"
                className={settings.outputMode === 'chosen-folder' ? 'is-selected' : ''}
                data-tip={t('chooseFolder')}
                aria-label={t('chooseFolder')}
                aria-checked={settings.outputMode === 'chosen-folder'}
                disabled={disabled}
                onClick={chooseOutputFolder}
              >
                <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
            </div>
            <span className="optimal-summary output-mode-summary">
              {settings.outputMode === 'next-to-originals'
                ? t('nextToOriginals')
                : t('chooseFolder')}
            </span>
            {settings.outputMode === 'chosen-folder' && (
              <span
                className="selected-folder"
                data-tip={settings.outputFolder ?? t('noFolderSelected')}
              >
                {settings.outputFolder
                  ? compactPath(settings.outputFolder)
                  : t('noFolderSelected')}
              </span>
            )}
          </div>

          {/* Three yes-or-no answers about the landing as a whole. Each is its own line with
              its own tooltip and nothing above it — the same weight the compressor gives
              "Remove metadata", because that is exactly what they are. */}
          <div className="field-group landing-switch-column">
            <LandingSwitch
              label={t('landingArchive')}
              hint={t('landingArchiveHint')}
              checked={settings.archive}
              disabled={disabled}
              onChange={archive => update({ archive })}
            />
            <LandingSwitch
              label={t('stripMetadata')}
              hint={t('landingStripMetadataHint')}
              checked={settings.stripMetadata}
              disabled={disabled}
              onChange={stripMetadata => update({ stripMetadata })}
            />
            <LandingSwitch
              label={t('landingRenameMedia')}
              hint={t('landingRenameMediaHint')}
              checked={settings.renameMedia}
              disabled={disabled}
              onChange={renameMedia => update({ renameMedia })}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * One counter in the toolbar: the figure, then the word.
 *
 * The word comes out of the translated phrase with the number removed, so "3 landings" and
 * "3 лендінгів" both give the same two pieces without a second string to keep in step. It is
 * the word that disappears first when the row runs out of room.
 */
function LandingChip({
  count,
  phrase,
  className = ''
}: {
  count: number;
  phrase: string;
  className?: string;
}) {
  return (
    <span className={`batch-chip ${className}`.trim()} title={phrase}>
      <b>{count}</b>
      <span className="chip-word"> {phrase.replace(String(count), '').trim()}</span>
    </span>
  );
}

/** A switch, its name and its question mark on one line — the compressor's metadata control. */
function LandingSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="metadata-control">
      <Checkbox
        className="feature-switch"
        checked={checked}
        disabled={disabled}
        label={<strong>{label}</strong>}
        onChange={event => onChange(event.target.checked)}
      />
      <Tooltip label={hint}>{hint}</Tooltip>
    </div>
  );
}

/** Off, optimal or high for one kind of media — the compressor's picto row, three wide. */
function LandingMediaField({
  label,
  value,
  disabled,
  offHint,
  optimalHint,
  highHint,
  dial,
  onChange,
  t
}: {
  label: string;
  value: 'off' | 'optimal' | 'high';
  disabled: boolean;
  offHint: string;
  optimalHint: string;
  highHint: string;
  /** The figure each mode actually asks the encoder for, printed beside its name. */
  dial: { optimal: string; high: string };
  onChange: (value: 'off' | 'optimal' | 'high') => void;
  t: Translate;
}) {
  const hint = value === 'off' ? offHint : value === 'high' ? highHint : optimalHint;
  const name =
    value === 'off'
      ? t('landingMediaOff')
      : value === 'high'
        ? `${t('highQuality')} · ${dial.high}`
        : `${t('optimal')} · ${dial.optimal}`;
  return (
    <div className="field-group landing-settings-field">
      <LandingFieldLabel label={label} tooltip={hint} />
      <div className="fit-mode-pictos" role="radiogroup" aria-label={label}>
        <button
          type="button"
          role="radio"
          className={value === 'off' ? 'is-selected' : ''}
          data-tip={offHint}
          aria-label={`${label}: ${t('landingMediaOff')}`}
          aria-checked={value === 'off'}
          disabled={disabled}
          onClick={() => onChange('off')}
        >
          <Ban size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
        <button
          type="button"
          role="radio"
          className={value === 'optimal' ? 'is-selected' : ''}
          data-tip={optimalHint}
          aria-label={`${label}: ${t('optimal')}`}
          aria-checked={value === 'optimal'}
          disabled={disabled}
          onClick={() => onChange('optimal')}
        >
          <Sparkles size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
        <button
          type="button"
          role="radio"
          className={value === 'high' ? 'is-selected' : ''}
          data-tip={highHint}
          aria-label={`${label}: ${t('highQuality')}`}
          aria-checked={value === 'high'}
          disabled={disabled}
          onClick={() => onChange('high')}
        >
          <Crown size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        </button>
      </div>
      {/* Three pictos say nothing on their own, so the answer is spelled out under them. */}
      <span className="optimal-summary">{name}</span>
    </div>
  );
}

function LandingFieldLabel({ label, tooltip }: { label: string; tooltip: string }) {
  return (
    <div className="field-label">
      <span>{label}</span>
      <Tooltip label={tooltip}>{tooltip}</Tooltip>
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

/* ---------------------------- drop handling ---------------------------- */

export type DroppedPayload =
  { kind: 'zip'; file: File } | { kind: 'folder'; name: string; files: UploadFile[] };

export async function collectDroppedLandings(data: DataTransfer): Promise<DroppedPayload[]> {
  const items = data.items ? Array.from(data.items) : [];
  const entries = items
    .map(item => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  if (entries.length) {
    const payloads: DroppedPayload[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        const directory = entry as FileSystemDirectoryEntry;
        const files: UploadFile[] = [];
        await readDirectory(directory, directory.name, files);
        if (files.length) payloads.push({ kind: 'folder', name: directory.name, files });
      } else if (entry.isFile && /\.zip$/i.test(entry.name)) {
        const file = await entryFile(entry as FileSystemFileEntry);
        if (file) payloads.push({ kind: 'zip', file });
      }
    }
    return payloads;
  }
  return Array.from(data.files ?? [])
    .filter(file => /\.zip$/i.test(file.name))
    .map(file => ({ kind: 'zip' as const, file }));
}

const collectDropped = collectDroppedLandings;

async function readDirectory(
  directory: FileSystemDirectoryEntry,
  base: string,
  out: UploadFile[]
): Promise<void> {
  const reader = directory.createReader();
  const entries = await readAllEntries(reader);
  for (const entry of entries) {
    const relPath = `${base}/${entry.name}`;
    if (entry.isFile) {
      const file = await entryFile(entry as FileSystemFileEntry);
      if (file) out.push({ file, relPath });
    } else if (entry.isDirectory) {
      await readDirectory(entry as FileSystemDirectoryEntry, relPath, out);
    }
  }
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const step = () => {
      reader.readEntries(batch => {
        if (!batch.length) {
          resolve(all);
          return;
        }
        all.push(...batch);
        step();
      }, reject);
    };
    step();
  });
}

function entryFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise(resolve => entry.file(resolve, () => resolve(null)));
}
