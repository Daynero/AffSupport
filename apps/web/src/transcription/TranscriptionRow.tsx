import { useMemo, memo, useEffect, useRef, useState } from 'react';
import {
  Ban,
  Copy,
  Eye,
  FolderOpen,
  Globe,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2
} from 'lucide-react';
import {
  TRANSCRIPTION_LANGUAGE_CODES,
  TRANSCRIPTION_LIFECYCLE,
  confusableLanguages,
  isSettled,
  type TranscriptionJob,
  type TranscriptionQualityMode
} from '@video-compressor/shared';
import { StatusBadge, type Translate } from '../components/ui';
import { Button, Checkbox, Progress } from '../components/ui/index';
import { formatDuration } from '../format';
import type { Language } from '../i18n';
import type { TranscriptExportContent, TranscriptExportFormat } from './export';
import { ExportMenu } from './ExportMenu';
import { LanguageCombobox } from './LanguageCombobox';
import { LanguageDoubt } from './LanguageDoubt';
import { isRtlLanguage } from './language';
import { describeError } from './errors';
import { Alert } from '../components/ui/index';

/**
 * What a row can ask the page to do. One object, stable for the page's lifetime, keyed by
 * job id — so the row can be memoised and a progress tick on one file leaves the other
 * hundred rows untouched.
 */
export interface TranscriptionRowActions {
  select: (id: string, index: number, checked: boolean, shiftKey: boolean) => void;
  start: (id: string) => void;
  /** Runs one file again on a named quality, leaving the setting alone. */
  startWith: (id: string, quality: TranscriptionQualityMode) => void;
  cancel: (id: string) => void;
  pause: (id: string, paused: boolean) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  reveal: (id: string) => void;
  /** Names the spoken language by hand; `auto` hands the question back to the machine. */
  setLanguage: (id: string, language: string) => void;
  view: (id: string, trigger: HTMLElement | null) => void;
  copy: (id: string) => Promise<boolean>;
  export: (id: string, format: TranscriptExportFormat, content: TranscriptExportContent) => void;
}

/**
 * Below this many characters per audible second a fast transcript is called short. Normal
 * speech lands around twelve to fifteen; a music bed the turbo model gave up on lands near
 * zero for the part it missed, and a file that is half silence still clears the bar.
 */
const SHORT_TRANSCRIPT_CHARS_PER_SECOND = 5;

export const TranscriptionRow = memo(function TranscriptionRow({
  job,
  index,
  language,
  connected,
  selected,
  actions,
  t
}: {
  job: TranscriptionJob;
  index: number;
  language: Language;
  connected: boolean;
  selected: boolean;
  actions: TranscriptionRowActions;
  t: Translate;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (copyTimer.current && clearTimeout(copyTimer.current)), []);

  const done = job.status === 'completed';
  const running = job.status === 'processing';
  const active = running || job.status === 'queued';
  const settledNotDone = isSettled(TRANSCRIPTION_LIFECYCLE, job.status) && !done;

  const copy = async () => {
    if (await actions.copy(job.id)) {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    }
  };

  // A fast run that produced far less text than its recording could hold has probably
  // missed speech under music; the full model is the answer, and it is one click away.
  const suspiciouslyShort =
    done &&
    (job.characters ?? 0) > 0 &&
    job.quality === 'fast' &&
    (job.audibleSeconds ?? 0) > 10 &&
    (job.characters ?? 0) < SHORT_TRANSCRIPT_CHARS_PER_SECOND * (job.audibleSeconds ?? 0);

  // Finished, and nothing in it: whisper heard no speech. Said plainly, with the full
  // model one click away — a green "done" beside "0 characters" read as success.
  const silent = done && (job.characters ?? 0) === 0;

  const meta: string[] = [];
  if (job.durationSeconds) meta.push(formatDuration(job.durationSeconds));
  // The character count lives in the viewer's header; here it pushed the line onto two
  // rows on a laptop, with a lone separator starting the second.
  if (done && job.quality) {
    meta.push(
      job.quality === 'fast' ? t('transcriptionQualityFast') : t('transcriptionQualityAccurate')
    );
  }

  return (
    <article
      className={`job-row transcription-row ${selected ? 'is-selected' : ''} ${
        running ? 'is-processing' : ''
      }`.trim()}
      data-state={job.status}
      onClick={event => {
        if (job.status === 'analyzing') return;
        const target = event.target as HTMLElement;
        if (target.closest('button, a, input, label, [role="button"], [role="listbox"]')) return;
        actions.select(
          job.id,
          index,
          !selected,
          (event.nativeEvent as MouseEvent).shiftKey === true
        );
      }}
    >
      {/* First in the source so the keyboard reaches View, Copy and Export before the row's
          details; the grid puts the column back on the right. */}
      <div
        className="transcription-row-actions"
        aria-label={t('fileActions', { name: job.fileName })}
      >
        {done && (
          <>
            {/* What is done with a finished transcript, loudest first —
                loudest within the row, that is: the page's one primary action
                is the toolbar's (FR-022). */}
            <div className="transcription-row-actions-main">
              <Button
                color="neutral"
                variant="outline"
                onClick={event => actions.view(job.id, event.currentTarget)}
              >
                <Eye size={16} strokeWidth={1.75} aria-hidden="true" />
                {t('transcriptionView')}
              </Button>
              <Button
                color="neutral"
                variant="outline"
                disabled={silent}
                onClick={() => void copy()}
              >
                <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
                {copied ? t('transcriptionCopied') : t('transcriptionCopy')}
              </Button>
              <ExportMenu
                portal
                hasTimings={job.timed !== false}
                disabled={silent}
                onExport={(format, content) => actions.export(job.id, format, content)}
                t={t}
              />
            </div>
            {/* What is done with the file itself. Named rather than left as three bare
                icons: nobody should have to hover a bin to find out it is a bin, and the
                one destructive action is the one that most needs saying out loud. The
                labels are dropped by CSS alone on a narrow card, never by a prop. */}
            <div className="transcription-row-quiet-actions">
              <Button
                color="neutral"
                variant="ghost"
                disabled={!connected}
                title={t('transcriptionRepeat')}
                // The label goes with the width; the accessible name never does.
                aria-label={t('transcriptionRepeat')}
                // The same run again: its own quality, not whatever the panel says now.
                onClick={() =>
                  job.quality ? actions.startWith(job.id, job.quality) : actions.start(job.id)
                }
              >
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="action-label">{t('transcriptionRepeatShort')}</span>
              </Button>
              {job.sourceKind === 'local' && (
                <Button
                  color="neutral"
                  variant="ghost"
                  disabled={!connected}
                  title={t('showInFolder')}
                  aria-label={t('showInFolder')}
                  onClick={() => actions.reveal(job.id)}
                >
                  <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />
                  <span className="action-label">{t('transcriptionRevealShort')}</span>
                </Button>
              )}
              <Button
                color="neutral"
                variant="ghost"
                className="is-destructive"
                disabled={!connected}
                title={t('transcriptionRemove')}
                aria-label={t('transcriptionRemove')}
                onClick={() => actions.remove(job.id)}
              >
                <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                <span className="action-label">{t('transcriptionRemove')}</span>
              </Button>
            </div>
          </>
        )}
        {job.status === 'ready' && (
          <div className="transcription-row-actions-main">
            <Button
              color="neutral"
              variant="outline"
              disabled={!connected}
              onClick={() => actions.start(job.id)}
            >
              <Play size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionStart')}
            </Button>
            <Button
              color="neutral"
              variant="ghost"
              className="is-destructive"
              disabled={!connected}
              title={t('transcriptionRemove')}
              aria-label={t('transcriptionRemove')}
              onClick={() => actions.remove(job.id)}
            >
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="action-label">{t('transcriptionRemove')}</span>
            </Button>
          </div>
        )}
        {active && (
          <div className="transcription-row-actions-main">
            {running && (
              <Button
                color="neutral"
                variant="outline"
                disabled={!connected}
                onClick={() => actions.pause(job.id, !job.paused)}
              >
                {job.paused ? (
                  <Play size={16} strokeWidth={1.75} aria-hidden="true" />
                ) : (
                  <Pause size={16} strokeWidth={1.75} aria-hidden="true" />
                )}
                {t(job.paused ? 'jobResume' : 'jobPause')}
              </Button>
            )}
            <Button
              color="error"
              variant="soft"
              disabled={!connected}
              onClick={() => actions.cancel(job.id)}
            >
              <Ban size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionCancel')}
            </Button>
          </div>
        )}
        {settledNotDone && (
          <div className="transcription-row-actions-main">
            <Button
              color="neutral"
              variant="outline"
              disabled={!connected}
              onClick={() => actions.retry(job.id)}
            >
              <RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionRetry')}
            </Button>
            <Button
              color="neutral"
              variant="ghost"
              className="is-destructive"
              disabled={!connected}
              title={t('transcriptionRemove')}
              aria-label={t('transcriptionRemove')}
              onClick={() => actions.remove(job.id)}
            >
              <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="action-label">{t('transcriptionRemove')}</span>
            </Button>
          </div>
        )}
      </div>

      <div className="transcription-row-main">
        <div className="job-row-header">
          <Checkbox
            checked={selected}
            disabled={job.status === 'analyzing'}
            aria-label={t('fileSelection', { name: job.fileName })}
            label={<span className="sr-only">{t('fileSelection', { name: job.fileName })}</span>}
            onChange={(next, { shiftKey }) => actions.select(job.id, index, next, shiftKey)}
          />
          <div className="transcription-row-title">
            <h3 className="job-row-name" title={job.fileName}>
              {job.fileName}
            </h3>
            <div className="transcription-row-meta">
              <RowLanguage
                job={job}
                language={language}
                connected={connected}
                actions={actions}
                t={t}
              />
              {meta.map((entry, position) => (
                <span key={position}>{entry}</span>
              ))}
            </div>
          </div>
          {running && job.paused ? (
            <span className="status-badge status-processing is-paused">
              <Pause size={11} strokeWidth={2.2} aria-hidden="true" />
              {t('jobPaused')}
            </span>
          ) : (
            <StatusBadge status={job.status} t={t} context="transcription" />
          )}
        </div>

        {done && job.preview && (
          <button
            type="button"
            className="transcription-row-snippet"
            dir={isRtlLanguage(job.detectedLanguage ?? job.requestedLanguage) ? 'rtl' : 'ltr'}
            title={t('transcriptionView')}
            aria-label={t('transcriptionOpenTranscript', { file: job.fileName })}
            onClick={event => actions.view(job.id, event.currentTarget)}
          >
            <span>{job.preview}</span>
          </button>
        )}

        {active && (
          <div className="transcription-row-progress">
            <Progress
              value={job.status === 'queued' ? 0 : (job.progress ?? undefined)}
              color={running && connected && !job.paused ? 'primary' : 'neutral'}
              label={job.fileName}
            />
            <span className="transcription-row-progress-value">
              {job.status === 'queued'
                ? t('statusQueued')
                : job.paused
                  ? t('jobPaused')
                  : job.progress !== null
                    ? `${job.phase === 'extract' ? t('transcriptionPhaseExtract') : job.phase === 'recover' ? t('transcriptionPhaseRecover') : job.phase === 'save' ? t('transcriptionPhaseSave') : ''}${job.phase && job.phase !== 'transcribe' ? ' · ' : ''}${Math.round(job.progress)}%`
                    : t('transcriptionProcessing')}
            </span>
          </div>
        )}

        {silent && (
          <div className="transcription-row-hint" role="note">
            <span>{t('transcriptionNoSpeech')}</span>
            {job.quality === 'fast' && (
              <Button
                color="neutral"
                variant="ghost"
                disabled={!connected}
                onClick={() => actions.startWith(job.id, 'accurate')}
              >
                <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
                {t('transcriptionRetryAccurate')}
              </Button>
            )}
          </div>
        )}

        {suspiciouslyShort && (
          <div className="transcription-row-hint" role="note">
            <span>{t('transcriptionShortHint')}</span>
            <Button
              color="neutral"
              variant="ghost"
              disabled={!connected}
              onClick={() => actions.startWith(job.id, 'accurate')}
            >
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
              {t('transcriptionRetryAccurate')}
            </Button>
          </div>
        )}

        {settledNotDone && job.error && (
          <Alert className="transcription-row-error" color="error" variant="soft" live="alert">
            {describeError(job.error, t)}
          </Alert>
        )}
      </div>
    </article>
  );
});

/**
 * What language this file is in — and the one control that can fix it.
 *
 * The guess arrives in three stages: a few seconds after the file is added the probe names
 * a language, the run replaces it with its own if it reached one first, and a person can
 * overrule both. Whisper's detector is genuinely unsure inside a few language families —
 * Uzbek comes back as Azerbaijani, Turkish or Pashto — so a guess it is not confident
 * about says so, and the picker opens with those neighbours already at the top.
 */
function RowLanguage({
  job,
  language,
  connected,
  actions,
  t
}: {
  job: TranscriptionJob;
  language: Language;
  connected: boolean;
  actions: TranscriptionRowActions;
  t: Translate;
}) {
  const detected = job.detectedLanguage;
  const neighbours = useMemo(() => confusableLanguages(detected), [detected]);
  // Only a machine's guess is ever called uncertain: a low posterior, or a language whose
  // whole family the detector mixes up. A person's own answer is never second-guessed.
  const uncertain =
    detected !== null &&
    job.languageSource !== 'manual' &&
    ((job.languageConfidence !== undefined && job.languageConfidence < 0.85) ||
      neighbours.length > 0);

  if (job.languageProbing && !detected) {
    return (
      <span className="transcription-row-language is-probing">
        <span className="soty-spinner" aria-hidden="true" />
        {t('transcriptionLanguageProbing')}
      </span>
    );
  }

  const editable = connected && job.status !== 'processing' && job.status !== 'queued';
  const picker = (
    <LanguageCombobox
      portal
      compact
      value={detected ?? 'auto'}
      codes={TRANSCRIPTION_LANGUAGE_CODES}
      pinned={neighbours}
      language={language}
      label={t('transcriptionSpokenLanguageOf', { file: job.fileName })}
      autoLabel={detected ? t('transcriptionLanguageAuto') : t('transcriptionLanguageUnknown')}
      emptyLabel={t('transcriptionLanguageNoMatch')}
      // Mid-run the answer belongs to the run: changing it here would label a file with a
      // language nothing listened for.
      disabled={!editable}
      onChange={code => actions.setLanguage(job.id, code)}
    />
  );
  return (
    <span
      className={`transcription-row-language${uncertain ? ' is-uncertain' : ''}`}
      title={job.languageSource === 'manual' ? t('transcriptionLanguageManual') : undefined}
    >
      {/* Doubt gets a shape, not just a colour: a question mark where the globe would be,
          and it wraps the picker so the mark before the name and the per cent after it both
          open what the detector actually heard. */}
      {uncertain ? (
        <LanguageDoubt
          job={job}
          language={language}
          disabled={!editable}
          onChoose={code => actions.setLanguage(job.id, code)}
          t={t}
        >
          {picker}
        </LanguageDoubt>
      ) : (
        <>
          <Globe size={14} strokeWidth={1.75} aria-hidden="true" />
          {picker}
        </>
      )}
    </span>
  );
}
