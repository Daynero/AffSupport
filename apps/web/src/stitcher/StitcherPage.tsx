/**
 * Pick a video, pick a photo, press start.
 *
 * Built out of the compressor's own parts, and in several places out of the compressor's own
 * components: the `DropZone`, the `ImageEmbeddingSection` with its two galleries, its fit-mode
 * row and its duration ranges, the settings panel with its gear and summary, the action bar,
 * and the before/after card. The screens are the compressor's library, read and written
 * through the compressor's own endpoints — one library, one set of controls.
 *
 * What is genuinely this tool's own is the destination row (it can overwrite the original,
 * which the compressor cannot) and the line that says what was found and what will come out.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Ban,
  ChevronDown,
  Eraser,
  Files,
  FolderOpen,
  Play,
  RefreshCw,
  Plus,
  Replace,
  Settings as SettingsIcon,
  Trash2
} from 'lucide-react';
import type {
  AgentSettings,
  ImageEmbeddingSettingsPatch,
  ImageSlot,
  JobStatus,
  StitchDestination,
  StitchJob,
  StitchMeasurements,
  StitchOperation,
  StitchSettings
} from '@video-compressor/shared';
import { useAgent } from '../AgentContext';
import { useI18n, type Language } from '../i18n';
import { analytics } from '../analytics/service';
import { compactPath, formatCodec, formatDuration, formatFps, formatSize } from '../format';
import { DropZone } from '../components/DropZone';
import { ImageEmbeddingSection } from '../components/ImageEmbeddingSection';
import { Button, Checkbox, StatusBadge, Tooltip, type Translate } from '../components/ui';
import { toggleSelection } from '../queue-ui';
import { useCompactToolbar } from '../components/useCompactToolbar';
import { ICON_SIZE, ICON_STROKE } from '../components/icons';
import { StitcherProvider, useStitcher } from './StitcherContext';
import {
  addStitchFiles,
  cancelStitch,
  clearFinishedStitches,
  fetchCompressorState,
  openStitchOutput,
  removeScreenImage,
  removeStitch,
  repeatStitch,
  resolveDroppedVideo,
  revealStitchOutput,
  selectStitchFolder,
  selectStitchSources,
  startStitchJobs,
  updateCompressorSettings,
  uploadScreenImage
} from './api';

const SETTINGS_OPEN_KEY = 'wishly.stitcher.settings-open.v1';

export default function StitcherPage() {
  return (
    <StitcherProvider>
      <Stitcher />
    </StitcherProvider>
  );
}

/**
 * The page itself, without its provider.
 *
 * Exported so a test can mount it against a snapshot instead of a running local app — the
 * same seam every other store in this app offers through its `*ContextOverride`.
 */
export function Stitcher() {
  const { t, language } = useI18n();
  const { connection, capabilities, reconnect } = useAgent();
  const { state, applyState } = useStitcher();
  const connected = connection === 'connected';
  const canPick = capabilities.includes('native-file-picker');
  const canDropPaths = capabilities.includes('local-file-paths');

  const [operation, setOperation] = useState<StitchOperation>('restitch');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
  const [compressor, setCompressor] = useState<AgentSettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The compressor's toolbar collapse, from the compressor's own hook.
  const toolbar = useCompactToolbar();

  const settings: StitchSettings | null = state?.settings ?? null;
  const jobs = useMemo(() => state?.jobs ?? [], [state]);

  useEffect(() => {
    document.title = 'Soty — Video Stitcher';
    analytics.track('tool_opened', { tool_identifier: 'stitcher' });
  }, []);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    void fetchCompressorState()
      .then(queue => {
        if (active) setCompressor(queue.settings);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [connected]);

  const handleError = (error: unknown) => {
    setMessage(messageFor(error, t));
    if (error instanceof Error && error.message === 'CONNECTION_FAILED') reconnect();
  };

  const updateEmbedding = (patch: ImageEmbeddingSettingsPatch) => {
    void updateCompressorSettings({ imageEmbedding: patch })
      .then(queue => setCompressor(queue.settings))
      .catch(handleError);
  };

  const uploadImages = async (slot: ImageSlot, files: File[]) => {
    for (const file of files) setCompressor((await uploadScreenImage(slot, file)).settings);
  };

  const removeImage = async (slot: ImageSlot, id: string) => {
    setCompressor((await removeScreenImage(slot, id)).settings);
  };

  /** Adds files to the list, selects what arrived, and says what was refused and why. */
  const addFiles = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      setBusy(true);
      setMessage(null);
      try {
        const before = new Set((state?.jobs ?? []).map(job => job.id));
        const { state: next, refused } = await addStitchFiles(paths);
        applyState(next);
        const added = next.jobs.filter(job => !before.has(job.id)).map(job => job.id);
        if (added.length) setSelected(current => new Set([...current, ...added]));
        if (refused.length) setMessage(refusalMessage(refused[0]!.reason, t));
      } catch (error) {
        handleError(error);
      } finally {
        setBusy(false);
      }
    },
    [state, applyState, t]
  );

  const take = (paths: string[]) => void addFiles(paths.map(value => value.replace(/\/$/u, '')));

  /**
   * A real drop from the file manager carries the file's contents, not its path, so the
   * agent is asked to find the original on disk. Only if it cannot is the user sent to the
   * button — a copy in a temp folder would make "beside the original" a lie.
   */
  const takeDropped = async (files: File[]) => {
    setBusy(true);
    try {
      // One file the agent cannot place must not lose the rest of the drop: each is
      // resolved on its own, and only what could not be found is reported.
      const found: string[] = [];
      let lost: unknown = null;
      for (const file of files) {
        try {
          found.push(...(await resolveDroppedVideo(file)));
        } catch (error) {
          lost = error;
        }
      }
      if (found.length) await addFiles(found);
      if (lost) {
        const code = lost instanceof Error ? lost.message : '';
        setMessage(
          code === 'STITCH_DROPPED_NOT_FOUND' ? t('stitcherDropUnknown') : messageFor(lost, t)
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    try {
      take((await selectStitchSources()).paths);
    } catch (error) {
      handleError(error);
    }
  };

  const run = async (only?: string[]) => {
    const ids = only ?? startableIds.filter(id => selected.has(id));
    if (!ids.length) {
      setMessage(t('stitcherNothingSelected'));
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const { state: next, failures } = await startStitchJobs(ids, operation);
      applyState(next);
      if (failures.length) setMessage(planFailureMessage(failures[0]!.error, t));
      analytics.track('stitch_started', { tool_identifier: 'stitcher' });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = async () => {
    const { path } = await selectStitchFolder();
    if (path) await updateStitchSettings({ destination: { kind: 'folder', path } });
  };

  const { updateSettings: updateStitchSettings } = useStitcher();
  const startableIds = useMemo(
    () =>
      jobs.filter(job => job.status !== 'queued' && job.status !== 'running').map(job => job.id),
    [jobs]
  );
  const selectedStartable = startableIds.filter(id => selected.has(id));
  const canStart = selectedStartable.length > 0 && !busy && connected;
  const inFlight = jobs.filter(job => job.status === 'running' || job.status === 'queued').length;

  const stopAll = async () => {
    for (const job of jobs.filter(one => one.status === 'running' || one.status === 'queued')) {
      const { state: next } = await cancelStitch(job.id);
      applyState(next);
    }
  };

  return (
    <main className="workspace stitcher-page">
      {!connected && (
        <section className="blocking-message blocking-neutral" role="alert">
          <div>
            <strong>{t('agentDisconnected')}</strong>
            <span>{t('stitcherSubtitle')}</span>
          </div>
          <Button onClick={reconnect} loading={connection === 'connecting'}>
            {t('reconnect')}
          </Button>
        </section>
      )}

      <section className="add-files-section" aria-label={t('stitcherChoose')}>
        <DropZone
          disabled={!connected || busy}
          importing={busy}
          chooseFiles={() => void choose()}
          addDroppedFiles={files => void takeDropped(files)}
          addDroppedFilePaths={canDropPaths ? take : undefined}
          title={t('stitcherDropTitle')}
          formats={t('stitcherDropFormats')}
          activeLabel={t('stitcherDropActive')}
          importingLabel={t('stitcherInspecting')}
          t={t}
        />
        {!canPick && connected && <p className="stitch-note">{t('stitcherPickerUnavailable')}</p>}
        {message && (
          <p className="stitch-note is-error" role="alert">
            {message}
          </p>
        )}
      </section>

      {settings && (
        <StitchSettingsPanel
          settings={settings}
          compressor={compressor}
          operation={operation}
          onOperation={setOperation}
          updateSettings={updateStitchSettings}
          updateEmbedding={updateEmbedding}
          uploadImages={uploadImages}
          removeImage={removeImage}
          chooseFolder={() => void chooseFolder()}
          disabled={!connected}
          t={t}
        />
      )}

      <section className="batch-toolbar" aria-label={t('stitcherStart')}>
        <div
          className={`batch-toolbar-row ${toolbar.compactActions ? 'is-compact' : ''} ${
            toolbar.compactChips ? 'is-compact-chips' : ''
          }`.trim()}
          ref={toolbar.ref}
        >
          <div className="selection-actions">
            <Checkbox
              className="select-all-box"
              checked={startableIds.length > 0 && selectedStartable.length === startableIds.length}
              disabled={!connected || startableIds.length === 0}
              onChange={event =>
                setSelected(event.target.checked ? new Set(startableIds) : new Set())
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
          {/* All four counters stay on screen — a zero is information too. */}
          <div className="batch-chips" aria-hidden="true">
            <span className="batch-chip">
              <b>{jobs.length}</b>
              <span className="chip-word"> {t('stitcherChipFiles')}</span>
            </span>
            <span className="batch-chip is-processing">
              <b>{inFlight}</b>
              <span className="chip-word"> {t('stitcherChipRunning')}</span>
            </span>
            <span className="batch-chip is-done">
              <b>{jobs.filter(job => job.status === 'done').length}</b>
              <span className="chip-word"> {t('stitcherChipDone')}</span>
            </span>
            <span className="batch-chip is-failed">
              <b>{jobs.filter(job => job.status === 'failed').length}</b>
              <span className="chip-word"> {t('stitcherChipFailed')}</span>
            </span>
          </div>
          <div className="primary-actions">
            <Button
              variant="primary"
              disabled={!canStart}
              loading={busy}
              title={t(OPERATION_KEYS[operation])}
              onClick={() => void run()}
            >
              <Play size={18} strokeWidth={1.75} aria-hidden="true" />
              <span className="action-label">
                {t(OPERATION_KEYS[operation])}
                {selectedStartable.length ? ` (${selectedStartable.length})` : ''}
              </span>
            </Button>
            {inFlight > 0 && (
              <Button
                variant="danger"
                disabled={!connected}
                title={t('stopAll')}
                onClick={() => void stopAll()}
              >
                <Ban size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className="action-label">{t('stopAll')}</span>
              </Button>
            )}
            {jobs.some(job => job.status !== 'queued' && job.status !== 'running') && (
              <Button
                variant="ghost"
                disabled={!connected}
                title={t('clearFinished')}
                onClick={() =>
                  void clearFinishedStitches().then(({ state: next }) => applyState(next))
                }
              >
                <Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />
                <span className="action-label">{t('clearFinished')}</span>
              </Button>
            )}
          </div>
        </div>
      </section>

      <section className="video-list" aria-label={t('stitcherQueueTitle')}>
        {jobs.length === 0 ? (
          <p className="stitch-note">{t('stitcherQueueEmpty')}</p>
        ) : (
          [...jobs].reverse().map((job, index) => (
            <StitchRow
              key={job.id}
              job={job}
              language={language}
              disabled={!connected}
              selected={selected.has(job.id)}
              onSelected={(checked, shiftKey) => {
                const update = toggleSelection(
                  selected,
                  job.id,
                  checked,
                  startableIds,
                  lastSelectedIndex,
                  shiftKey
                );
                setSelected(update.selected);
                setLastSelectedIndex(update.lastIndex ?? index);
              }}
              onCancel={() => void cancelStitch(job.id).then(({ state: next }) => applyState(next))}
              onStart={() => void run([job.id])}
              onReveal={() => void revealStitchOutput(job.id)}
              onOpen={() => void openStitchOutput(job.id)}
              onRepeat={() =>
                void repeatStitch(job.id)
                  .then(({ state: next }) => applyState(next))
                  .catch(handleError)
              }
              onRemove={() =>
                void removeStitch(job.id)
                  .then(({ state: next }) => applyState(next))
                  .catch(handleError)
              }
              t={t}
            />
          ))
        )}
      </section>
    </main>
  );
}

/* ── Settings ──────────────────────────────────────────────────────────────
   The destination row sits above the galleries, in the same shelf the
   compressor gives its own settings row; the galleries, the fit mode and the
   durations are the compressor's component, unchanged. */

function StitchSettingsPanel({
  settings,
  compressor,
  operation,
  onOperation,
  updateSettings,
  updateEmbedding,
  uploadImages,
  removeImage,
  chooseFolder,
  disabled,
  t
}: {
  settings: StitchSettings;
  compressor: AgentSettings | null;
  operation: StitchOperation;
  onOperation: (next: StitchOperation) => void;
  updateSettings: (patch: Partial<StitchSettings>) => Promise<void>;
  updateEmbedding: (patch: ImageEmbeddingSettingsPatch) => void;
  uploadImages: (slot: ImageSlot, files: File[]) => Promise<void>;
  removeImage: (slot: ImageSlot, id: string) => Promise<void>;
  chooseFolder: () => void;
  disabled: boolean;
  t: Translate;
}) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(SETTINGS_OPEN_KEY) !== 'closed';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_OPEN_KEY, open ? 'open' : 'closed');
    } catch {
      // A remembered panel state is a convenience, never a requirement.
    }
  }, [open]);

  return (
    <section
      className={`settings-panel ${open ? '' : 'is-collapsed'}`.trim()}
      aria-labelledby="stitcher-settings-title"
    >
      <button
        type="button"
        className="settings-collapse section-heading compact-heading"
        aria-expanded={open}
        aria-controls="stitcher-settings-body"
        onClick={() => setOpen(current => !current)}
      >
        <SettingsIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
        <h2 id="stitcher-settings-title">{t('stitcherSettingsTitle')}</h2>
        <span className="settings-summary">
          <span>
            <span className="settings-summary-key">{t('saveResults')}</span>
            {destinationLabel(settings.destination, t)}
          </span>
        </span>
        <ChevronDown
          size={ICON_SIZE}
          strokeWidth={ICON_STROKE}
          className={`settings-chevron ${open ? '' : 'is-rotated'}`.trim()}
          aria-hidden="true"
        />
      </button>

      <div id="stitcher-settings-body" className="settings-body" hidden={!open}>
        <div className="embedding-settings-row">
          <div className="field-group">
            <div className="field-label">
              <span>{t('stitcherOperation')}</span>
              <Tooltip label={t('stitcherOperationHint')}>{t('stitcherOperationHint')}</Tooltip>
            </div>
            <div className="fit-mode-pictos" role="radiogroup" aria-label={t('stitcherOperation')}>
              <button
                type="button"
                role="radio"
                className={operation === 'restitch' ? 'is-selected' : ''}
                data-tip={t('stitcherOpRestitch')}
                aria-label={t('stitcherOpRestitch')}
                aria-checked={operation === 'restitch'}
                disabled={disabled}
                onClick={() => onOperation('restitch')}
              >
                <Replace size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="radio"
                className={operation === 'stitch' ? 'is-selected' : ''}
                data-tip={t('stitcherOpStitch')}
                aria-label={t('stitcherOpStitch')}
                aria-checked={operation === 'stitch'}
                disabled={disabled}
                onClick={() => onOperation('stitch')}
              >
                <Plus size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="radio"
                className={operation === 'unstitch' ? 'is-selected' : ''}
                data-tip={t('stitcherOpUnstitch')}
                aria-label={t('stitcherOpUnstitch')}
                aria-checked={operation === 'unstitch'}
                disabled={disabled}
                onClick={() => onOperation('unstitch')}
              >
                <Eraser size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
              </button>
            </div>
            <span className="optimal-summary">{t(OPERATION_KEYS[operation])}</span>
          </div>

          <div className="field-group">
            <div className="field-label">
              <span>{t('saveResults')}</span>
              <Tooltip label={t('stitcherDestinationHint')}>{t('stitcherDestinationHint')}</Tooltip>
            </div>
            <div className="output-control-row">
              <div className="fit-mode-pictos" role="radiogroup" aria-label={t('saveResults')}>
                <button
                  type="button"
                  role="radio"
                  className={settings.destination.kind === 'beside' ? 'is-selected' : ''}
                  data-tip={t('nextToOriginals')}
                  aria-label={t('nextToOriginals')}
                  aria-checked={settings.destination.kind === 'beside'}
                  disabled={disabled}
                  onClick={() => void updateSettings({ destination: { kind: 'beside' } })}
                >
                  <Files size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  role="radio"
                  className={settings.destination.kind === 'folder' ? 'is-selected' : ''}
                  data-tip={t('chooseFolder')}
                  aria-label={t('chooseFolder')}
                  aria-checked={settings.destination.kind === 'folder'}
                  disabled={disabled}
                  onClick={chooseFolder}
                >
                  <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  role="radio"
                  className={settings.destination.kind === 'overwrite' ? 'is-selected' : ''}
                  data-tip={t('stitcherDestinationOverwrite')}
                  aria-label={t('stitcherDestinationOverwrite')}
                  aria-checked={settings.destination.kind === 'overwrite'}
                  disabled={disabled}
                  onClick={() => void updateSettings({ destination: { kind: 'overwrite' } })}
                >
                  <Replace size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
                </button>
              </div>
              <input
                className="time-input suffix-input"
                type="text"
                maxLength={60}
                placeholder="_stitched"
                data-tip={t('outputSuffixLabel')}
                aria-label={t('outputSuffixLabel')}
                value={settings.outputSuffix}
                disabled={disabled}
                onChange={event => void updateSettings({ outputSuffix: event.target.value })}
              />
            </div>
            <span className="optimal-summary output-mode-summary">
              {destinationLabel(settings.destination, t)}
            </span>
            {settings.destination.kind === 'folder' && (
              <span className="selected-folder" data-tip={settings.destination.path}>
                {compactPath(settings.destination.path)}
              </span>
            )}
          </div>
        </div>

        {compressor && (
          <ImageEmbeddingSection
            settings={compressor.imageEmbedding}
            disabled={disabled}
            update={updateEmbedding}
            uploadImages={uploadImages}
            removeImage={removeImage}
            onValidityChange={() => {}}
            optional={false}
            t={t}
          />
        )}
      </div>
    </section>
  );
}

/* ── Rows ──────────────────────────────────────────────────────────────────
   The compressor's card, part for part: what it was on the left, what it
   became on the right, the actions in their own column, and the status rail
   down the edge. Both panels carry the same six facts in the same order, so a
   person moving between the two tools reads one layout. */

function StitchRow({
  job,
  language,
  disabled,
  selected,
  onSelected,
  onCancel,
  onStart,
  onReveal,
  onOpen,
  onRepeat,
  onRemove,
  t
}: {
  job: StitchJob;
  language: Language;
  disabled: boolean;
  selected: boolean;
  onSelected: (checked: boolean, shiftKey: boolean) => void;
  onCancel: () => void;
  onStart: () => void;
  onReveal: () => void;
  onOpen: () => void;
  onRepeat: () => void;
  onRemove: () => void;
  t: Translate;
}) {
  const running = job.status === 'running' || job.status === 'queued';
  // A job from an older build may carry neither figure; the card still renders.
  const source = job.source ?? EMPTY_MEASURE;
  const result = job.status === 'done' ? (job.result ?? null) : null;
  const saving =
    result && source.sizeBytes ? Math.round((1 - result.sizeBytes / source.sizeBytes) * 100) : null;

  return (
    <article
      className={`job-row ${selected ? 'is-selected' : ''} ${running ? 'is-processing' : ''}`.trim()}
      data-state={badgeStatus(job.status)}
      /* The whole card toggles its checkbox — except where a real control lives, so buttons
         and the box itself keep their own click. The compressor's rule, verbatim. */
      onClick={event => {
        if (running) return;
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, label, [role="button"]')) return;
        onSelected(!selected, (event.nativeEvent as MouseEvent).shiftKey === true);
      }}
    >
      <div className="job-main">
        <div className="job-header">
          <Checkbox
            checked={selected}
            disabled={disabled || running}
            aria-label={job.sourceName}
            label={<span className="sr-only">{job.sourceName}</span>}
            onChange={event =>
              onSelected(
                event.target.checked,
                (event.nativeEvent as MouseEvent | KeyboardEvent).shiftKey === true
              )
            }
          />
          <div className="job-title-block">
            <div className="job-title-line">
              <h3 data-tip={job.sourcePath}>{job.sourceName}</h3>
              <StatusBadge status={badgeStatus(job.status)} t={t} context="stitch" />
            </div>
            <span className="job-timer">{detailText(job, t)}</span>
          </div>
        </div>
        <section className="media-panel original-panel" aria-label={t('originalVideoInfo')}>
          <MediaGrid items={measureItems(source, language, t)} />
        </section>
      </div>

      <div className="job-side">
        <div className="outcome-slot">
          <div className="outcome-phase outcome-phase-result">
            <section
              className={`media-panel ${result ? 'result-panel' : 'estimate-panel'}`}
              aria-label={t(result ? 'finalVideoInfo' : 'expectedVideoInfo')}
            >
              <h4>{t(result ? 'readyFile' : 'stitcherAfter')}</h4>
              <div className="result-size">
                <strong>{result ? formatSize(result.sizeBytes, language) : '—'}</strong>
                {/* Growth is the expected outcome here — the file gained a photo screen — so
                    it is stated, not warned about. The compressor's amber belongs to an
                    encode that failed to save anything, which is a different fact. */}
                {saving !== null && saving > 0 && (
                  <span>{t('actualSaving', { value: saving })}</span>
                )}
                {saving !== null && saving <= 0 && (
                  <span>{t('largerActual', { value: Math.abs(saving) })}</span>
                )}
              </div>
              <MediaGrid items={measureItems(result ?? EMPTY_MEASURE, language, t)} />
              {job.outputPath && (
                <div className="output-path" title={job.outputPath}>
                  <span>{t('outputPath')}</span>
                  <strong>{compactPath(job.outputPath)}</strong>
                </div>
              )}
            </section>
          </div>
        </div>

        <div className="job-actions" aria-label={t('fileActions', { name: job.sourceName })}>
          {running ? (
            <Button variant="danger" disabled={disabled} onClick={onCancel}>
              <Ban size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('cancel')}
            </Button>
          ) : (
            <>
              {/* Run first, then folder, open, delete — the compressor's order, so the same
                  action sits in the same place whatever state the file is in. */}
              {job.status === 'ready' ? (
                <Button variant="primary" disabled={disabled} onClick={onStart}>
                  <Play size={16} strokeWidth={1.75} aria-hidden="true" />
                  {t('stitcherStartOne')}
                </Button>
              ) : (
                <Button variant="primary" disabled={disabled} onClick={onRepeat}>
                  <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
                  {t(job.status === 'done' ? 'repeatCompression' : 'retry')}
                </Button>
              )}
              <Button variant="success" disabled={disabled} onClick={onReveal}>
                <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
                {t('showInFolder')}
              </Button>
              <Button variant="secondary" disabled={disabled} onClick={onOpen}>
                <Play size={16} strokeWidth={1.75} aria-hidden="true" />
                {t('openFile')}
              </Button>
              <Button variant="danger" disabled={disabled} onClick={onRemove}>
                <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                {t('remove')}
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

/** A refusal from the add route, in the user's language. */
function refusalMessage(reason: string, t: Translate): string {
  if (reason === 'video-codec') return t('stitcherUnsupportedVideoCodec');
  if (reason === 'audio-codec') return t('stitcherUnsupportedAudioCodec');
  if (reason === 'variable-frame-rate') return t('stitcherUnsupportedVariableFrameRate');
  if (reason === 'container') return t('stitcherUnsupportedContainer');
  return t('stitcherUnsupportedUnreadable');
}

/** A row the planner refused, in the user's language. */
function planFailureMessage(error: string, t: Translate): string {
  if (error === 'nothing-to-remove') return t('stitcherNothingToRemove');
  if (error === 'no-screens') return t('stitcherNoScreensChosen');
  return refusalMessage(error, t);
}

const OPERATION_KEYS = {
  stitch: 'stitcherOpStitch',
  restitch: 'stitcherOpRestitch',
  unstitch: 'stitcherOpUnstitch'
} as const;

const EMPTY_MEASURE: StitchMeasurements = {
  sizeBytes: 0,
  durationSeconds: 0,
  width: 0,
  height: 0,
  frameRate: 0,
  codec: ''
};

/** The compressor's own six facts, in the compressor's own order. */
function measureItems(
  measure: StitchMeasurements,
  language: Language,
  t: Translate
): (readonly [string, string])[] {
  return [
    [t('fileSize'), measure.sizeBytes ? formatSize(measure.sizeBytes, language) : '—'],
    [t('videoResolution'), measure.width ? `${measure.width}×${measure.height}` : '—'],
    [t('videoFps'), measure.frameRate ? `${formatFps(measure.frameRate, language)} FPS` : '—'],
    [t('duration'), formatDuration(measure.durationSeconds)],
    [t('codec'), formatCodec(measure.codec)]
  ];
}

function MediaGrid({ items }: { items: (readonly [string, string])[] }) {
  return (
    <dl className="media-grid">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Reuses the compressor's own badge, so the two queues cannot drift apart. */
function badgeStatus(status: StitchJob['status']): JobStatus {
  if (status === 'running') return 'processing';
  if (status === 'done') return 'completed';
  return status;
}

const STAGE_KEYS = {
  inspecting: 'stitcherInspecting',
  preparing: 'stitcherStagePreparing',
  screens: 'stitcherStageScreens',
  joining: 'stitcherStageJoining',
  verifying: 'stitcherStageVerifying'
} as const;

const ERROR_KEYS: Record<string, string> = {
  STITCH_VERIFICATION_FAILED: 'stitcherFailedVerification',
  STITCH_OUTPUT_UNWRITABLE: 'stitcherFailedUnwritable',
  STITCH_IMAGE_UNAVAILABLE: 'stitcherFailedPath',
  STITCH_PATH_INVALID: 'stitcherFailedPath',
  STITCH_INTERRUPTED: 'stitcherFailedInterrupted',
  MEDIA_TOOL_UNAVAILABLE: 'stitcherFailedTool'
};

function detailText(job: StitchJob, t: Translate): string {
  /* A ready row says what was found in the file. It is the one fact the user cannot see
     from the card's own figures, and it is what tells them whether "re-stitch" or
     "stitch" is the operation they want.

     The edges are lengths, not timestamps, and the detector routinely returns a single
     duplicated frame at the end of ordinary footage. A screen this tool made is minutes
     long, so a second is the line between a screen and that noise. */
  if (job.status === 'ready') {
    // Before a run there is nothing to report: the search happens when the row is started,
    // so that dropping a file is instant. After one, the row keeps what was found.
    if (!job.detected) return '';
    const found = job.detected.startSeconds + job.detected.endSeconds;
    return found >= 1 ? t('stitcherFoundScreens') : t('stitcherFoundNone');
  }
  if (job.status === 'running' && job.stage)
    return t(STAGE_KEYS[job.stage] as Parameters<Translate>[0]);
  if (job.status === 'done')
    return t('stitcherDone', { seconds: ((job.elapsedMs ?? 0) / 1000).toFixed(1) });
  if (job.status === 'failed') {
    const key = job.error ? ERROR_KEYS[job.error] : undefined;
    return key ? t(key as Parameters<Translate>[0]) : t('stitcherFailedTool');
  }
  if (job.status === 'cancelled') return t('stitcherCancelled');
  return '';
}

function destinationLabel(destination: StitchDestination, t: Translate): string {
  if (destination.kind === 'beside') return t('nextToOriginals');
  if (destination.kind === 'overwrite') return t('stitcherDestinationOverwrite');
  return t('chooseFolder');
}

/** One sentence per machine code, chosen here so the agent never sends prose. */
function messageFor(error: unknown, t: Translate): string {
  const code = error instanceof Error ? error.message : '';
  const reason = (error as { reason?: string } | null)?.reason;
  if (code === 'STITCH_NOTHING_TO_REMOVE') return t('stitcherNothingToRemove');
  if (code === 'STITCH_NO_SCREENS_CHOSEN') return t('stitcherNoScreensChosen');
  if (code === 'MEDIA_TOOL_UNAVAILABLE') return t('stitcherFailedTool');
  if (code === 'STITCH_SOURCE_UNSUPPORTED') {
    if (reason === 'video-codec') return t('stitcherUnsupportedVideoCodec');
    if (reason === 'audio-codec') return t('stitcherUnsupportedAudioCodec');
    if (reason === 'variable-frame-rate') return t('stitcherUnsupportedVariableFrameRate');
    if (reason === 'container') return t('stitcherUnsupportedContainer');
    return t('stitcherUnsupportedUnreadable');
  }
  if (code === 'STITCH_PATH_INVALID') return t('stitcherFailedPath');
  return t('stitcherFailedTool');
}
