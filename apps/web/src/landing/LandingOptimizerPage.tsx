import { useEffect, useRef, useState } from 'react';
import type {
  LandingAsset,
  LandingEvent,
  LandingSettings,
  LandingState
} from '@video-compressor/shared';
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
  ProgressBar,
  SegmentedControl,
  Spinner,
  type Translate
} from '../components/ui';
import { formatSize } from '../format';
import { useI18n, type Language, type TranslationKey } from '../i18n';
import { internalLink } from '../lib/navigation';
import { analytics } from '../analytics/service';

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

  const job = state?.job ?? null;
  const settings = state?.settings ?? {
    imageQuality: 'optimal',
    videoQuality: 'optimal',
    archive: false
  };
  const running = state?.running ?? false;
  const busy = importing || job?.status === 'preparing' || running;

  const updateSettings = async (patch: Partial<LandingSettings>) => {
    try {
      setState(await requestBody<LandingState>('/api/landing/settings', patch));
    } catch (error) {
      handleError(error);
    }
  };

  const onDropData = async (data: DataTransfer) => {
    if (busy) return;
    const payload = await collectDropped(data);
    if (payload.kind === 'unsupported') {
      addToast(t('landingUnsupportedDrop'), 'warning');
      return;
    }
    if (payload.kind === 'zip') await importZip(payload.file);
    else await importFolder(payload.name, payload.files);
  };

  const importZip = async (file: File) => {
    setImporting(true);
    try {
      setState(await uploadLandingZip(file));
      analytics.track('landing_loaded', { tool_identifier: 'landing-optimizer' });
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const importFolder = async (name: string, files: UploadFile[]) => {
    if (!files.length) {
      addToast(t('landingUnsupportedDrop'), 'warning');
      return;
    }
    setImporting(true);
    try {
      await landingFolderBegin(name);
      for (const item of files) await landingFolderFile(item.relPath, item.file);
      setState(await landingFolderFinish());
      analytics.track('landing_loaded', { tool_identifier: 'landing-optimizer' });
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const pick = async (endpoint: string) => {
    if (busy) return;
    setImporting(true);
    try {
      setState(await request<LandingState>(endpoint, 'POST'));
    } catch (error) {
      handleError(error);
    } finally {
      setImporting(false);
    }
  };

  const start = async () => {
    try {
      setState(await request<LandingState>('/api/landing/start', 'POST'));
      analytics.track('landing_optimization_started', { tool_identifier: 'landing-optimizer' });
    } catch (error) {
      handleError(error);
    }
  };

  const reset = async () => {
    try {
      setState(await request<LandingState>('/api/landing/reset', 'POST'));
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
          disabled={!connected || busy}
          update={updateSettings}
          t={t}
        />

        <section className="add-files-section" aria-label={t('landingDropTitle')}>
          <DropZone
            disabled={!connected || busy || !state?.tools.ffmpeg}
            importing={importing || job?.status === 'preparing'}
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
              disabled={!connected || busy}
              onClick={() => void pick('/api/landing/select/zip')}
            >
              {t('landingChooseZip')}
            </Button>
            <Button
              variant="ghost"
              disabled={!connected || busy}
              onClick={() => void pick('/api/landing/select/folder')}
            >
              {t('landingChooseFolder')}
            </Button>
          </div>
          <p>{t('landingProcessedLocally')}</p>
        </section>

        {job ? (
          <LandingJobView
            job={job}
            connected={connected}
            running={running}
            language={language}
            onStart={() => void start()}
            onReset={() => void reset()}
            onReveal={endpoint => void request(endpoint, 'POST').catch(handleError)}
            t={t}
          />
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

function LandingSettingsPanel({
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
    <section className="settings-panel" aria-labelledby="landing-settings-title">
      <div className="section-heading compact-heading">
        <h2 id="landing-settings-title">{t('landingQualityTitle')}</h2>
      </div>
      <div className="settings-row mode-row">
        <div className="field-label">
          <span>{t('landingImageQuality')}</span>
        </div>
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
      <p className="field-hint landing-hint">
        {t(settings.imageQuality === 'high' ? 'landingImageHighHint' : 'landingImageOptimalHint')}
      </p>
      <div className="settings-row mode-row">
        <div className="field-label">
          <span>{t('landingVideoQuality')}</span>
        </div>
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
      <p className="field-hint landing-hint">
        {t(settings.videoQuality === 'high' ? 'landingVideoHighHint' : 'landingVideoOptimalHint')}
      </p>
      <div className="output-settings">
        <Checkbox
          checked={settings.archive}
          disabled={disabled}
          label={t('landingArchive')}
          onChange={event => update({ archive: event.target.checked })}
        />
        <span className="field-hint">{t('landingArchiveHint')}</span>
      </div>
    </section>
  );
}

function LandingJobView({
  job,
  connected,
  running,
  language,
  onStart,
  onReset,
  onReveal,
  t
}: {
  job: NonNullable<LandingState['job']>;
  connected: boolean;
  running: boolean;
  language: Language;
  onStart: () => void;
  onReset: () => void;
  onReveal: (endpoint: string) => void;
  t: Translate;
}) {
  const progress = overallProgress(job.assets);
  const completed = job.status === 'completed';
  const failed = job.status === 'failed';

  return (
    <>
      <section className="batch-toolbar" aria-label={t('landingAssetsTitle')}>
        <div className="selection-actions">
          <strong className="landing-name">{job.name}</strong>
          <span className="selected-count">
            {job.status === 'ready'
              ? t('landingReadyStatus')
              : job.status === 'preparing'
                ? t('landingPreparing')
                : running
                  ? t('landingProcessingStatus')
                  : completed
                    ? t('landingResultTitle')
                    : t('landingResultFailedTitle')}
          </span>
        </div>
        <div className="primary-actions">
          {job.status === 'ready' && (
            <Button
              variant="primary"
              disabled={!connected || job.assets.every(asset => asset.status !== 'pending')}
              onClick={onStart}
            >
              {t('landingOptimizeButton')}
            </Button>
          )}
          {(completed || failed) && (
            <Button variant="ghost" disabled={!connected} onClick={onReset}>
              {t('landingOptimizeAnother')}
            </Button>
          )}
          {job.status === 'ready' && (
            <Button variant="danger" disabled={!connected} onClick={onReset}>
              {t('landingReset')}
            </Button>
          )}
        </div>
      </section>

      {running && (
        <section className="batch-progress" aria-label={t('landingOverallProgress')}>
          <div className="batch-progress-heading">
            <strong>{t('landingOverallProgress')}</strong>
            <span>{Math.round(progress)}%</span>
          </div>
          <ProgressBar value={progress} label={t('landingOverallProgress')} active />
        </section>
      )}

      <section className="video-list" aria-live="polite">
        {job.assets.length === 0 ? (
          <div className="empty-state">
            <strong>{t('landingNoAssets')}</strong>
          </div>
        ) : (
          job.assets.map(asset => (
            <LandingAssetRow key={asset.id} asset={asset} language={language} t={t} />
          ))
        )}
      </section>

      {(completed || failed) && (
        <LandingSummary
          job={job}
          connected={connected}
          language={language}
          onReveal={onReveal}
          t={t}
        />
      )}
    </>
  );
}

function LandingAssetRow({
  asset,
  language,
  t
}: {
  asset: LandingAsset;
  language: Language;
  t: Translate;
}) {
  const displayPath = asset.newRelPath ?? asset.relPath;
  return (
    <article className={`job-row landing-asset-row is-${asset.status}`}>
      <div className="job-header">
        <div className="job-title-block">
          <div className="job-title-line">
            <h3 title={displayPath}>{displayPath}</h3>
            <span className={`status-badge ${landingStatusClass(asset.status)}`}>
              {t(landingStatusKey(asset.status))}
            </span>
            <span className="landing-type-tag">
              {t(asset.type === 'video' ? 'landingTypeVideo' : 'landingTypeImage')}
            </span>
          </div>
          <div className="landing-asset-sizes">
            <span>{formatSize(asset.originalSize, language)}</span>
            {asset.status === 'optimized' && asset.optimizedSize !== null && (
              <>
                <span aria-hidden="true">→</span>
                <strong>{formatSize(asset.optimizedSize, language)}</strong>
                {asset.savedPercent !== null && asset.savedPercent > 0 && (
                  <span className="landing-saved">
                    {t('landingSaved', { value: asset.savedPercent })}
                  </span>
                )}
              </>
            )}
            {asset.note && <span className="landing-note">{localizedNote(asset.note, t)}</span>}
          </div>
        </div>
      </div>
      {asset.status === 'processing' && (
        <div className="job-progress">
          <ProgressBar value={asset.progress} label={t('landingStatusProcessing')} active />
        </div>
      )}
    </article>
  );
}

function LandingSummary({
  job,
  connected,
  language,
  onReveal,
  t
}: {
  job: NonNullable<LandingState['job']>;
  connected: boolean;
  language: Language;
  onReveal: (endpoint: string) => void;
  t: Translate;
}) {
  if (job.status === 'failed') {
    return (
      <section className="result-summary" aria-live="polite">
        <h2>{t('landingResultFailedTitle')}</h2>
        {job.error && <p className="warning-text">{job.error}</p>}
      </section>
    );
  }
  return (
    <section className="result-summary" aria-labelledby="landing-summary-title">
      <h2 id="landing-summary-title">{t('landingResultTitle')}</h2>
      <dl>
        <div>
          <dt>{t('landingImagesOptimized')}</dt>
          <dd>{job.imagesOptimized}</dd>
        </div>
        <div>
          <dt>{t('landingVideosOptimized')}</dt>
          <dd>{job.videosOptimized}</dd>
        </div>
        <div>
          <dt>{t('landingFilesSkipped')}</dt>
          <dd>{job.filesSkipped}</dd>
        </div>
        <div>
          <dt>{t('landingReferencesUpdated')}</dt>
          <dd>{job.referencesUpdated}</dd>
        </div>
        <div>
          <dt>{t('landingOriginalMedia')}</dt>
          <dd>{formatSize(job.originalMediaSize, language)}</dd>
        </div>
        <div>
          <dt>{t('landingOptimizedMedia')}</dt>
          <dd>{formatSize(job.optimizedMediaSize, language)}</dd>
        </div>
        <div>
          <dt>{t('landingSavedTotal')}</dt>
          <dd>
            {formatSize(job.savedBytes, language)} · {job.savedPercent}%
          </dd>
        </div>
      </dl>
      {job.outputPath && (
        <div className="inline-actions">
          <Button
            variant="primary"
            disabled={!connected}
            onClick={() => onReveal('/api/landing/output/open')}
          >
            {t('landingOpenResult')}
          </Button>
          <Button
            variant="ghost"
            disabled={!connected}
            onClick={() => onReveal('/api/landing/output/reveal')}
          >
            {t('landingShowResult')}
          </Button>
        </div>
      )}
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

function overallProgress(assets: LandingAsset[]): number {
  if (!assets.length) return 0;
  const done = assets.filter(asset =>
    ['optimized', 'skipped', 'failed'].includes(asset.status)
  ).length;
  const active = assets.find(asset => asset.status === 'processing');
  const fraction = active?.progress ? active.progress / 100 : 0;
  return Math.min(100, ((done + fraction) / assets.length) * 100);
}

function landingStatusKey(status: LandingAsset['status']): TranslationKey {
  const map: Record<LandingAsset['status'], TranslationKey> = {
    pending: 'landingStatusPending',
    processing: 'landingStatusProcessing',
    optimized: 'landingStatusOptimized',
    skipped: 'landingStatusSkipped',
    failed: 'landingStatusFailed'
  };
  return map[status];
}

function landingStatusClass(status: LandingAsset['status']): string {
  const map: Record<LandingAsset['status'], string> = {
    pending: 'status-queued',
    processing: 'status-processing',
    optimized: 'status-completed',
    skipped: 'status-cancelled',
    failed: 'status-failed'
  };
  return map[status];
}

function localizedNote(note: string, t: Translate): string {
  const map: Record<string, TranslationKey> = {
    'already-optimized': 'noteAlreadyOptimized',
    'no-gain': 'noteNoGain',
    'name-collision': 'noteNameCollision',
    'animated-safe': 'noteAnimatedSafe',
    'vector-safe': 'noteVectorSafe'
  };
  const key = map[note];
  return key ? t(key) : t('noteFailedGeneric');
}

/* ---------------------------- drop handling ---------------------------- */

type DroppedPayload =
  | { kind: 'zip'; file: File }
  | { kind: 'folder'; name: string; files: UploadFile[] }
  | { kind: 'unsupported' };

async function collectDropped(data: DataTransfer): Promise<DroppedPayload> {
  const items = data.items ? Array.from(data.items) : [];
  const entries = items
    .map(item => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => Boolean(entry));
  const directory = entries.find(entry => entry.isDirectory) as
    FileSystemDirectoryEntry | undefined;
  if (directory) {
    const files: UploadFile[] = [];
    await readDirectory(directory, directory.name, files);
    return { kind: 'folder', name: directory.name, files };
  }
  const file = data.files?.[0];
  if (file && /\.zip$/i.test(file.name)) return { kind: 'zip', file };
  return { kind: 'unsupported' };
}

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
