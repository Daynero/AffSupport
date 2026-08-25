import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LANDING_JOB_LIFECYCLE,
  canTransition,
  isSettled,
  type LandingEvent,
  type LandingJobStatus,
  type LandingSettings,
  isNewerSnapshot,
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

  const jobs = state?.jobs ?? (state?.job ? [state.job] : []);
  const visibleJobs = useMemo(() => [...jobs].sort((a, b) => b.createdAt - a.createdAt), [jobs]);
  const settings = state?.settings ?? {
    imageQuality: 'optimal',
    videoQuality: 'optimal',
    archive: false
  };
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

        <LandingSettingsPanel
          settings={settings}
          disabled={!connected || importing}
          update={updateSettings}
          t={t}
        />

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
            t={t}
          />
          <div className="inline-actions landing-pick-actions">
            <Button
              variant="ghost"
              disabled={!connected || importing}
              onClick={() => void pick('/api/landing/select/zip')}
            >
              {t('landingChooseZip')}
            </Button>
            <Button
              variant="ghost"
              disabled={!connected || importing}
              onClick={() => void pick('/api/landing/select/folder')}
            >
              {t('landingChooseFolder')}
            </Button>
          </div>
          <p>{t('landingProcessedLocally')}</p>
        </section>

        {jobs.length > 0 && (
          <section className="landing-queue-toolbar" aria-label={t('landingQueueTitle')}>
            <div>
              <strong>{t('landingQueueTitle')}</strong>
              <span>{t('landingQueueCount', { count: jobs.length })}</span>
            </div>
            <div>
              <Button
                variant="primary"
                disabled={!connected || readyJobs.length === 0}
                onClick={() => void startAll()}
              >
                {t('landingOptimizeAll')}
              </Button>
              {stoppable && (
                <Button
                  variant="danger"
                  disabled={!connected}
                  title={t('stopAllHint')}
                  onClick={() => void stopAll()}
                >
                  {t('stopAll')}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={!connected || finishedJobs.length === 0}
                onClick={() => void clearFinished()}
              >
                {t('landingClearFinished')}
              </Button>
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
                onReveal={action =>
                  void request(
                    `/api/landing/jobs/${encodeURIComponent(job.id)}/output/${action}`,
                    'POST'
                  ).catch(handleError)
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

export function LandingSettingsPanel({
  settings,
  disabled,
  update,
  t
}: {
  settings: LandingSettings;
  disabled: boolean;
  update: (patch: Partial<LandingSettings>) => void;
  t: Translate;
}) {
  return (
    <section
      className="settings-panel landing-settings-panel"
      aria-labelledby="landing-settings-title"
    >
      <div className="section-heading compact-heading">
        <h2 id="landing-settings-title">{t('landingQualityTitle')}</h2>
      </div>
      <div className="settings-primary-row landing-settings-primary-row">
        <div className="field-group landing-settings-field">
          <LandingFieldLabel
            label={t('landingImageQuality')}
            tooltip={t(
              settings.imageQuality === 'high' ? 'landingImageHighHint' : 'landingImageOptimalHint'
            )}
          />
          <SegmentedControl<'optimal' | 'high'>
            label={t('landingImageQuality')}
            value={settings.imageQuality}
            disabled={disabled}
            options={[
              { value: 'optimal', label: t('optimal') },
              { value: 'high', label: t('highQuality') }
            ]}
            onChange={imageQuality => update({ imageQuality })}
          />
        </div>
        <div className="field-group landing-settings-field">
          <LandingFieldLabel
            label={t('landingVideoQuality')}
            tooltip={t(
              settings.videoQuality === 'high' ? 'landingVideoHighHint' : 'landingVideoOptimalHint'
            )}
          />
          <SegmentedControl<'optimal' | 'high'>
            label={t('landingVideoQuality')}
            value={settings.videoQuality}
            disabled={disabled}
            options={[
              { value: 'optimal', label: t('optimal') },
              { value: 'high', label: t('highQuality') }
            ]}
            onChange={videoQuality => update({ videoQuality })}
          />
        </div>
        <div className="field-group landing-settings-field landing-archive-settings">
          <LandingFieldLabel label={t('landingOutput')} tooltip={t('landingArchiveHint')} />
          <div className="metadata-control landing-archive-control">
            <Checkbox
              className="feature-switch"
              checked={settings.archive}
              disabled={disabled}
              label={<strong>{t('landingArchive')}</strong>}
              onChange={event => update({ archive: event.target.checked })}
            />
          </div>
        </div>
      </div>
    </section>
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
