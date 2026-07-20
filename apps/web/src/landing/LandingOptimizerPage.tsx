import { useEffect, useMemo, useRef, useState } from 'react';
import type { LandingEvent, LandingSettings, LandingState } from '@video-compressor/shared';
import {
  landingEventUrl,
  landingFolderBegin,
  landingFolderFile,
  landingFolderFinish,
  request,
  requestBody,
  uploadLandingZip
} from '../api/client';
import { Header, Onboarding } from '../App';
import { useAgent } from '../AgentContext';
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
import { internalLink } from '../lib/navigation';
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
  const { language, setLanguage, t } = useI18n();
  const { connection, connectedOnce, reconnect } = useAgent();
  const [state, setState] = useState<LandingState | null>(null);
  const [help, setHelp] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const toastId = useRef(0);
  const connected = connection === 'connected';

  useEffect(() => {
    document.title = 'Landing Optimizer — Wishly';
    analytics.track('tool_opened', { tool_identifier: 'landing-optimizer' });
  }, []);

  useEffect(() => {
    if (connection !== 'connected') return;
    let source: EventSource | null = null;
    let active = true;
    request<LandingState>('/api/landing/state', 'GET')
      .then(value => {
        if (active) setState(value);
      })
      .catch(() => {});
    source = new EventSource(landingEventUrl());
    source.onmessage = event => {
      const update = JSON.parse(event.data) as LandingEvent;
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
    addToast(message && message.length < 120 ? message : t('landingResultFailedTitle'), 'error');
  };

  const jobs = state?.jobs ?? (state?.job ? [state.job] : []);
  const visibleJobs = useMemo(() => [...jobs].sort((a, b) => b.createdAt - a.createdAt), [jobs]);
  const settings = state?.settings ?? {
    imageQuality: 'optimal',
    videoQuality: 'optimal',
    archive: false
  };
  const running = state?.running ?? false;
  const readyJobs = jobs.filter(job => job.status === 'ready');
  const finishedJobs = jobs.filter(job => job.status === 'completed' || job.status === 'failed');

  const updateSettings = async (patch: Partial<LandingSettings>) => {
    try {
      setState(await requestBody<LandingState>('/api/landing/settings', patch));
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
            setState(await uploadLandingZip(payload.file));
            loaded += 1;
          } else if (payload.files.length) {
            await landingFolderBegin(payload.name);
            for (const item of payload.files) {
              await landingFolderFile(item.relPath, item.file);
            }
            setState(await landingFolderFinish());
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
      setState(await request<LandingState>(endpoint, 'POST'));
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const start = async (jobId: string) => {
    try {
      setState(
        await request<LandingState>(`/api/landing/jobs/${encodeURIComponent(jobId)}/start`, 'POST')
      );
      analytics.track('landing_optimization_started', { tool_identifier: 'landing-optimizer' });
    } catch (error) {
      handleError(error);
    }
  };

  const startAll = async () => {
    try {
      setState(
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
      setState(
        await request<LandingState>(`/api/landing/jobs/${encodeURIComponent(jobId)}`, 'DELETE')
      );
    } catch (error) {
      handleError(error);
    }
  };

  const clearFinished = async () => {
    try {
      setState(await request<LandingState>('/api/landing/completed', 'DELETE'));
    } catch (error) {
      handleError(error);
    }
  };

  const header = (
    <Header
      language={language}
      setLanguage={setLanguage}
      connection={connection}
      onHome={event => {
        if (running && !confirm(t('leaveLandingConfirm'))) {
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
          <section className="landing-jobs-list" aria-live="polite">
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
    </div>
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
